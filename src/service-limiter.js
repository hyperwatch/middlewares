const { inspect } = require('node:util');

const debug = require('debug')('hyperwatch:service-limiter');

/**
 * @typedef {import('./types').Request} Request
 * @typedef {import('./types').Response} Response
 * @typedef {import('./types').Next} Next
 */

/**
 * @typedef {object} Robot Who a request is from, as far as it is verified
 * @property {string} [identity]
 * @property {string} [category] The kind of robot (`search-engine`, `seo`…)
 */

/**
 * @typedef {Robot & { req: Request }} ClassifyContext
 */

/**
 * @typedef {object} Limited What a limited request is told
 * @property {string} [identity]
 * @property {string} [category]
 * @property {string} priority The request's priority
 * @property {string} serving The lowest priority served now
 * @property {number} [retryAfter] Seconds until the warm-up step serving this
 *   priority; absent when no step does
 */

/**
 * @typedef {'identify' | 'classify' | 'priority' | 'timeout'} FailureKind
 */

/**
 * @typedef {object} WarmUpStep
 * @property {number} after Seconds after `warmUp()` was called
 * @property {string} serve The lowest priority served from then on
 */

/**
 * @typedef {object} ServiceLimiterOptions
 * @property {string[]} [priorities] Ordered names, most important first.
 *   Default: `high`, `normal`, `low`.
 * @property {(context: ClassifyContext) => string | null | undefined | Promise<string | null | undefined>} [classify]
 *   The priority of a request; `undefined` or `null`: never limited.
 *   Default: `defaultClassify`.
 * @property {(req: Request) => boolean} [skip] Synchronous, runs first: true
 *   passes the request without identifying it.
 * @property {(req: Request) => Robot | null | undefined | Promise<Robot | null | undefined>} [identify]
 *   Default: from Hyperwatch's Express input, else `req.identity`.
 * @property {number} [timeout] Seconds `identify` and `classify` get together;
 *   past it the request is served. Default: 1.
 * @property {(req: Request, res: Response, limited: Limited) => void} [respond]
 *   The response to a limited request. Default: a 503 with `message`, and
 *   `Retry-After` when known.
 * @property {string} [message] Body of the default response.
 * @property {(req: Request, limited: Limited) => void} [onLimited] Told of
 *   each limited request (logs, counts). Does not replace the response.
 * @property {(error: Error, context: { kind: FailureKind, req: Request }) => void} [onError]
 *   Told when a request is served because the limiter failed. Default: a
 *   warning, once per kind.
 */

/**
 * @typedef {object} ServiceLimiterMethods
 * @property {(steps: WarmUpStep[]) => void} warmUp Serves the first priority
 *   only from now, then more at each step. Once.
 * @property {() => string} serving The lowest priority served now.
 */

/**
 * @typedef {((req: Request, res: Response, next: Next) => Promise<void>) & ServiceLimiterMethods} ServiceLimiter
 */

const DEFAULT_PRIORITIES = ['high', 'normal', 'low'];

const DEFAULT_MESSAGE = 'Service Limited. Try again later.';

/**
 * The default policy. To change it, wrap it or copy it.
 *
 * @param {Robot} robot
 * @returns {string | undefined}
 */
function defaultClassify({ identity, category = '' }) {
  // People, and clients that aren't verified: never limited
  if (!identity) {
    return undefined;
  }
  // Someone is waiting: link previews, uptime checks
  if (['social-preview', 'monitoring'].includes(category)) {
    return 'high';
  }
  // Usually able to wait
  if (
    ['seo', 'marketing', 'ai-training', 'archive', 'research'].includes(
      category
    )
  ) {
    return 'low';
  }
  // Everything else that is identified: other robots, and what we know
  // nothing about
  return 'normal';
}

/**
 * @param {Request} req
 * @returns {Promise<Robot>}
 */
async function defaultIdentify(req) {
  // Hyperwatch first: it is the one that knows the category
  if (req.hyperwatch?.getAugmentedLog) {
    const log = await req.hyperwatch.getAugmentedLog({ fast: true });
    return {
      identity: /** @type {string | undefined} */ (log.get('identity')),
      category: /** @type {string | undefined} */ (log.get('category')),
    };
  }
  return { identity: req.identity };
}

/**
 * What was thrown, as an Error: anything can be thrown or rejected with.
 *
 * @param {unknown} thrown
 * @returns {Error}
 */
