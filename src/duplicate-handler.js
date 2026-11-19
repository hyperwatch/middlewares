const debug = require('debug')('hyperwatch:duplicate-handler');

/**
 * @typedef {import('./types').Request} Request
 * @typedef {import('./types').Response} Response
 * @typedef {import('./types').Middleware} Middleware
 */

/**
 * @typedef {object} DuplicateHandlerOptions
 * @property {(req: Request) => boolean} [skip] Return true to process a request
 *   normally, on top of the methods and credentials rules.
 * @property {(req: Request) => string} [key] Requests with the same key are
 *   duplicates. Default: method, host and URL.
 * @property {Iterable<string>} [methods] The methods whose requests can be
 *   shared. Default: GET and HEAD.
 * @property {boolean} [shareCredentials] Also share requests carrying a
 *   cookie or an Authorization header. Default: false, their responses can
 *   depend on who asks.
 * @property {number | string} [timeout] Seconds after which the requests still
 *   waiting for a response that hasn't started get a 503. Default: 30.
 */

/**
 * @typedef {object} Duplicate
 * @property {Request} req
 * @property {Response} res
 * @property {import('./types').Next} next
 */

/**
 * @typedef {object} Entry
 * @property {number} registeredAt
 * @property {{ req: Request, res: Response }} origin
 * @property {Duplicate[]} [duplicates] Set when the first duplicate arrives
 * @property {boolean} [started] The origin response started
 * @property {boolean} [private] The origin response sets a cookie
 */

const DEFAULT_METHODS = ['GET', 'HEAD'];

/** @param {Request} req */
const hasCredentials = (req) =>
  Boolean(req.headers.cookie || req.headers.authorization);

const defaultKey = (/** @type {Request} */ req) =>
  `${req.method} ${req.headers.host ?? ''}${req.url}`;

/**
 * The values of a header in a response about to start: set with setHeader,
 * or given to writeHead(statusCode, [statusMessage], [headers]).
 *
 * @param {Response} res
 * @param {unknown[]} writeHeadArgs
 * @param {string} name Lower case
 * @returns {string[]}
 */
function headerValues(res, writeHeadArgs, name) {
  /** @type {unknown[]} */
  const values = [res.getHeader(name)];
  const headers = writeHeadArgs.find((arg) => typeof arg === 'object');
  if (Array.isArray(headers)) {
    // Raw headers: name, value, name, value…
    for (let i = 0; i < headers.length - 1; i += 2) {
      if (String(headers[i]).toLowerCase() === name) {
        values.push(headers[i + 1]);
      }
    }
  } else if (headers) {
    for (const [key, value] of Object.entries(headers)) {
      if (key.toLowerCase() === name) {
        values.push(value);
      }
    }
  }
  return values
    .flat()
    .filter((value) => value !== undefined)
    .map(String);
}

/**
 * The request headers a response depends on, from its Vary header, except
 * Accept-Encoding: a shared response is passed on uncompressed. `*` means it
 * depends on more than headers.
 *
 * @param {Response} res
 * @param {unknown[]} writeHeadArgs
 */
function varyHeaders(res, writeHeadArgs) {
  return headerValues(res, writeHeadArgs, 'vary')
    .flatMap((value) => value.split(','))
    .map((name) => name.trim().toLowerCase())
    .filter((name) => name && name !== 'accept-encoding');
}

/**
 * Whether two requests have the same values for the given headers.
 *
 * @param {Request} a
 * @param {Request} b
 * @param {string[]} names Lower case
 */
const sameHeaders = (a, b, names) =>
  names.every(
    (name) => String(a.headers[name] ?? '') === String(b.headers[name] ?? '')
  );

/**
 * Hands the origin response over to the duplicates when it starts: its
 * status and headers, then everything written. If it sets a cookie, the
 * duplicates are processed on their own instead, and so are those whose
 * headers named by Vary differ from the origin request's.
 *
 * @param {Entry & { duplicates: Duplicate[] }} entry
 * @param {() => void} forget Called when the response turns out private
 */
function mirror(entry, forget) {
  const originRes = entry.origin.res;

  /** @param {unknown[]} writeHeadArgs */
  const start = (writeHeadArgs) => {
    entry.started = true;
    if (headerValues(originRes, writeHeadArgs, 'set-cookie').length > 0) {
      entry.private = true;
      forget();
      const released = entry.duplicates.splice(0);
      // Not within the origin's write: their whole processing would run there
      process.nextTick(() => {
        for (const { next } of released) {
          next();
        }
      });
      return;
    }
    const vary = varyHeaders(originRes, writeHeadArgs);
    if (vary.length > 0) {
      /** @type {Duplicate[]} */
      const released = [];
      for (const duplicate of entry.duplicates.splice(0)) {
        const matches =
          !vary.includes('*') &&
          sameHeaders(duplicate.req, entry.origin.req, vary);
        (matches ? entry.duplicates : released).push(duplicate);
      }
      process.nextTick(() => {
        for (const { next } of released) {
          next();
        }
      });
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
      if (!entry.started) {
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
 * are then processed on their own, as are those that differ from the first
 * one in a header the response varies on (`Vary`, except Accept-Encoding).
 * If the response hasn't started after
 * `timeout`, the requests waiting for it all get a 503.
 *
 * @param {DuplicateHandlerOptions} [options]
 * @returns {Middleware}
 */
function duplicateHandler({
  skip,
  key = defaultKey,
  methods = DEFAULT_METHODS,
  shareCredentials = false,
  timeout,
} = {}) {
  const timeoutMs = (Number(timeout) || 30) * 1000;
  const shared = new Set([...methods].map((method) => method.toUpperCase()));

  /** @param {Request} req */
  const skipped = (req) =>
    !shared.has(req.method ?? '') ||
    (!shareCredentials && hasCredentials(req)) ||
    Boolean(skip?.(req));

  /**
   * The requests still waiting when the origin response hasn't started yet
   * get a 503, all at once.
   *
   * @param {Entry & { duplicates: Duplicate[] }} entry
   * @param {string} id
   */
  const failOnTimeout = (entry, id) => {
    setTimeout(
      () => {
        if (entry.started || entry.duplicates.length === 0) {
          return;
        }
        debug(`Timeout of '${id}': ${entry.duplicates.length} requests fail`);
        if (requests.get(id) === entry) {
          requests.delete(id);
        }
        for (const { res } of entry.duplicates.splice(0)) {
          res.statusCode = 503;
          res.setHeader('Content-Type', 'text/plain; charset=utf-8');
          res.end('Service Unavailable');
        }
      },
      entry.registeredAt + timeoutMs - Date.now()
    ).unref();
  };

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
    if (skipped(req)) {
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
        const joined = /** @type {Entry & { duplicates: Duplicate[] }} */ (
          entry
        );
        mirror(joined, () => {
          if (requests.get(id) === entry) {
            requests.delete(id);
          }
        });
        failOnTimeout(joined, id);
      }

      // Wait for the origin response
      entry.duplicates.push({ req, res, next });
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
