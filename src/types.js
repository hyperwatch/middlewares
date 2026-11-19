// Types shared by the middlewares (JSDoc only, nothing at runtime)

/**
 * A request, as Express, Connect or plain `http` hand it over. With
 * Hyperwatch's Express input, `hyperwatch` is set.
 *
 * @typedef {import('http').IncomingMessage & {
 *   identity?: string;
 *   hyperwatch?: {
 *     getAugmentedLog?: (options?: { fast?: boolean }) => Promise<{ get(key: string): unknown }>;
 *   };
 * }} Request
 */

/** @typedef {import('http').ServerResponse} Response */

/** @typedef {(err?: unknown) => void} Next */

/** @typedef {(req: Request, res: Response, next: Next) => void} Middleware */

module.exports = {};
