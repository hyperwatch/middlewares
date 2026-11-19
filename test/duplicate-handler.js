const assert = require('node:assert');
const http = require('node:http');
const { setTimeout: sleep } = require('node:timers/promises');

const { duplicateHandler } = require('../src');

const { listen, get } = require('./helpers');

describe('duplicateHandler', () => {
  let app, calls;

  const slowHandler = async (req, res) => {
    calls++;
    res.setHeader('X-Call', String(calls));
    await sleep(100);
    res.statusCode = req.url === '/missing' ? 404 : 200;
    res.write('hello ');
    await sleep(20);
    res.end(`world ${req.url}`);
  };

  beforeEach(() => {
    calls = 0;
  });

  afterEach(() => app.close());

  it('serves concurrent identical requests with one response', async () => {
    app = await listen([duplicateHandler()], slowHandler);
    const responses = await Promise.all(
      [1, 2, 3].map(() => get(`${app.url}/a`))
    );
    assert.strictEqual(calls, 1);
    for (const res of responses) {
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body, 'hello world /a');
      assert.strictEqual(res.headers.get('x-call'), '1');
    }
  });

  it('copies the status code', async () => {
    app = await listen([duplicateHandler()], slowHandler);
    const responses = await Promise.all(
      [1, 2].map(() => get(`${app.url}/missing`))
    );
    assert.strictEqual(calls, 1);
    assert.deepStrictEqual(
      responses.map((res) => res.status),
      [404, 404]
    );
  });

  it('processes different URLs separately', async () => {
    app = await listen([duplicateHandler()], slowHandler);
    const [a, b] = await Promise.all([
      get(`${app.url}/a`),
      get(`${app.url}/b`),
    ]);
    assert.strictEqual(calls, 2);
    assert.strictEqual(a.body, 'hello world /a');
    assert.strictEqual(b.body, 'hello world /b');
  });

  it('processes requests in sequence separately', async () => {
    app = await listen([duplicateHandler()], slowHandler);
    await get(`${app.url}/a`);
    await get(`${app.url}/a`);
    assert.strictEqual(calls, 2);
  });

  it('processes skipped requests separately', async () => {
    const skip = (req) => Boolean(req.headers.authorization);
    app = await listen([duplicateHandler({ skip })], slowHandler);
    const headers = { authorization: 'Bearer x' };
    await Promise.all([1, 2].map(() => get(`${app.url}/a`, { headers })));
    assert.strictEqual(calls, 2);
  });

  it('does not join a response already started', async () => {
    app = await listen([duplicateHandler()], slowHandler);
    const first = get(`${app.url}/a`);
    await sleep(110); // headers sent, body not finished
    const second = await get(`${app.url}/a`);
    assert.strictEqual((await first).body, 'hello world /a');
    assert.strictEqual(second.body, 'hello world /a');
    assert.strictEqual(calls, 2);
  });

  describe('never shares a response setting a cookie', () => {
    const cookieHandler = (setCookie) => async (req, res) => {
      const call = ++calls;
      await sleep(100);
      setCookie(res, `session=${call}`);
      res.end(`call ${call}`);
    };

    const fetchAll = async () => {
      const responses = await Promise.all(
        [1, 2, 3].map(() => get(`${app.url}/a`))
      );
      return responses.map((res) => res.headers.get('set-cookie')).sort();
    };

    it('set with setHeader', async () => {
      app = await listen(
        [duplicateHandler()],
        cookieHandler((res, cookie) => res.setHeader('Set-Cookie', cookie))
      );
      assert.deepStrictEqual(await fetchAll(), [
        'session=1',
        'session=2',
        'session=3',
      ]);
      assert.strictEqual(calls, 3);
    });

    it('set with writeHead', async () => {
      app = await listen(
        [duplicateHandler()],
        cookieHandler((res, cookie) =>
          res.writeHead(200, { 'set-cookie': cookie })
        )
      );
      assert.deepStrictEqual(await fetchAll(), [
        'session=1',
        'session=2',
        'session=3',
      ]);
    });

    it('set with writeHead and raw headers', async () => {
      app = await listen(
        [duplicateHandler()],
        cookieHandler((res, cookie) =>
          res.writeHead(200, ['Set-Cookie', cookie])
        )
      );
      assert.deepStrictEqual(await fetchAll(), [
        'session=1',
        'session=2',
        'session=3',
      ]);
    });

    it('set before the duplicates arrive', async () => {
      app = await listen([duplicateHandler()], async (req, res) => {
        calls++;
        res.setHeader('Set-Cookie', `session=${calls}`);
        await sleep(100);
        res.end();
      });
      assert.deepStrictEqual(await fetchAll(), [
        'session=1',
        'session=2',
        'session=3',
      ]);
    });
  });

  describe('defaults', () => {
    it('shares GET and HEAD only', async () => {
      app = await listen([duplicateHandler()], slowHandler);
      await Promise.all(
        [1, 2].map(() => get(`${app.url}/a`, { method: 'POST' }))
      );
      assert.strictEqual(calls, 2);
    });

    it('shares the methods given', async () => {
      app = await listen(
        [duplicateHandler({ methods: ['post'] })],
        slowHandler
      );
      await Promise.all(
        [1, 2].map(() => get(`${app.url}/a`, { method: 'POST' }))
      );
      assert.strictEqual(calls, 1);
    });

    it('does not share requests carrying credentials', async () => {
      app = await listen([duplicateHandler()], slowHandler);
      await Promise.all([
        get(`${app.url}/a`, { headers: { cookie: 'session=1' } }),
        get(`${app.url}/a`, { headers: { cookie: 'session=2' } }),
        get(`${app.url}/a`, { headers: { authorization: 'Bearer x' } }),
        get(`${app.url}/a`, { headers: { authorization: 'Bearer x' } }),
      ]);
      assert.strictEqual(calls, 4);
    });

    it('shares them with shareCredentials', async () => {
      app = await listen(
        [duplicateHandler({ shareCredentials: true })],
        slowHandler
      );
      await Promise.all(
        [1, 2].map(() =>
          get(`${app.url}/a`, { headers: { authorization: 'Bearer x' } })
        )
      );
      assert.strictEqual(calls, 1);
    });
  });

  describe('timeout', () => {
    it('fails the waiting requests at once when the response never starts', async () => {
      const hung = [];
      app = await listen([duplicateHandler({ timeout: 0.3 })], (req, res) => {
        calls++;
        hung.push(res);
      });
      const first = fetch(`${app.url}/a`).catch(() => null);
      await sleep(20);
      const started = Date.now();
      const waiting = await Promise.all([1, 2].map(() => get(`${app.url}/a`)));
      assert.ok(Date.now() - started < 1000);
      assert.deepStrictEqual(
        waiting.map((res) => [res.status, res.body]),
        [
          [503, 'Service Unavailable'],
          [503, 'Service Unavailable'],
        ]
      );
      assert.strictEqual(calls, 1);
      for (const res of hung) {
        res.destroy();
      }
      await first;
    });

    it('leaves a response that started', async () => {
      app = await listen(
        [duplicateHandler({ timeout: 0.1 })],
        async (req, res) => {
          calls++;
          await sleep(50);
          res.write('hello ');
          await sleep(150);
          res.end('world');
        }
      );
      const responses = await Promise.all(
        [1, 2].map(() => get(`${app.url}/a`))
      );
      assert.deepStrictEqual(
        responses.map((res) => res.body),
        ['hello world', 'hello world']
      );
      assert.strictEqual(calls, 1);
    });
  });

  describe('Vary', () => {
    // Answers in the language asked, after a while
    const languageHandler = (setVary) => async (req, res) => {
      calls++;
      await sleep(100);
      setVary(res);
      res.end(`page in ${req.headers['accept-language'] ?? 'en'}`);
    };

    const fetchLanguages = (languages) =>
      Promise.all(
        languages.map((language) =>
          get(`${app.url}/a`, {
            headers: language ? { 'accept-language': language } : {},
          }).then((res) => res.body)
        )
      );

    it('shares only with requests having the same varied headers', async () => {
      app = await listen(
        [duplicateHandler()],
        languageHandler((res) => res.setHeader('Vary', 'Host, Accept-Language'))
      );
      const bodies = await fetchLanguages(['fr', 'fr', 'de', undefined]);
      assert.deepStrictEqual(bodies, [
        'page in fr',
        'page in fr',
        'page in de',
        'page in *', // fetch's default Accept-Language
      ]);
      assert.strictEqual(calls, 3);
    });

    it('tells a missing header from an empty one', async () => {
      app = await listen([duplicateHandler()], async (req, res) => {
        calls++;
        await sleep(100);
        res.setHeader('Vary', 'X-Mode');
        res.end(Object.hasOwn(req.headers, 'x-mode') ? 'present' : 'absent');
      });
      const bodies = await Promise.all([
        get(`${app.url}/a`).then((res) => res.body),
        get(`${app.url}/a`, { headers: { 'x-mode': '' } }).then(
          (res) => res.body
        ),
      ]);
      assert.deepStrictEqual(bodies, ['absent', 'present']);
      assert.strictEqual(calls, 2);
    });

    it('reads Vary given to writeHead', async () => {
      app = await listen(
        [duplicateHandler()],
        languageHandler((res) =>
          res.writeHead(200, ['Vary', 'Accept-Language'])
        )
      );
      assert.deepStrictEqual(await fetchLanguages(['fr', 'de']), [
        'page in fr',
        'page in de',
      ]);
    });

    it('shares nothing with Vary: *', async () => {
      app = await listen(
        [duplicateHandler()],
        languageHandler((res) => res.setHeader('Vary', '*'))
      );
      await fetchLanguages(['fr', 'fr']);
      assert.strictEqual(calls, 2);
    });

    it('ignores Vary: Accept-Encoding', async () => {
      app = await listen(
        [duplicateHandler()],
        languageHandler((res) => res.setHeader('Vary', 'Accept-Encoding'))
      );
      assert.deepStrictEqual(await fetchLanguages(['fr', 'de']), [
        'page in fr',
        'page in fr',
      ]);
      assert.strictEqual(calls, 1);
    });
  });

  it('processes different hosts separately', async () => {
    app = await listen([duplicateHandler()], slowHandler);
    // fetch doesn't let the Host header be changed
    const request = (host) =>
      new Promise((resolve) => {
        http
          .get(`${app.url}/a`, { headers: { host } }, (res) => {
            res.resume();
            res.on('end', resolve);
          })
          .end();
      });
    await Promise.all([request('a.example'), request('b.example')]);
    assert.strictEqual(calls, 2);
  });
});
