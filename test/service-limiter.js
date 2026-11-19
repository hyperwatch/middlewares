const assert = require('node:assert');

const { serviceLimiter } = require('../src');

const { listen, get } = require('./helpers');

describe('serviceLimiter', () => {
  let app;

  const start = async (options) => {
    const limiter = serviceLimiter({
      essentialIdentities: ['Facebook'],
      nonEssentialIdentities: ['Semrush'],
      getIdentity: (req) => req.headers['x-identity'],
      ...options,
    });
    app = await listen([limiter], (req, res) => res.end('ok'));
    return limiter;
  };

  const statusFor = async (identity) => {
    const headers = identity ? { 'x-identity': identity } : {};
    return (await get(app.url, { headers })).status;
  };

  afterEach(() => app.close());

  it('below 50: only essential identities and unidentified requests', async () => {
    await start();
    assert.strictEqual(await statusFor(), 200);
    assert.strictEqual(await statusFor('Facebook'), 200);
    assert.strictEqual(await statusFor('Googlebot'), 503);
    assert.strictEqual(await statusFor('Semrush'), 503);
  });

  it('from 50: all but non-essential identities', async () => {
    const limiter = await start();
    limiter.increaseServiceLevel(50);
    assert.strictEqual(await statusFor('Googlebot'), 200);
    assert.strictEqual(await statusFor('Semrush'), 503);
  });

  it('at 100: everything', async () => {
    const limiter = await start();
    limiter.increaseServiceLevel(100);
    assert.strictEqual(await statusFor('Semrush'), 200);
  });

  it('never decreases the level', async () => {
    const limiter = await start({ initialLevel: 50 });
    limiter.increaseServiceLevel(10);
    assert.strictEqual(limiter.getServiceLevel(), 50);
  });

  it('uses the custom response', async () => {
    await start({
      onLimited: (req, res) => {
        res.statusCode = 429;
        res.end('later');
      },
    });
    const res = await get(app.url, { headers: { 'x-identity': 'Googlebot' } });
    assert.strictEqual(res.status, 429);
    assert.strictEqual(res.body, 'later');
  });

  it("reads Hyperwatch's identity by default", async () => {
    const limiter = serviceLimiter();
    app = await listen(
      [
        (req, res, next) => {
          req.hyperwatch = { getIdentity: async () => 'Googlebot' };
          next();
        },
        limiter,
      ],
      (req, res) => res.end('ok')
    );
    const res = await get(app.url);
    assert.strictEqual(res.status, 503);
    assert.strictEqual(res.body, 'Service Limited. Try again later.');
  });
});
