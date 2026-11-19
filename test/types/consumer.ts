// Uses the middlewares the way a TypeScript user does. `npm run types:test`
// (scripts/test-types.js) installs the packed package in a temporary project
// and type-checks this file with it, strict.
import http = require('node:http');
import express = require('express');
import middlewares = require('@hyperwatch/middlewares');

const { duplicateHandler, serviceLimiter } = middlewares;

const app = express();

app.use(
  duplicateHandler({
    skip: (req) => Boolean(req.headers.cookie || req.headers.authorization),
    key: (req) => `${req.method} ${req.url}`,
    timeout: 30,
  })
);

const { defaultClassify } = middlewares;

// The default
const limiter: middlewares.ServiceLimiter = serviceLimiter();
app.use(limiter);
limiter.warmUp([
  { after: 30, serve: 'normal' },
  { after: 180, serve: 'low' },
]);
const serving: string = limiter.serving();

// One exception around the default, and every option
serviceLimiter({
  classify(context) {
    if (context.identity === 'PetalBot') {
      return 'low';
    }
    return defaultClassify(context);
  },
  skip: (req) => req.url === '/health',
  identify: async (req) => ({
    identity: req.identity ?? req.headers['x-identity']?.toString(),
    category: undefined,
  }),
  timeout: 1,
  message: 'Later.',
  respond: (req, res, { retryAfter }) => {
    res.statusCode = 429;
    res.end(retryAfter === undefined ? '' : String(retryAfter));
  },
  onLimited: (req, { identity, category, priority, serving }) => {
    console.log(req.url, identity, category, priority, serving);
  },
  onError: (error, { kind, req }) => {
    console.error(kind, req.url, error.message);
  },
});

// Other priorities, with their own policy
serviceLimiter({
  priorities: ['urgent', 'background'],
  classify: async ({ identity, category, req }) => {
    if (!identity || req.url === '/') {
      return undefined;
    }
    return category === 'monitoring' ? 'urgent' : 'background';
  },
});

// Plain http too
const handler: middlewares.Middleware = duplicateHandler();
http.createServer((req, res) => handler(req, res, () => res.end(serving)));
