const debug = require('debug')('hyperwatch:service-limiter');

/**
 * @typedef {import('./types').Request} Request
 * @typedef {import('./types').Response} Response
 * @typedef {import('./types').Next} Next
 */

/**
 * @typedef {object} ManualLevel A level set from outside, shared by every
 *   process using the same store
 * @property {number} level
 * @property {number} [until] Timestamp (ms) after which it no longer applies
 */

/**
 * @typedef {object} LevelStore Where the manual level is kept: in memory by
 *   default, or shared (Redis…) between processes
 * @property {() => Promise<ManualLevel | null | undefined>} get
 * @property {(value: ManualLevel | null) => Promise<void>} set
 */

/**
 * @typedef {object} Limited What a limited request is told
 * @property {number} level The service level
 * @property {boolean} warmingUp Whether the server is warming up and a
 *   warm-up step will serve this request; false when it's limited by the
 *   manual level
 * @property {number} [retryAfter] Seconds: until the warm-up step serving
 *   this request, else until the manual level ends (`until`), else the
 *   `retryAfter` option
 */

/**
 * @typedef {object} WarmUpStep
 * @property {number} after Seconds after `warmUp()` was called
 * @property {number} level The service level from then on
 */

/**
 * @typedef {object} ServiceLimiterOptions
 * @property {Iterable<string>} [essentialIdentities] Served from level 0.
 * @property {Iterable<string>} [nonEssentialIdentities] Served only at level 100.
 * @property {number} [initialLevel] Warm-up level at creation. Default: 0.
 * @property {(req: Request) => string | undefined | Promise<string | undefined>} [getIdentity]
 *   Default: `req.identity`, else Hyperwatch's `req.hyperwatch.getIdentity()`.
 * @property {LevelStore} [store] Where the manual level is kept. Default: in
 *   memory, for this process only.
 * @property {number} [refreshInterval] Seconds between two reads of the
 *   store. Default: 5.
 * @property {number} [retryAfter] Seconds, for `Retry-After` when a manual
 *   level without end limits the request. Default: none, no header.
 * @property {(req: Request, res: Response, limited: Limited) => void} [onLimited]
 *   Default: a 503 with `message` and `Retry-After` when known.
 * @property {string} [message] Body of the default 503.
 */

/**
 * @typedef {object} ServiceLevel
 * @property {(steps: WarmUpStep[]) => void} warmUp Raises this process's
 *   warm-up level step by step, from now.
 * @property {(newLevel: number) => void} increaseServiceLevel Raises this
 *   process's warm-up level now, never lowers it.
 * @property {(level: number, options?: { until?: Date | number }) => Promise<void>} setServiceLevel
 *   Sets the manual level, in the store: every process sharing it applies it
 *   at its next refresh.
 * @property {() => Promise<void>} clearServiceLevel Removes the manual level.
 * @property {() => number} getServiceLevel The level applied: the lower of
 *   the warm-up and manual levels.
 */

/**
 * @typedef {((req: Request, res: Response, next: Next) => Promise<void>) & ServiceLevel} ServiceLimiter
 */

const DEFAULT_MESSAGE = 'Service Limited. Try again later.';

// Below these levels, identified requests are limited
const NON_ESSENTIAL_LEVEL = 100;
const IDENTIFIED_LEVEL = 50;

// Milliseconds requests wait at most for the first read of the store
const FIRST_READ_WAIT = 1000;

/** @param {Request} req */
async function defaultGetIdentity(req) {
  if (!req.identity && req.hyperwatch?.getIdentity) {
    req.identity = await req.hyperwatch.getIdentity();
  }
  return req.identity;
}

/** @returns {LevelStore} */
function memoryStore() {
  /** @type {ManualLevel | null} */
  let value = null;
  return {
    get: async () => value,
    set: async (newValue) => {
      value = newValue;
    },
  };
}

/** @param {number} ms */
const seconds = (ms) => Math.max(0, Math.ceil(ms / 1000));

/**
 * Turns identified robots away while a server warms up, or while a level
 * set from outside says so.
 *
 * Below level 50, every identified request is limited except the essential
 * identities; below 100, the non-essential identities still are. Requests
 * without an identity are never limited. The level applied is the lower of
 * this process's warm-up level (`warmUp`, `increaseServiceLevel`) and the
 * manual level (`setServiceLevel`), shared through `store`.
 *
 * @param {ServiceLimiterOptions} [options]
 * @returns {ServiceLimiter}
 */
