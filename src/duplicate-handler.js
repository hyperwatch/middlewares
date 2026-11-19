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
 * @typedef {object} Entry
 * @property {number} registeredAt
 * @property {{ req: Request, res: Response }} origin
 * @property {Response[]} [duplicates] Set when the first duplicate arrives
 */

const HEADER_METHODS = new Set(['setHeader', 'removeHeader', 'writeHead']);
const PROXIED_METHODS = /** @type {const} */ ([
  'setHeader',
  'removeHeader',
  'writeHead',
  'write',
  'end',
]);

const defaultKey = (/** @type {Request} */ req) => `${req.method} ${req.url}`;

/**
 * Mirrors everything written on the origin response to the duplicates.
 *
 * @param {Response} originRes
 * @param {Response[]} duplicates
 */
function mirror(originRes, duplicates) {
  for (const method of PROXIED_METHODS) {
    /** @type {(...args: any[]) => unknown} */
    const originMethod = originRes[method];
    /** @type {any} */ (originRes)[method] = (
      /** @type {unknown[]} */ ...args
    ) => {
      for (const res of duplicates) {
        if (method === 'write' || method === 'end') {
          // Not set through a method, so not mirrored on its own
          res.statusCode = originRes.statusCode;
          if (originRes.statusMessage) {
            res.statusMessage = originRes.statusMessage;
          }
        }
        if (!(res.headersSent && HEADER_METHODS.has(method))) {
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
 * again. A request only joins one whose response hasn't started yet.
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
      if (entry.origin.res.headersSent) {
        next();
        return;
      }

      debug(`Duplicate request detected '${id}'`);

      if (!entry.duplicates) {
        entry.duplicates = [];
        mirror(entry.origin.res, entry.duplicates);
      }

      // Headers already set on the origin response
      for (const [name, value] of Object.entries(
        entry.origin.res.getHeaders()
      )) {
        if (value !== undefined) {
          res.setHeader(name, value);
        }
      }

      // Wait for the origin response
      entry.duplicates.push(res);
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
