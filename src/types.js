// Types shared by the middlewares (JSDoc only, nothing at runtime)

/**
 * A request, as Express, Connect or plain `http` hand it over. With
 * Hyperwatch's Express input, `hyperwatch` and `identity` may be set.
 *
 * @typedef {import('http').IncomingMessage & {
 *   identity?: string;
 *   hyperwatch?: { getIdentity?: () => string | undefined | Promise<string | undefined> };
 * }} Request
 */

/** @typedef {import('http').ServerResponse} Response */

/** @typedef {(err?: unknown) => void} Next */

/** @typedef {(req: Request, res: Response, next: Next) => void} Middleware */

module.exports = {};
