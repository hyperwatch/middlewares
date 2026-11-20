# Duplicate handler

Identical requests arriving while the first one is still being processed wait for it and get a copy of its response, instead of being processed again. Useful when a crawler or a burst of visitors asks for the same expensive page at once.

```js
const { duplicateHandler } = require('@hyperwatch/middlewares');

app.use(
  duplicateHandler({
    // Pages that are never worth sharing
    skip: (req) => req.url.startsWith('/dashboard'),
  })
);
```

With plain `http`:

```js
const handle = duplicateHandler();

http.createServer((req, res) => {
  handle(req, res, () => {
    // The request is processed here: it is the first one, or it isn't shared
  });
});
```

## How it works

- The first request with a given key is processed normally.
- A request with the same key arriving before that response starts waits, and isn't processed.
- When the response starts, the waiting requests get its status and headers, then everything written to it, as it is written.
- Any response is shared, errors included: if the first request ends with a `500`, so do the ones waiting for it.

Nothing is cached: once the first response has started, the next identical request is processed on its own.

## Options

| Option             | Default              | Description                                                                               |
| ------------------ | -------------------- | ----------------------------------------------------------------------------------------- |
| `methods`          | `GET`, `HEAD`        | Methods whose requests can be shared                                                      |
| `shareCredentials` | `false`              | Also share requests carrying a cookie or an `Authorization` header                        |
| `skip`             | none                 | `(req) => boolean`, true processes the request normally, on top of the above              |
| `key`              | method, host and URL | `(req) => string`, requests with the same key are duplicates                              |
| `timeout`          | `30`                 | Seconds after which requests still waiting for a response that hasn't started get a `503` |

The default key is the method, the `Host` header and the URL with its query string: a `HEAD` never shares the response of a `GET`. Give your own `key` to treat more requests as identical, for instance to ignore tracking parameters:

```js
duplicateHandler({
  key(req) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    for (const name of [...url.searchParams.keys()]) {
      if (name.startsWith('utm_')) {
        url.searchParams.delete(name);
      }
    }
    return `${req.method} ${url.host}${url.pathname}${url.search}`;
  },
});
```

A key must cover everything the response depends on. If pages depend on a header (language, device), either the response says so with `Vary` (see below) or the key includes that header.

## What is never shared

- Requests carrying credentials, unless `shareCredentials`: their responses can depend on who asks.
- A response that already started: a request arriving then is processed on its own.
- A response that sets a cookie: it was made for one client. Requests waiting for it are processed on their own.
- A response with `Vary`, to requests that differ from the first one in a header it names (as an HTTP cache would): those are processed on their own. A missing header differs from an empty one, and `Vary: *` shares nothing.

## Timeout

If the first response hasn't started after `timeout` (the application hangs, or gave up when its client left), the requests waiting for it all get a `503` at once. A response that started is left to finish.

## Where to mount it

**After everything that answers depending on who asks**: authentication, rate limiting, the [service limiter](service-limiter.md). A response is shared with whoever waits for it. If the service limiter came after the duplicate handler, the `503` it gives a robot would be copied to the people who asked for the same page at that moment.

**Before the routes** it protects.

**Compression** works on either side, with a different result:

| Compression is mounted | The first response | The shared ones                                         |
| ---------------------- | ------------------ | ------------------------------------------------------- |
| before the handler     | compressed         | compressed, each according to its own `Accept-Encoding` |
| after the handler      | compressed         | not compressed                                          |

That is why `Accept-Encoding` in `Vary` is ignored: what is shared is the response as the application wrote it, before compression. Frameworks that compress on their own (Next.js) are in the second case.

## Limits

- **Per process.** Each process shares the requests it receives; identical requests reaching two processes are processed twice.
- **A response cut after it started.** If the first response is destroyed before its end (an error while streaming), the requests sharing it have received the same beginning and are not ended: they stay open until their clients give up.
- **Memory.** Nothing is buffered: what the application writes is passed on as it is written.

## Debugging

`DEBUG=hyperwatch:duplicate-handler` logs each duplicate detected and each timeout, with the [debug](https://www.npmjs.com/package/debug) package.

## TypeScript

The options are exported as `DuplicateHandlerOptions`, the middleware as `Middleware`.
