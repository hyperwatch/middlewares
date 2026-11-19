const assert = require('node:assert');
const { setTimeout: sleep } = require('node:timers/promises');

const { serviceLimiter, defaultClassify } = require('../src');

const { listen, get } = require('./helpers');

// The usual schedule: high only, normal after 30 s, everything after 3 min
const STEPS = [
  { after: 30, serve: 'normal' },
  { after: 180, serve: 'low' },
];

const ROBOTS = {
  preview: { identity: 'Facebook', category: 'social-preview' },
  monitor: { identity: 'Pingdom', category: 'monitoring' },
  search: { identity: 'Googlebot', category: 'search-engine' },
  seo: { identity: 'Semrush', category: 'seo' },
  other: { identity: 'Stripe', category: 'other' },
  uncategorized: { identity: 'PayPal' },
  person: {},
};

// Runs the middleware on a request from `robot`, without a server
async function call(limiter, robot = {}, url = '/') {
  const req = { url, headers: {}, robot };
  const res = {
    statusCode: 200,
    headers: {},
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
    },
    end(body) {
      this.body = body;
    },
  };
  const result = { served: false, error: undefined };
  await limiter(req, res, (error) => {
    result.served = !error;
    result.error = error;
  });
  return {
    ...result,
    status: res.statusCode,
    retryAfter: res.headers['retry-after'],
    body: res.body,
  };
}

const create = (options) =>
  serviceLimiter({ identify: (req) => req.robot, ...options });

