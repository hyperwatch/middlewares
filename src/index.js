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
 * @typedef {import('./service-limiter').LevelStore} LevelStore
 * @typedef {import('./service-limiter').ManualLevel} ManualLevel
 * @typedef {import('./service-limiter').Limited} Limited
 */

module.exports = { duplicateHandler, serviceLimiter };
