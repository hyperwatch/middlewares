const assert = require('node:assert');
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
});
