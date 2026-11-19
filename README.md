# Hyperwatch Middlewares

Node.js HTTP middlewares (Express, Connect or plain `http`) to protect a server from heavy traffic. Node.js 24 or later, TypeScript declarations included.

```sh
npm install @hyperwatch/middlewares
```

## Duplicate handler

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

| Option             | Default              | Description                                                                               |
| ------------------ | -------------------- | ----------------------------------------------------------------------------------------- |
| `methods`          | `GET`, `HEAD`        | Methods whose requests can be shared                                                      |
| `shareCredentials` | `false`              | Also share requests carrying a cookie or an `Authorization` header                        |
| `skip`             | none                 | `(req) => boolean`, true processes the request normally, on top of the above              |
| `key`              | method, host and URL | `(req) => string`, requests with the same key are duplicates                              |
| `timeout`          | `30`                 | Seconds after which requests still waiting for a response that hasn't started get a `503` |

What is never shared:

- Requests carrying credentials, unless `shareCredentials`: their responses can depend on who asks.
- A response that already started: a request arriving then is processed on its own.
- A response that sets a cookie: it was made for one client. Requests waiting for it are processed on their own.
- A response with `Vary`, to requests that differ from the first one in a header it names (as an HTTP cache would): those are processed on their own. `Vary: *` shares nothing. `Accept-Encoding` is ignored: a shared response is passed on uncompressed, compression middleware compresses the first one only.

If the first response hasn't started after `timeout` (the application hangs, or gave up when its client left), the requests waiting for it all get a `503` at once. A response that started is left to finish.

## Service limiter

Turns identified robots away with a `503` while a server warms up (fresh caches, just deployed), or while a level set from outside says so:

| Level    | Served                                         |
| -------- | ---------------------------------------------- |
| < 50     | Unidentified requests and essential identities |
| 50 to 99 | Everything except the non-essential identities |
| 100      | Everything                                     |

Requests without an identity are never limited: people can't be told apart from unverified robots.

```js
const { serviceLimiter } = require('@hyperwatch/middlewares');

const limiter = serviceLimiter({
  essentialIdentities: ['Facebook', 'Pingdom', 'Twitter'],
  nonEssentialIdentities: ['Ahrefs', 'PetalBot', 'Semrush'],
  message: 'Service Limited. Try again later.',
});

app.use(limiter);

server.listen(port, () => {
  limiter.warmUp([
    { after: 30, level: 50 },
    { after: 180, level: 100 },
  ]);
});
```

| Option                   | Default                                             | Description                                                                |
| ------------------------ | --------------------------------------------------- | -------------------------------------------------------------------------- |
| `essentialIdentities`    | `[]`                                                | Served from level 0                                                        |
| `nonEssentialIdentities` | `[]`                                                | Served only at level 100                                                   |
| `initialLevel`           | `0`                                                 | Warm-up level at creation                                                  |
| `getIdentity`            | `req.identity`, else `req.hyperwatch.getIdentity()` | `(req) => identity`, may be async                                          |
| `store`                  | in memory                                           | Where the manual level is kept: `{ get, set }`, async                      |
| `refreshInterval`        | `5`                                                 | Seconds between two reads of the store                                     |
| `retryAfter`             | none                                                | Seconds for `Retry-After` when a manual level without end limits a request |
| `onLimited`              | a `503` with `message`, `Retry-After` when known    | `(req, res, { level, warmingUp, retryAfter }) => void`                     |
| `message`                | `Service Limited. Try again later.`                 | Body of the default `503`                                                  |

Levels go from 0 to 100: other values throw a `RangeError`, and an invalid value read from the store is ignored. The level applied is the lower of two:

- **Warm-up level**, per process: `warmUp(steps)` raises it step by step (`after` in seconds), `increaseServiceLevel(level)` at once. A request limited while warming up gets `Retry-After` with the seconds until the step that serves it: 30 for an identified robot and 180 for a non-essential one above.
- **Manual level**, shared by every process using the same `store`: `setServiceLevel(level, { until })` and `clearServiceLevel()`, for instance from an admin endpoint. Each process reads the store every `refreshInterval` seconds, and keeps the last level it read if the store fails. At start, requests wait for the first read, 1 second at most. A new `warmUp()` replaces the previous schedule. A manual level can only restrict, never cut a warm-up short. A request it limits gets `Retry-After` until `until`, else the `retryAfter` option, else none.

`getServiceLevel()` returns the level applied. [Google's crawlers read `Retry-After`](https://developers.google.com/search/docs/guides/reduce-crawl-rate).

A store shared through Redis:

```js
const store = {
  get: async () => JSON.parse((await redis.get('service-level')) ?? 'null'),
  set: async (value) => {
    await redis.set('service-level', JSON.stringify(value));
  },
};
```

The identities are [Hyperwatch](https://github.com/hyperwatch/hyperwatch) identities: a request only has one once its origin is verified. With Hyperwatch's Express input, define `req.hyperwatch.getIdentity` from the augmented log, or pass your own `getIdentity`.

## License

Apache-2.0
