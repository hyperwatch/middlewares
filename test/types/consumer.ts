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

const limiter: middlewares.ServiceLimiter = serviceLimiter({
  essentialIdentities: ['Facebook'],
  nonEssentialIdentities: new Set(['Semrush']),
  initialLevel: 0,
  getIdentity: async (req) =>
    req.identity ?? req.headers['x-identity']?.toString(),
  retryAfter: 3600,
  onLimited: (req, res, { level, warmingUp, retryAfter }) => {
    res.statusCode = warmingUp ? 503 : 429;
    res.setHeader('X-Level', String(level));
    res.end(retryAfter === undefined ? '' : String(retryAfter));
  },
  message: 'Later.',
});

app.use(limiter);
limiter.warmUp([
  { after: 30, level: 50 },
  { after: 180, level: 100 },
]);
limiter.increaseServiceLevel(50);
void limiter.setServiceLevel(40, { until: new Date(Date.now() + 600_000) });
void limiter.clearServiceLevel();

// A store shared between processes
const values = new Map<string, string>();
const store: middlewares.LevelStore = {
  get: async () => JSON.parse(values.get('service-level') ?? 'null'),
  set: async (value) => {
    values.set('service-level', JSON.stringify(value));
  },
};
serviceLimiter({ store, refreshInterval: 5 });
const level: number = limiter.getServiceLevel();
process.on('SIGTERM', () => limiter.close());

// Plain http too
const handler: middlewares.Middleware = duplicateHandler();
http.createServer((req, res) =>
  handler(req, res, () => res.end(String(level)))
);
