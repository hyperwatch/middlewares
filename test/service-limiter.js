const assert = require('node:assert');
const { setTimeout: sleep } = require('node:timers/promises');

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

  it('never limits unidentified requests and essential identities, even below 0', async () => {
    const limiter = await start({ initialLevel: -10 });
    assert.strictEqual(await statusFor(), 200);
    assert.strictEqual(await statusFor('Facebook'), 200);
    await limiter.setServiceLevel(-50);
    assert.strictEqual(await statusFor(), 200);
    assert.strictEqual(await statusFor('Facebook'), 200);
    assert.strictEqual(await statusFor('Googlebot'), 503);
  });

  describe('Retry-After', () => {
    const retryAfterFor = async (identity) => {
      const res = await get(app.url, { headers: { 'x-identity': identity } });
      return [res.status, res.headers.get('retry-after')];
    };

    it('while warming up: until the step serving the request', async () => {
      const limiter = await start();
      limiter.warmUp([
        { after: 30, level: 50 },
        { after: 180, level: 100 },
      ]);
      assert.deepStrictEqual(await retryAfterFor('Googlebot'), [503, '30']);
      assert.deepStrictEqual(await retryAfterFor('Semrush'), [503, '180']);
    });

    it('raises the level step by step', async () => {
      const limiter = await start();
      limiter.warmUp([
        { after: 0.1, level: 50 },
        { after: 0.2, level: 100 },
      ]);
      await sleep(150);
      assert.strictEqual(limiter.getServiceLevel(), 50);
      assert.strictEqual(await statusFor('Googlebot'), 200);
      assert.deepStrictEqual(await retryAfterFor('Semrush'), [503, '1']);
      await sleep(100);
      assert.strictEqual(limiter.getServiceLevel(), 100);
      assert.strictEqual(await statusFor('Semrush'), 200);
    });

    it('limited manually: no Retry-After by default', async () => {
      const limiter = await start();
      // SERVICE_LEVEL=40: the warm-up never serves identified robots
      limiter.warmUp([{ after: 30, level: 40 }]);
      assert.deepStrictEqual(await retryAfterFor('Googlebot'), [503, null]);
    });

    it('limited manually: the retryAfter option', async () => {
      await start({ retryAfter: 3600 });
      assert.deepStrictEqual(await retryAfterFor('Googlebot'), [503, '3600']);
    });

    it('tells a custom response whether the server is warming up', async () => {
      const told = [];
      const limiter = await start({
        onLimited: (req, res, limited) => {
          told.push(limited);
          res.statusCode = 429;
          res.end();
        },
      });
      limiter.warmUp([{ after: 30, level: 50 }]);
      await statusFor('Googlebot');
      await statusFor('Semrush');
      assert.deepStrictEqual(told, [
        { level: 0, warmingUp: true, retryAfter: 30 },
        { level: 0, warmingUp: false, retryAfter: undefined },
      ]);
    });
  });

  describe('manual level', () => {
    it('limits below the warm-up level', async () => {
      const limiter = await start({ initialLevel: 100 });
      await limiter.setServiceLevel(40);
      assert.strictEqual(limiter.getServiceLevel(), 40);
      assert.strictEqual(await statusFor('Googlebot'), 503);
      assert.strictEqual(await statusFor('Facebook'), 200);
      await limiter.clearServiceLevel();
      assert.strictEqual(await statusFor('Googlebot'), 200);
    });

    it('never cuts a warm-up short', async () => {
      const limiter = await start();
      await limiter.setServiceLevel(100);
      assert.strictEqual(limiter.getServiceLevel(), 0);
    });

    it('ends at until, told as Retry-After', async () => {
      const limiter = await start({ initialLevel: 100 });
      await limiter.setServiceLevel(40, { until: Date.now() + 120_000 });
      const res = await get(app.url, {
        headers: { 'x-identity': 'Googlebot' },
      });
      assert.strictEqual(res.status, 503);
      assert.strictEqual(res.headers.get('retry-after'), '120');
      await limiter.setServiceLevel(40, { until: Date.now() - 1 });
      assert.strictEqual(await statusFor('Googlebot'), 200);
    });

    it('is shared through the store', async () => {
      let shared = null;
      const store = {
        get: async () => shared,
        set: async (value) => {
          shared = value;
        },
      };
      const other = serviceLimiter({ initialLevel: 100, store });
      const limiter = await start({
        initialLevel: 100,
        store,
        refreshInterval: 0.05,
      });
      await other.setServiceLevel(40);
      await sleep(100);
      assert.strictEqual(limiter.getServiceLevel(), 40);
      assert.strictEqual(await statusFor('Googlebot'), 503);
    });

    it('keeps the last level when the store fails', async () => {
      let fail = false;
      const store = {
        get: async () => {
          if (fail) {
            throw new Error('down');
          }
          return { level: 40 };
        },
        set: async () => {},
      };
      const limiter = await start({
        initialLevel: 100,
        store,
        refreshInterval: 0.05,
      });
      await sleep(100);
      fail = true;
      await sleep(100);
      assert.strictEqual(limiter.getServiceLevel(), 40);
    });
  });

  describe('races', () => {
    it('waits for the first read of the store', async () => {
      const store = {
        get: async () => {
          await sleep(100);
          return { level: 40 };
        },
        set: async () => {},
      };
      await start({ initialLevel: 100, store });
      assert.strictEqual(await statusFor('Googlebot'), 503);
    });

    it('waits 1 second at most for a slow store', async () => {
      const store = {
        get: () => new Promise(() => {}),
        set: async () => {},
      };
      await start({ initialLevel: 100, store });
      const started = Date.now();
      assert.strictEqual(await statusFor('Googlebot'), 200);
      assert.ok(Date.now() - started < 1500);
    });

    it('reads again after a read that hangs', async () => {
      let hang = true;
      const store = {
        get: () =>
          hang ? new Promise(() => {}) : Promise.resolve({ level: 40 }),
        set: async () => {},
      };
      const limiter = await start({
        initialLevel: 100,
        store,
        refreshInterval: 0.05,
      });
      hang = false;
      await sleep(200);
      assert.strictEqual(limiter.getServiceLevel(), 40);
    });

    it('drops the late result of an abandoned read', async () => {
      const answers = [];
      const store = {
        // Each read waits for its answer
        get: () => new Promise((resolve) => answers.push(resolve)),
        set: async () => {},
      };
      const limiter = await start({
        initialLevel: 100,
        store,
        refreshInterval: 0.05,
      });
      // The first read is given up, a second one starts
      for (let i = 0; i < 100 && answers.length < 2; i++) {
        await sleep(5);
      }
      assert.strictEqual(answers.length, 2, 'no second read');
      answers[1]({ level: 40 });
      await sleep(10);
      answers[0]({ level: 30 });
      await sleep(10);
      assert.strictEqual(limiter.getServiceLevel(), 40);
    });

    it('a new warm-up schedule replaces the previous one', async () => {
      const limiter = await start();
      limiter.warmUp([{ after: 0.05, level: 100 }]);
      limiter.warmUp([{ after: 30, level: 50 }]);
      await sleep(100);
      assert.strictEqual(limiter.getServiceLevel(), 0);
    });

    it('a read started before a write does not overwrite it', async () => {
      let shared = null;
      const store = {
        // Slow: returns what the store held when the read started
        get: async () => {
          const value = shared;
          await sleep(100);
          return value;
        },
        set: async (value) => {
          shared = value;
        },
      };
      // Its first read starts at creation, with nothing stored
      const limiter = await start({ initialLevel: 100, store });
      await limiter.setServiceLevel(40);
      await sleep(150);
      assert.strictEqual(limiter.getServiceLevel(), 40);
    });

    it('decides with the level once the identity is known', async () => {
      const limiter = await start({
        getIdentity: async (req) => {
          await sleep(100);
          return req.headers['x-identity'];
        },
      });
      const status = statusFor('Googlebot');
      await sleep(20);
      limiter.increaseServiceLevel(50);
      assert.strictEqual(await status, 200);
    });

    it('applies a manual level set while the identity is resolved', async () => {
      // Below 100: the identity is needed (at 100, requests pass at once)
      const limiter = await start({
        initialLevel: 60,
        getIdentity: async (req) => {
          await sleep(100);
          return req.headers['x-identity'];
        },
      });
      const status = statusFor('Googlebot');
      await sleep(20);
      await limiter.setServiceLevel(40);
      assert.strictEqual(await status, 503);
    });
  });
});
