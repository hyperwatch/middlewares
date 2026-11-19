const http = require('node:http');

// A server running `middlewares` in order, then `handler`
async function listen(middlewares, handler) {
  const server = http.createServer((req, res) => {
    let i = 0;
    const next = (err) => {
      if (err) {
        res.statusCode = 500;
        res.end(String(err.message));
        return;
      }
      const middleware = middlewares[i++];
      if (middleware) {
        middleware(req, res, next);
      } else {
        handler(req, res);
      }
    };
    next();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { server, url, close: () => server.close() };
}

async function get(url, options) {
  const res = await fetch(url, options);
  return { status: res.status, headers: res.headers, body: await res.text() };
}

module.exports = { listen, get };