const toError = (thrown) =>
  thrown instanceof Error ? thrown : new Error(inspect(thrown));

/**
 * @param {unknown} priorities
 * @returns {string[]} A copy
 */
function checkPriorities(priorities) {
  if (
    !Array.isArray(priorities) ||
    priorities.length === 0 ||
    priorities.some((name) => typeof name !== 'string' || name === '') ||
    new Set(priorities).size !== priorities.length
  ) {
    throw new TypeError(
      'priorities must be a non-empty array of unique, non-empty names'
    );
  }
  return [...priorities];
}

/**
 * Turns verified robots away while a server warms up, the least important
 * the longest.
 *
 * `classify` gives each request a priority, a name of `priorities`. The
 * limiter serves down to one of them (`serving()`): everything until
 * `warmUp()` is called, then the first priority only, then more at each
 * step. A request without a priority is never limited.
 *
 * @param {ServiceLimiterOptions} [options]
 * @returns {ServiceLimiter}
 */
function serviceLimiter({
  priorities: givenPriorities,
  classify,
  skip,
  identify = defaultIdentify,
  timeout = 1,
  message = DEFAULT_MESSAGE,
  respond = (req, res, limited) => {
    res.statusCode = 503;
    if (limited.retryAfter !== undefined) {
      res.setHeader('Retry-After', String(limited.retryAfter));
    }
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end(message);
  },
  onLimited,
  onError,
} = {}) {
  const priorities = checkPriorities(givenPriorities ?? DEFAULT_PRIORITIES);
  const last = priorities.length - 1;

  if (!classify) {
    // The default policy answers with the default names
    const missing = DEFAULT_PRIORITIES.filter(
      (name) => !priorities.includes(name)
    );
    if (missing.length > 0) {
      throw new TypeError(
        `priorities without ${missing.join(', ')} need their own classify`
      );
    }
    classify = defaultClassify;
  }
  const classifyRequest = classify;

  if (!(Number.isFinite(timeout) && timeout > 0)) {
    throw new RangeError(`timeout must be a positive number: ${timeout}`);
  }
  const timeoutMs = timeout * 1000;

  // Warm-up: when it started (monotonic clock) and its steps, in milliseconds
  // since then. The state is computed from the time elapsed, not set by
  // timers: a step counts from the instant it is due.
  /** @type {number | null} */
  let startedAt = null;
  /** @type {{ after: number, index: number }[]} */
  let schedule = [];

  /**
   * The position in `priorities` of the lowest priority served.
   *
   * @param {number} now
   */
  const servingAt = (now) => {
    if (startedAt === null) {
      return last;
    }
    let index = 0;
    for (const step of schedule) {
      if (now - startedAt < step.after) {
        break;
      }
      index = step.index;
    }
    return index;
  };

  /** @type {Set<FailureKind>} Kinds the default `onError` warned about */
  const warned = new Set();

  /**
   * @param {Error} error
   * @param {{ kind: FailureKind, req: Request }} context
   */
  const report = (error, context) => {
    debug(`Request served, ${context.kind} failed: ${error.message}`);
    if (onError) {
      onError(error, context);
    } else if (!warned.has(context.kind)) {
      warned.add(context.kind);
      process.emitWarning(
        `Service limiter: requests are served because ${context.kind} failed (${error.message}). Reported once.`,
        { code: `HYPERWATCH_SERVICE_LIMITER_${context.kind.toUpperCase()}` }
      );
    }
  };

  /**
   * Who the request is from and what it is worth. Never rejects: a failure
   * is returned.
   *
   * @typedef {Robot & { priority?: string, index?: number }} Classified
   * @typedef {{ kind: FailureKind, error: Error }} Failure
   * @param {Request} req
   * @returns {Promise<Classified | Failure>}
   */
  const prioritize = async (req) => {
    /** @type {Robot | null | undefined} */
    let robot;
    try {
      robot = await identify(req);
      if (robot !== null && robot !== undefined && typeof robot !== 'object') {
        throw new TypeError(`identify returned ${typeof robot}, not an object`);
      }
    } catch (error) {
      return { kind: 'identify', error: toError(error) };
    }
    const { identity, category } = robot ?? {};
    // Everything may be served by now
    if (servingAt(performance.now()) === last) {
      return { identity, category };
    }
    let priority;
    try {
      priority = await classifyRequest({ identity, category, req });
    } catch (error) {
      return { kind: 'classify', error: toError(error) };
    }
    if (priority === undefined || priority === null) {
      return { identity, category };
    }
    const index = priorities.indexOf(priority);
    if (index === -1) {
      return {
        kind: 'priority',
        error: new TypeError(
          `classify returned ${inspect(priority)}, not one of ${priorities.join(', ')}`
        ),
      };
    }
    return { identity, category, priority, index };
  };

  /**
   * `prioritize`, given up after `timeout`.
   *
   * @param {Request} req
   * @returns {Promise<Classified | Failure>}
   */
  const prioritizeInTime = (req) => {
    /** @type {NodeJS.Timeout | undefined} */
    let timer;
    /** @type {Promise<Failure>} */
    const expired = new Promise((resolve) => {
      timer = setTimeout(() => {
        resolve({
          kind: 'timeout',
          error: new Error(`no answer within ${timeout} s`),
        });
      }, timeoutMs).unref();
    });
    return Promise.race([prioritize(req), expired])
      .catch(
        // Not expected: prioritize returns its failures. Served all the same.
        (error) =>
          /** @type {Failure} */ ({
            kind: 'classify',
            error: toError(error),
          })
      )
      .finally(() => {
        clearTimeout(timer);
      });
  };

  /**
   * @param {number} index The request's priority
   * @param {number} now
   */
  const retryAfterFor = (index, now) => {
    const step = schedule.find((candidate) => candidate.index >= index);
    if (!step || startedAt === null) {
      return undefined;
    }
    return Math.max(1, Math.ceil((step.after - (now - startedAt)) / 1000));
  };

  /**
   * @param {Request} req
   * @param {Response} res
   * @param {Next} next
   */
  const middleware = async (req, res, next) => {
    let skipped;
    try {
      skipped = skip ? skip(req) : false;
    } catch (error) {
      next(error);
      return;
    }
    if (skipped || servingAt(performance.now()) === last) {
      next();
      return;
    }

    const result = await prioritizeInTime(req);

    if ('kind' in result) {
      try {
        report(result.error, { kind: result.kind, req });
      } catch (error) {
        next(error);
        return;
      }
      next();
      return;
    }

    // One reading of the clock for the decision and what the request is told
    const now = performance.now();
    const serving = servingAt(now);
    if (result.index === undefined || result.index <= serving) {
      next();
      return;
    }

    /** @type {Limited} */
    const limited = {
      identity: result.identity,
      category: result.category,
      priority: priorities[result.index],
      serving: priorities[serving],
      retryAfter: retryAfterFor(result.index, now),
    };
    debug(
      `Service limited for '${limited.identity}' (${limited.priority}), serving ${limited.serving}`
    );
    try {
      if (onLimited) {
        onLimited(req, limited);
      }
      respond(req, res, limited);
    } catch (error) {
      next(error);
    }
  };

  return Object.assign(middleware, {
    /** @param {WarmUpStep[]} steps */
    warmUp(steps) {
      if (startedAt !== null) {
        throw new Error('warmUp() was already called');
      }
      if (!Array.isArray(steps)) {
        throw new TypeError('warmUp() takes an array of steps');
      }
      // Everything is checked before anything changes
      let previousAfter = -1;
      let previousIndex = 0;
      const checked = steps.map((step) => {
        const { after, serve } = step ?? {};
        if (!(Number.isFinite(after) && after >= 0 && after > previousAfter)) {
          throw new RangeError(
            `Warm-up delays must be positive numbers of seconds, each larger than the one before: ${after}`
          );
        }
        const index = priorities.indexOf(serve);
        if (index === -1) {
          throw new RangeError(
            `Warm-up step serves an unknown priority: ${serve}`
          );
        }
        if (index <= previousIndex) {
          throw new RangeError(
            `Each warm-up step must serve more than the one before: ${serve}`
          );
        }
        previousAfter = after;
        previousIndex = index;
        return { after: after * 1000, index };
      });
      schedule = checked;
      startedAt = performance.now();
      debug(`Warming up: serving ${priorities[0]} only`);
    },
    serving: () => priorities[servingAt(performance.now())],
  });
}

serviceLimiter.defaultClassify = defaultClassify;

module.exports = serviceLimiter;
