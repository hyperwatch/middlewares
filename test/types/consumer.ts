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
  onLimited: (req, res) => {
    res.statusCode = 503;
    res.end();
  },
  message: 'Later.',
});

app.use(limiter);
limiter.increaseServiceLevel(50);
const level: number = limiter.getServiceLevel();

// Plain http too
const handler: middlewares.Middleware = duplicateHandler();
http.createServer((req, res) =>
  handler(req, res, () => res.end(String(level)))
);
