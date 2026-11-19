const debug = require('debug')('hyperwatch:duplicate-handler');

/**
 * @typedef {import('./types').Request} Request
 * @typedef {import('./types').Response} Response
 * @typedef {import('./types').Middleware} Middleware
 */

/**
 * @typedef {object} DuplicateHandlerOptions
 * @property {(req: Request) => boolean} [skip] Return true to process a request
 *   normally (e.g. authenticated requests, whose responses must not be shared).
 * @property {(req: Request) => string} [key] Requests with the same key are
 *   duplicates. Default: method and URL.
 * @property {number | string} [timeout] Seconds after which a pending request
 *   is forgotten. Default: 30.
 */

/**
 * @typedef {object} Duplicate
 * @property {Response} res
 * @property {import('./types').Next} next
 */

/**
 * @typedef {object} Entry
 * @property {number} registeredAt
 * @property {{ req: Request, res: Response }} origin
 * @property {Duplicate[]} [duplicates] Set when the first duplicate arrives
 * @property {boolean} [private] The origin response sets a cookie
 */

const defaultKey = (/** @type {Request} */ req) => `${req.method} ${req.url}`;

/**
 * Whether the response, about to start, sets a cookie: then it was made for
 * one client and must not be shared.
 *
 * @param {Response} res
 * @param {unknown[]} writeHeadArgs
 */
function setsCookie(res, writeHeadArgs) {
  if (res.hasHeader('set-cookie')) {
    return true;
  }
  // writeHead(statusCode, [statusMessage], [headers])
  const headers = writeHeadArgs.find((arg) => typeof arg === 'object');
  if (Array.isArray(headers)) {
    // Raw headers: name, value, name, value…
    return headers.some(
      (item, i) => i % 2 === 0 && String(item).toLowerCase() === 'set-cookie'
    );
  }
  return Object.keys(headers ?? {}).some(
    (name) => name.toLowerCase() === 'set-cookie'
  );
}

/**
 * Hands the origin response over to the duplicates when it starts: its
 * status and headers, then everything written. If it sets a cookie, the
 * duplicates are processed on their own instead.
 *
 * @param {Entry & { duplicates: Duplicate[] }} entry
 * @param {() => void} forget Called when the response turns out private
 */
function mirror(entry, forget) {
  const originRes = entry.origin.res;
  let started = false;

  /** @param {unknown[]} writeHeadArgs */
  const start = (writeHeadArgs) => {
    started = true;
    if (setsCookie(originRes, writeHeadArgs)) {
      entry.private = true;
      forget();
      for (const { next } of entry.duplicates.splice(0)) {
        next();
      }
      return;
    }
    for (const { res } of entry.duplicates) {
      res.statusCode = originRes.statusCode;
      if (originRes.statusMessage) {
        res.statusMessage = originRes.statusMessage;
      }
      for (const [name, value] of Object.entries(originRes.getHeaders())) {
        if (value !== undefined) {
          res.setHeader(name, value);
        }
      }
    }
  };

  for (const method of /** @type {const} */ (['writeHead', 'write', 'end'])) {
    /** @type {(...args: any[]) => unknown} */
    const originMethod = originRes[method];
    /** @type {any} */ (originRes)[method] = (
      /** @type {unknown[]} */ ...args
    ) => {
      if (!started) {
        start(method === 'writeHead' ? args : []);
      }
      for (const { res } of entry.duplicates) {
        // end() calls writeHead() when the headers weren't sent yet
        if (!(method === 'writeHead' && res.headersSent)) {
          /** @type {(...args: any[]) => unknown} */ (res[method]).apply(
            res,
            args
          );
        }
      }
      return originMethod.apply(originRes, args);
    };
  }
}

/**
 * Serves identical concurrent requests with a single response.
 *
 * While a request is in progress, any other request with the same key waits
 * for it and receives a copy of its response instead of being processed
 * again. A request only joins one whose response hasn't started yet, and
 * a response that sets a cookie is never shared: the requests waiting for it
 * are then processed on their own.
 *
 * @param {DuplicateHandlerOptions} [options]
 * @returns {Middleware}
 */
function duplicateHandler({ skip, key = defaultKey, timeout } = {}) {
  const timeoutMs = (Number(timeout) || 30) * 1000;

  /** @type {Map<string, Entry>} */
  const requests = new Map();

  // Garbage collection (not necessary under normal operation)
  setInterval(() => {
    if (requests.size > 0) {
      debug(`${requests.size} current registered requests`);
    }
    const expired = Date.now() - timeoutMs;
    for (const [id, entry] of requests) {
      if (entry.registeredAt < expired) {
        requests.delete(id);
      }
    }
  }, 1000).unref();

  return function handleDuplicate(req, res, next) {
    if (skip?.(req)) {
      next();
      return;
    }

    const id = key(req);
    const entry = requests.get(id);

    if (entry) {
      // Once the origin response started, it's too late to join it
      if (
        entry.origin.res.headersSent ||
        entry.private ||
        entry.origin.res.hasHeader('set-cookie')
      ) {
        next();
        return;
      }

      debug(`Duplicate request detected '${id}'`);

      if (!entry.duplicates) {
        entry.duplicates = [];
        mirror(
          /** @type {Entry & { duplicates: Duplicate[] }} */ (entry),
          () => {
            if (requests.get(id) === entry) {
              requests.delete(id);
            }
          }
        );
      }

      // Wait for the origin response
      entry.duplicates.push({ res, next });
      return;
    }

    requests.set(id, { registeredAt: Date.now(), origin: { req, res } });

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
