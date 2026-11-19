const duplicateHandler = require('./duplicate-handler');
const serviceLimiter = require('./service-limiter');

/**
 * @typedef {import('./types').Request} Request
 * @typedef {import('./types').Response} Response
 * @typedef {import('./types').Next} Next
 * @typedef {import('./types').Middleware} Middleware
 * @typedef {import('./duplicate-handler').DuplicateHandlerOptions} DuplicateHandlerOptions
 * @typedef {import('./service-limiter').ServiceLimiterOptions} ServiceLimiterOptions
 * @typedef {import('./service-limiter').ServiceLimiter} ServiceLimiter
 */

module.exports = { duplicateHandler, serviceLimiter };
