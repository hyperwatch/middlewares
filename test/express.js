const assert = require('node:assert');

const express = require('express');

const { duplicateHandler, serviceLimiter } = require('../src');

describe('with Express', () => {
  let server, url, calls;

  before(async () => {
    calls = 0;
    const app = express();
    app.use(serviceLimiter({ getIdentity: (req) => req.get('x-identity') }));
    app.use(duplicateHandler());
    app.get('/page', (req, res) => {
      calls++;
      setTimeout(() => res.status(201).type('html').send('<b>hi</b>'), 100);
    });
    await new Promise((resolve) => {
      server = app.listen(0, '127.0.0.1', resolve);
    });
    url = `http://127.0.0.1:${server.address().port}/page`;
  });

  after(() => server.close());

  it('shares the response of res.send', async () => {
    const responses = await Promise.all(
      [1, 2, 3].map(async () => {
        const res = await fetch(url);
        return [res.status, res.headers.get('content-type'), await res.text()];
      })
    );
    assert.strictEqual(calls, 1);
    assert.deepStrictEqual(responses, [
      [201, 'text/html; charset=utf-8', '<b>hi</b>'],
      [201, 'text/html; charset=utf-8', '<b>hi</b>'],
      [201, 'text/html; charset=utf-8', '<b>hi</b>'],
    ]);
  });

  it('limits an identified robot', async () => {
    const res = await fetch(url, { headers: { 'x-identity': 'Googlebot' } });
    assert.strictEqual(res.status, 503);
  });
});
