const debug = require('debug')('hyperwatch:service-limiter');

/**
 * @typedef {import('./types').Request} Request
 * @typedef {import('./types').Response} Response
 * @typedef {import('./types').Next} Next
 */

/**
 * @typedef {object} ServiceLimiterOptions
 * @property {Iterable<string>} [essentialIdentities] Served from level 0.
 * @property {Iterable<string>} [nonEssentialIdentities] Served only at level 100.
 * @property {number} [initialLevel] Default: 0.
 * @property {(req: Request) => string | undefined | Promise<string | undefined>} [getIdentity]
 *   Default: `req.identity`, else Hyperwatch's `req.hyperwatch.getIdentity()`.
 * @property {(req: Request, res: Response) => void} [onLimited] Default: a
 *   503 with `message`.
 * @property {string} [message] Body of the default 503.
 */

/**
 * @typedef {object} ServiceLevel
 * @property {(newLevel: number) => void} increaseServiceLevel Raises the
 *   level, never lowers it.
 * @property {() => number} getServiceLevel
 */

/**
 * @typedef {((req: Request, res: Response, next: Next) => Promise<void>) & ServiceLevel} ServiceLimiter
 */

const DEFAULT_MESSAGE = 'Service Limited. Try again later.';

/** @param {Request} req */
async function defaultGetIdentity(req) {
  if (!req.identity && req.hyperwatch?.getIdentity) {
    req.identity = await req.hyperwatch.getIdentity();
  }
  return req.identity;
}

/**
 * Turns identified robots away while a server warms up.
 *
 * The service level goes from `initialLevel` to 100, raised with
 * `increaseServiceLevel`. Below 50, every identified request is limited
 * except the essential identities; below 100, the non-essential identities
 * still are. Requests without an identity are never limited.
 *
 * @param {ServiceLimiterOptions} [options]
 * @returns {ServiceLimiter}
 */
function serviceLimiter({
  essentialIdentities = [],
  nonEssentialIdentities = [],
  initialLevel = 0,
  getIdentity = defaultGetIdentity,
  message = DEFAULT_MESSAGE,
  onLimited = (req, res) => {
    res.statusCode = 503;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end(message);
  },
} = {}) {
  const essential = new Set(essentialIdentities);
  const nonEssential = new Set(nonEssentialIdentities);

  let serviceLevel = initialLevel;

  /** @param {string | undefined} identity */
  const isLimited = (identity) => {
    if (!identity) {
      return false;
    }
    if (serviceLevel < 100 && nonEssential.has(identity)) {
      return true;
    }
    return serviceLevel < 50 && !essential.has(identity);
  };

  /**
   * @param {Request} req
   * @param {Response} res
   * @param {Next} next
   */
  const middleware = async (req, res, next) => {
    if (serviceLevel >= 100) {
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
    if (isLimited(identity)) {
      debug(`Service limited for '${identity}' at level ${serviceLevel}`);
      onLimited(req, res);
      return;
    }
    next();
  };

  return Object.assign(middleware, {
    /** @param {number} newLevel */
    increaseServiceLevel(newLevel) {
      if (newLevel > serviceLevel) {
        debug(`Increasing service level to ${newLevel}`);
        serviceLevel = newLevel;
      }
    },
    getServiceLevel: () => serviceLevel,
  });
}

module.exports = serviceLimiter;