function serviceLimiter({
  essentialIdentities = [],
  nonEssentialIdentities = [],
  initialLevel = 0,
  getIdentity = defaultGetIdentity,
  store = memoryStore(),
  refreshInterval = 5,
  retryAfter,
  message = DEFAULT_MESSAGE,
  onLimited = (req, res, limited) => {
    res.statusCode = 503;
    if (limited.retryAfter !== undefined) {
      res.setHeader('Retry-After', String(limited.retryAfter));
    }
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end(message);
  },
} = {}) {
  const essential = new Set(essentialIdentities);
  const nonEssential = new Set(nonEssentialIdentities);

  let warmUpLevel = initialLevel;

  /** @type {{ at: number, level: number }[]} Upcoming warm-up steps */
  let schedule = [];
  /** @type {NodeJS.Timeout[]} */
  let timers = [];

  /** @type {ManualLevel | null} As last read from the store */
  let manual = null;

  // Counts the writes and the reads: the result of a read is dropped when a
  // write or a newer read started after it
  let writes = 0;
  let reads = 0;
  /** @type {Promise<void> | null} The read in progress, one at a time */
  let reading = null;

  const refresh = () => {
    if (reading) {
      return reading;
    }
    const read = ++reads;
    const before = writes;
    const result = store.get().then(
      (value) => {
        if (read === reads && writes === before) {
          manual = value ?? null;
        }
      },
      (err) => {
        debug(`Reading the manual level failed, keeping the last one: ${err}`);
      }
    );
    // A read that hangs doesn't block the next ones
    const giveUp = new Promise((resolve) => {
      setTimeout(resolve, refreshInterval * 1000).unref();
    });
    reading = Promise.race([result, giveUp]).then(() => {
      reading = null;
    });
    return reading;
  };
  // Requests wait for the first read, a manual level may already be set,
  // but not more than FIRST_READ_WAIT if the store is slow
  /** @type {Promise<void> | null} */
  let firstRead = Promise.race([
    refresh(),
    new Promise((resolve) => setTimeout(resolve, FIRST_READ_WAIT).unref()),
  ]).then(() => {
    firstRead = null;
  });
  setInterval(refresh, refreshInterval * 1000).unref();

  /** The manual level, unless it ended */
  const currentManual = () =>
    manual && (manual.until === undefined || manual.until > Date.now())
      ? manual
      : null;

  const getServiceLevel = () =>
    Math.min(warmUpLevel, currentManual()?.level ?? Infinity);

  /**
   * The level from which a request is served. Requests without an identity
   * and essential identities are served at any level, even a negative one.
   *
   * @param {string | undefined} identity
   */
  const levelServing = (identity) => {
    if (!identity || essential.has(identity)) {
      return -Infinity;
    }
    return nonEssential.has(identity) ? NON_ESSENTIAL_LEVEL : IDENTIFIED_LEVEL;
  };

  /**
   * @param {number} needed The level serving the request
   * @returns {Limited}
   */
  const limitedFor = (needed) => {
    const level = getServiceLevel();
    const now = Date.now();
    const limit = currentManual();
    if (limit && limit.level < needed) {
      return {
        level,
        warmingUp: false,
        retryAfter:
          limit.until === undefined ? retryAfter : seconds(limit.until - now),
      };
    }
    const step = schedule.find(({ at, level }) => at > now && level >= needed);
    return step
      ? { level, warmingUp: true, retryAfter: seconds(step.at - now) }
      : { level, warmingUp: false, retryAfter };
  };

  /** @param {number} newLevel */
  const increaseServiceLevel = (newLevel) => {
    if (newLevel > warmUpLevel) {
      debug(`Increasing warm-up level to ${newLevel}`);
      warmUpLevel = newLevel;
    }
  };

  /**
   * @param {Request} req
   * @param {Response} res
   * @param {Next} next
   */
  const middleware = async (req, res, next) => {
    if (firstRead) {
      await firstRead;
    }
    if (getServiceLevel() >= NON_ESSENTIAL_LEVEL) {
      next();
      return;
    }
    let identity;
    try {
      identity = await getIdentity(req);
    } catch (err) {
      next(err);
      return;
    }
    // The level may have changed while the identity was resolved
    const level = getServiceLevel();
    const needed = levelServing(identity);
    if (level < needed) {
      debug(`Service limited for '${identity}' at level ${level}`);
      onLimited(req, res, limitedFor(needed));
      return;
    }
    next();
  };

  return Object.assign(middleware, {
    /** @param {WarmUpStep[]} steps */
    warmUp(steps) {
      // A new schedule replaces the previous one
      for (const timer of timers) {
        clearTimeout(timer);
      }
      const start = Date.now();
      schedule = steps
        .map(({ after, level }) => ({ at: start + after * 1000, level }))
        .sort((a, b) => a.at - b.at);
      timers = schedule.map(({ at, level }) =>
        setTimeout(() => increaseServiceLevel(level), at - start).unref()
      );
    },
    increaseServiceLevel,
    /**
     * @param {number} level
     * @param {{ until?: Date | number }} [options]
     */
    async setServiceLevel(level, { until } = {}) {
      /** @type {ManualLevel} */
      const value = { level };
      if (until !== undefined) {
        value.until = new Date(until).getTime();
      }
      debug(`Setting the manual level to ${level}`);
      await store.set(value);
      writes++;
      manual = value;
    },
    async clearServiceLevel() {
      debug('Clearing the manual level');
      await store.set(null);
      writes++;
      manual = null;
    },
    getServiceLevel,
  });
}

module.exports = serviceLimiter;
