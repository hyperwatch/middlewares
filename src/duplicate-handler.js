const createDebug = require('debug');

const debug = createDebug('hyperwatch:duplicate-handler');

const HEADER_METHODS = new Set(['setHeader', 'removeHeader', 'writeHead']);
const PROXIED_METHODS = [...HEADER_METHODS, 'write', 'end'];

/**
 * Serve identical concurrent requests with a single response.
 *
 * While a request is in progress, any other request with the same method and
 * URL waits for it and receives a copy of its response instead of being
 * processed again.
 *
 * @param {object} [options]
 * @param {(req) => boolean} [options.skip] Return true to process a request normally
 *   (e.g. authenticated requests, whose responses must not be shared).
 * @param {(req) => string} [options.key] Requests with the same key are duplicates.
 *   Default: method and URL.
 * @param {number|string} [options.timeout] Seconds after which a pending request
 *   is forgotten (30 by default).
 */
function duplicateHandler({ skip, key, timeout } = {}) {
  const timeoutMs = (Number(timeout) || 30) * 1000;
  const getKey = key || ((req) => `${req.method} ${req.url}`);

  const requests = new Map();

  // Garbage collection (not necessary under normal operation)
  const gc = () => {
    if (requests.size > 0) {
      debug(`${requests.size} current registered requests`);
    }
    const expired = Date.now() - timeoutMs;
    for (const [id, entry] of requests) {
      if (entry.registeredAt < expired) {
        requests.delete(id);
      }
    }
  };

  setInterval(gc, 1000).unref();

  // Mirror everything written on the origin response to the duplicates.
  // Done lazily, when the first duplicate arrives.
  const mirror = (entry) => {
    const originRes = entry.origin.res;
    for (const method of PROXIED_METHODS) {
      const originMethod = originRes[method];
      originRes[method] = function (...args) {
        for (const duplicate of entry.duplicates) {
          if (method === 'write' || method === 'end') {
            // Not set through a method, so not mirrored on its own
            duplicate.res.statusCode = originRes.statusCode;
            if (originRes.statusMessage) {
              duplicate.res.statusMessage = originRes.statusMessage;
            }
          }
          if (!(duplicate.res.headersSent && HEADER_METHODS.has(method))) {
            duplicate.res[method](...args);
          }
        }
        return originMethod.apply(originRes, args);
      };
    }
  };

  return function handleDuplicate(req, res, next) {
    if (skip && skip(req)) {
      next();
      return;
    }

    const id = getKey(req);
    const entry = requests.get(id);

    // Once the origin response started, it's too late to join it
    if (entry && !entry.origin.res.headersSent) {
      debug(`Duplicate request detected '${id}'`);

      if (!entry.duplicates) {
        entry.duplicates = [];
        mirror(entry);
      }

      // Headers already set on the origin response
      for (const [name, value] of Object.entries(
        entry.origin.res.getHeaders()
      )) {
        res.setHeader(name, value);
      }

      // Wait for the origin response
      entry.duplicates.push({ req, res });
      return;
    }

    if (entry) {
      next();
      return;
    }

    // Origin request
    requests.set(id, {
      registeredAt: Date.now(),
      origin: { req, res },
    });

    const release = () => {
      if (requests.get(id)?.origin.req === req) {
        requests.delete(id);
      }
    };
    res.on('finish', release);
    res.on('close', release);

    next();
  };
}

module.exports = duplicateHandler;