describe('serviceLimiter', () => {
  // The limiter reads performance.now(): the tests move it
  const realNow = performance.now;
  let clock;
  const elapse = (seconds) => {
    clock += seconds * 1000;
  };

  beforeEach(() => {
    clock = 1000;
    performance.now = () => clock;
  });

  afterEach(() => {
    performance.now = realNow;
  });

  const servedAmong = async (limiter) => {
    const served = [];
    for (const [name, robot] of Object.entries(ROBOTS)) {
      if ((await call(limiter, robot)).served) {
        served.push(name);
      }
    }
    return served;
  };

  describe('default policy', () => {
    it('classifies by category', () => {
      const priority = (name) => defaultClassify(ROBOTS[name]);
      assert.strictEqual(priority('preview'), 'high');
      assert.strictEqual(priority('monitor'), 'high');
      assert.strictEqual(priority('search'), 'normal');
      assert.strictEqual(priority('other'), 'normal');
      assert.strictEqual(priority('uncategorized'), 'normal');
      assert.strictEqual(priority('seo'), 'low');
      assert.strictEqual(priority('person'), undefined);
    });

    it('serves everything until warmUp() is called', async () => {
      const limiter = create();
      assert.strictEqual(limiter.serving(), 'low');
      assert.strictEqual((await servedAmong(limiter)).length, 7);
    });

    it('serves more at each step', async () => {
      const limiter = create();
      limiter.warmUp(STEPS);
      assert.strictEqual(limiter.serving(), 'high');
      assert.deepStrictEqual(await servedAmong(limiter), [
        'preview',
        'monitor',
        'person',
      ]);
      elapse(30);
      assert.strictEqual(limiter.serving(), 'normal');
      assert.deepStrictEqual(await servedAmong(limiter), [
        'preview',
        'monitor',
        'search',
        'other',
        'uncategorized',
        'person',
      ]);
      elapse(150);
      assert.strictEqual(limiter.serving(), 'low');
      assert.strictEqual((await servedAmong(limiter)).length, 7);
    });

    it('answers a limited request with a 503', async () => {
      const limiter = create();
      limiter.warmUp(STEPS);
      const res = await call(limiter, ROBOTS.search);
      assert.strictEqual(res.served, false);
      assert.strictEqual(res.status, 503);
      assert.strictEqual(res.body, 'Service Limited. Try again later.');
    });
  });

  describe('customizing', () => {
    it('one exception around the default', async () => {
      const limiter = create({
        classify(context) {
          if (context.identity === 'Googlebot') {
            return 'low';
          }
          return defaultClassify(context);
        },
      });
      limiter.warmUp(STEPS);
      elapse(30);
      assert.strictEqual((await call(limiter, ROBOTS.search)).served, false);
      assert.strictEqual((await call(limiter, ROBOTS.other)).served, true);
    });

    it('a request without identity can be given a priority', async () => {
      const limiter = create({
        classify: ({ identity, req }) =>
          !identity && req.url === '/claims-a-robot' ? 'low' : undefined,
      });
      limiter.warmUp(STEPS);
      assert.strictEqual((await call(limiter, {})).served, true);
      assert.strictEqual(
        (await call(limiter, {}, '/claims-a-robot')).served,
        false
      );
    });

    it('other priorities, with their classify', async () => {
      const limiter = create({
        priorities: ['urgent', 'background'],
        classify: ({ identity }) =>
          identity === 'Pingdom' ? 'urgent' : 'background',
      });
      limiter.warmUp([{ after: 60, serve: 'background' }]);
      assert.strictEqual((await call(limiter, ROBOTS.monitor)).served, true);
      assert.strictEqual((await call(limiter, ROBOTS.search)).served, false);
      elapse(60);
      assert.strictEqual((await call(limiter, ROBOTS.search)).served, true);
    });

    it('other priorities without classify throw', () => {
      assert.throws(
        () => serviceLimiter({ priorities: ['urgent', 'background'] }),
        /need their own classify/
      );
      // The default names in another list are fine
      serviceLimiter({ priorities: ['critical', 'high', 'normal', 'low'] });
    });

    it('rejects invalid priorities and timeout', () => {
      for (const priorities of [[], ['a', 'a'], ['a', ''], 'high', [1]]) {
        assert.throws(
          () => serviceLimiter({ priorities, classify: () => 'a' }),
          TypeError
        );
      }
      for (const timeout of [0, -1, NaN, Infinity, '1']) {
        assert.throws(() => serviceLimiter({ timeout }), RangeError);
      }
    });

    it('copies the priorities', async () => {
      const priorities = ['high', 'normal', 'low'];
      const limiter = create({ priorities });
      priorities.reverse();
      limiter.warmUp(STEPS);
      assert.strictEqual(limiter.serving(), 'high');
    });
  });

  describe('skip', () => {
    it('passes before identifying', async () => {
      let identified = 0;
      const limiter = serviceLimiter({
        skip: (req) => req.url === '/health',
        identify: (req) => {
          identified++;
          return req.robot;
        },
      });
      limiter.warmUp(STEPS);
      assert.strictEqual(
        (await call(limiter, ROBOTS.search, '/health')).served,
        true
      );
      assert.strictEqual(identified, 0);
      assert.strictEqual((await call(limiter, ROBOTS.search)).served, false);
      assert.strictEqual(identified, 1);
    });

    it('passes its error on', async () => {
      const error = new Error('skip');
      const limiter = create({
        skip: () => {
          throw error;
        },
      });
      assert.strictEqual((await call(limiter)).error, error);
    });
  });

  describe('Retry-After', () => {
    it('is the time left until the step serving the priority', async () => {
      const limiter = create();
      limiter.warmUp(STEPS);
      assert.strictEqual((await call(limiter, ROBOTS.search)).retryAfter, '30');
      assert.strictEqual((await call(limiter, ROBOTS.seo)).retryAfter, '180');
      elapse(10.5);
      assert.strictEqual((await call(limiter, ROBOTS.search)).retryAfter, '20');
      elapse(19.4999);
      assert.strictEqual((await call(limiter, ROBOTS.search)).retryAfter, '1');
      // 129.9999 s in: 50.0001 s left, rounded up
      elapse(100);
      assert.strictEqual((await call(limiter, ROBOTS.seo)).retryAfter, '51');
    });

    it('uses the first step at or past the priority', async () => {
      const limiter = create();
      // normal is never a step of its own
      limiter.warmUp([{ after: 60, serve: 'low' }]);
      assert.strictEqual((await call(limiter, ROBOTS.search)).retryAfter, '60');
    });

    it('is absent when no step serves the priority', async () => {
      const limiter = create();
      limiter.warmUp([{ after: 30, serve: 'normal' }]);
      const res = await call(limiter, ROBOTS.seo);
      assert.strictEqual(res.status, 503);
      assert.strictEqual(res.retryAfter, undefined);
      elapse(3600);
      assert.strictEqual((await call(limiter, ROBOTS.seo)).status, 503);
    });
  });

  describe('warmUp', () => {
    it('a step counts from the instant it is due', async () => {
      const limiter = create();
      limiter.warmUp(STEPS);
      elapse(29.999);
      assert.strictEqual((await call(limiter, ROBOTS.search)).served, false);
      elapse(0.001);
      assert.strictEqual((await call(limiter, ROBOTS.search)).served, true);
    });

    it('decides with the time once the request is classified', async () => {
      const limiter = create({
        identify: async (req) => {
          // The step comes while the request is identified
          elapse(30);
          return req.robot;
        },
      });
      limiter.warmUp(STEPS);
      assert.strictEqual((await call(limiter, ROBOTS.search)).served, true);
    });

    it('without steps, serves the first priority only', async () => {
      const limiter = create();
      limiter.warmUp([]);
      elapse(3600);
      assert.deepStrictEqual(await servedAmong(limiter), [
        'preview',
        'monitor',
        'person',
      ]);
    });

    it('can only be called once', () => {
      const limiter = create();
      limiter.warmUp(STEPS);
      assert.throws(() => limiter.warmUp(STEPS), /already called/);
    });

    it('rejects invalid steps and stays as it was', async () => {
      const limiter = create();
      const invalid = [
        'steps',
        [null],
        [{ after: -1, serve: 'normal' }],
        [{ after: NaN, serve: 'normal' }],
        [{ after: Infinity, serve: 'normal' }],
        [{ after: '30', serve: 'normal' }],
        [{ after: 30, serve: 'unknown' }],
        // Serves nothing more than the start
        [{ after: 30, serve: 'high' }],
        // Serves less than the step before
        [
          { after: 30, serve: 'low' },
          { after: 60, serve: 'normal' },
        ],
        // Not later than the step before
        [
          { after: 30, serve: 'normal' },
          { after: 30, serve: 'low' },
        ],
      ];
      for (const steps of invalid) {
        assert.throws(() => limiter.warmUp(steps), /Error/);
      }
      // Still not started
      assert.strictEqual(limiter.serving(), 'low');
      limiter.warmUp(STEPS);
      assert.strictEqual(limiter.serving(), 'high');
    });

    it('copies the steps', async () => {
      const limiter = create();
      const steps = [{ after: 30, serve: 'normal' }];
      limiter.warmUp(steps);
      steps[0].after = 0;
      steps.push({ after: 1, serve: 'low' });
      assert.strictEqual(limiter.serving(), 'high');
      elapse(30);
      assert.strictEqual(limiter.serving(), 'normal');
    });

    it('accepts a step at 0', async () => {
      const limiter = create();
      limiter.warmUp([
        { after: 0, serve: 'normal' },
        { after: 60, serve: 'low' },
      ]);
      assert.strictEqual(limiter.serving(), 'normal');
    });
  });

  describe('when the limiter fails, the request is served', () => {
    const failing = async (options, robot = ROBOTS.search) => {
      const errors = [];
      const limiter = create({
        onError: (error, { kind }) => errors.push([kind, error.message]),
        ...options,
      });
      limiter.warmUp(STEPS);
      const res = await call(limiter, robot);
      assert.strictEqual(res.served, true);
      return errors;
    };

    it('identify throws or rejects', async () => {
      assert.deepStrictEqual(
        await failing({
          identify: () => {
            throw new Error('sync');
          },
        }),
        [['identify', 'sync']]
      );
      assert.deepStrictEqual(
        await failing({ identify: () => Promise.reject(new Error('async')) }),
        [['identify', 'async']]
      );
    });

    it('identify or classify rejects with something that is not an error', async () => {
      for (const thrown of [undefined, null, 'no', 0]) {
        for (const option of ['identify', 'classify']) {
          const errors = await failing({
            [option]: () => Promise.reject(thrown),
          });
          assert.strictEqual(errors.length, 1);
          assert.strictEqual(errors[0][0], option);
        }
      }
    });

    it('identify returns something else than an object', async () => {
      const errors = await failing({ identify: () => 'Googlebot' });
      assert.strictEqual(errors[0][0], 'identify');
    });

    it('identify returns nothing: not identified, no error', async () => {
      assert.deepStrictEqual(await failing({ identify: () => null }), []);
      assert.deepStrictEqual(await failing({ identify: () => undefined }), []);
    });

    it('classify throws or rejects', async () => {
      assert.deepStrictEqual(
        await failing({
          classify: () => {
            throw new Error('sync');
          },
        }),
        [['classify', 'sync']]
      );
      assert.deepStrictEqual(
        await failing({ classify: () => Promise.reject(new Error('async')) }),
        [['classify', 'async']]
      );
    });

    it('classify returns a name that is not a priority', async () => {
      const circular = {};
      circular.self = circular;
      for (const value of [
        'hihg',
        '',
        0,
        1,
        false,
        {},
        ['low'],
        10n,
        circular,
        Symbol('low'),
      ]) {
        const errors = await failing({ classify: () => value });
        assert.strictEqual(errors.length, 1, String(value));
        assert.strictEqual(errors[0][0], 'priority');
      }
    });

    it('classify returns null or undefined: never limited, no error', async () => {
      assert.deepStrictEqual(await failing({ classify: () => null }), []);
      assert.deepStrictEqual(await failing({ classify: () => undefined }), []);
    });

    it('identify or classify never answers', async () => {
      const started = Date.now();
      assert.deepStrictEqual(
        await failing({ timeout: 0.05, identify: () => new Promise(() => {}) }),
        [['timeout', 'no answer within 0.05 s']]
      );
      assert.deepStrictEqual(
        await failing({ timeout: 0.05, classify: () => new Promise(() => {}) }),
        [['timeout', 'no answer within 0.05 s']]
      );
      assert.ok(Date.now() - started < 1000);
    });

    it('a slow answer within the timeout counts', async () => {
      const limiter = create({
        timeout: 0.5,
        identify: async (req) => {
          await sleep(20);
          return req.robot;
        },
      });
      limiter.warmUp(STEPS);
      assert.strictEqual((await call(limiter, ROBOTS.search)).served, false);
    });

    it('warns once per kind by default', async () => {
      const warnings = [];
      const onWarning = (warning) => warnings.push(warning.code);
      process.on('warning', onWarning);
      try {
        const limiter = create({ classify: () => 'hihg' });
        limiter.warmUp(STEPS);
        for (let i = 0; i < 3; i++) {
          assert.strictEqual((await call(limiter, ROBOTS.search)).served, true);
        }
        await sleep(10); // warnings are emitted on the next tick
        assert.deepStrictEqual(warnings, [
          'HYPERWATCH_SERVICE_LIMITER_PRIORITY',
        ]);
      } finally {
        process.off('warning', onWarning);
      }
    });

    it('an error in onError is passed on', async () => {
      const error = new Error('onError');
      const limiter = create({
        classify: () => 'hihg',
        onError: () => {
          throw error;
        },
      });
      limiter.warmUp(STEPS);
      assert.strictEqual((await call(limiter, ROBOTS.search)).error, error);
    });
  });

  describe('respond and onLimited', () => {
    it('onLimited is told, the default response is still sent', async () => {
      const told = [];
      const limiter = create({
        message: 'Later. Write to support@example.com.',
        onLimited: (req, limited) => told.push(limited),
      });
      limiter.warmUp(STEPS);
      const res = await call(limiter, ROBOTS.seo);
      assert.strictEqual(res.status, 503);
      assert.strictEqual(res.retryAfter, '180');
      assert.strictEqual(res.body, 'Later. Write to support@example.com.');
      assert.deepStrictEqual(told, [
        {
          identity: 'Semrush',
          category: 'seo',
          priority: 'low',
          serving: 'high',
          retryAfter: 180,
        },
      ]);
    });

    it('respond replaces the response', async () => {
      const limiter = create({
        respond: (req, res, { retryAfter }) => {
          res.statusCode = 429;
          res.end(`in ${retryAfter}`);
        },
      });
      limiter.warmUp(STEPS);
      const res = await call(limiter, ROBOTS.search);
      assert.strictEqual(res.status, 429);
      assert.strictEqual(res.body, 'in 30');
    });

    it('their errors are passed on', async () => {
      const error = new Error('respond');
      for (const options of [
        {
          respond: () => {
            throw error;
          },
        },
        {
          onLimited: () => {
            throw error;
          },
        },
      ]) {
        const limiter = create(options);
        limiter.warmUp(STEPS);
        assert.strictEqual((await call(limiter, ROBOTS.search)).error, error);
      }
    });
  });

  describe('default identify', () => {
    const callWith = async (extra) => {
      const limiter = serviceLimiter();
      limiter.warmUp(STEPS);
      const req = { url: '/', headers: {}, ...extra };
      const res = { statusCode: 200, setHeader() {}, end() {} };
      let served = false;
      await limiter(req, res, () => {
        served = true;
      });
      return served;
    };

    // What Hyperwatch's Express input gives: an Immutable log
    const hyperwatch = (values, calls = []) => ({
      getAugmentedLog: async (options) => {
        calls.push(options);
        return { get: (key) => values[key] };
      },
    });

    it("reads Hyperwatch's augmented log, fast", async () => {
      const calls = [];
      assert.strictEqual(
        await callWith({ hyperwatch: hyperwatch(ROBOTS.search, calls) }),
        false
      );
      assert.deepStrictEqual(calls, [{ fast: true }]);
      assert.strictEqual(
        await callWith({ hyperwatch: hyperwatch(ROBOTS.preview) }),
        true
      );
      assert.strictEqual(await callWith({ hyperwatch: hyperwatch({}) }), true);
    });

    it('else reads req.identity', async () => {
      assert.strictEqual(await callWith({ identity: 'Googlebot' }), false);
    });

    it('without either, serves everything', async () => {
      assert.strictEqual(await callWith({}), true);
      assert.strictEqual(await callWith({ hyperwatch: {} }), true);
    });
  });

  describe('over HTTP', () => {
    let app;

    afterEach(() => app.close());

    it('sends the 503, Retry-After and the message', async () => {
      performance.now = realNow;
      const limiter = serviceLimiter({
        identify: (req) => ({
          identity: req.headers['x-identity'],
          category: req.headers['x-category'],
        }),
      });
      app = await listen([limiter], (req, res) => res.end('ok'));
      limiter.warmUp([{ after: 0.2, serve: 'low' }]);
      const headers = { 'x-identity': 'Semrush', 'x-category': 'seo' };

      const limited = await get(app.url, { headers });
      assert.strictEqual(limited.status, 503);
      assert.strictEqual(limited.headers.get('retry-after'), '1');
      assert.strictEqual(
        limited.headers.get('content-type'),
        'text/plain; charset=utf-8'
      );
      assert.strictEqual(limited.body, 'Service Limited. Try again later.');
      assert.strictEqual((await get(app.url)).status, 200);

      await sleep(250);
      assert.strictEqual((await get(app.url, { headers })).status, 200);
    });
  });
});
