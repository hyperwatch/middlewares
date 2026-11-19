const createDebug = require('debug');

const debug = createDebug('hyperwatch:service-limiter');

const DEFAULT_MESSAGE = 'Service Limited. Try again later.';

/**
 * Turn identified robots away while a server warms up.
 *
 * The service level goes from `initialLevel` (0 by default) to 100, raised
 * with `increaseServiceLevel`. Below 50, every identified request is limited
 * except the essential identities; below 100, the non-essential identities
 * still are. Requests without an identity are never limited.
 *
 * @param {object} [options]
 * @param {string[]} [options.essentialIdentities] Served from level 0.
 * @param {string[]} [options.nonEssentialIdentities] Served only at level 100.
 * @param {number} [options.initialLevel] 0 by default.
 * @param {(req) => string|undefined|Promise<string|undefined>} [options.getIdentity]
 *   Default: `req.identity`, else Hyperwatch's `req.hyperwatch.getIdentity()`.
 * @param {(req, res) => void} [options.onLimited] Default: a 503 with `message`.
 * @param {string} [options.message] Body of the default 503.
 */
function serviceLimiter({
  essentialIdentities = [],
  nonEssentialIdentities = [],
  initialLevel = 0,
  getIdentity = defaultGetIdentity,
  onLimited,
  message = DEFAULT_MESSAGE,
} = {}) {
  const essential = new Set(essentialIdentities);
  const nonEssential = new Set(nonEssentialIdentities);

  let serviceLevel = initialLevel;

  const limited =
    onLimited ||
    ((req, res) => {
      res.statusCode = 503;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.end(message);
    });

  const isLimited = (identity) => {
    if (!identity) {
      return false;
    }
    if (serviceLevel < 100 && nonEssential.has(identity)) {
      return true;
    }
    return serviceLevel < 50 && !essential.has(identity);
  };

  async function serviceLimiterMiddleware(req, res, next) {
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
      limited(req, res);
      return;
    }
    next();
  }

  serviceLimiterMiddleware.increaseServiceLevel = (newLevel) => {
    if (newLevel > serviceLevel) {
      debug(`Increasing service level to ${newLevel}`);
      serviceLevel = newLevel;
    }
  };

  serviceLimiterMiddleware.getServiceLevel = () => serviceLevel;

  return serviceLimiterMiddleware;
}

async function defaultGetIdentity(req) {
  if (!req.identity && req.hyperwatch?.getIdentity) {
    req.identity = await req.hyperwatch.getIdentity();
  }
  return req.identity;
}

module.exports = serviceLimiter;
