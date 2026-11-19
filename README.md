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

| Option             | Default        | Description                                                                               |
| ------------------ | -------------- | ----------------------------------------------------------------------------------------- |
| `methods`          | `GET`, `HEAD`  | Methods whose requests can be shared                                                      |
| `shareCredentials` | `false`        | Also share requests carrying a cookie or an `Authorization` header                        |
| `skip`             | none           | `(req) => boolean`, true processes the request normally, on top of the above              |
| `key`              | method and URL | `(req) => string`, requests with the same key are duplicates                              |
| `timeout`          | `30`           | Seconds after which requests still waiting for a response that hasn't started get a `503` |

What is never shared:

- Requests carrying credentials, unless `shareCredentials`: their responses can depend on who asks.
- A response that already started: a request arriving then is processed on its own.
- A response that sets a cookie: it was made for one client. Requests waiting for it are processed on their own.

If the first response hasn't started after `timeout` (the application hangs, or gave up when its client left), the requests waiting for it all get a `503` at once. A response that started is left to finish.

## Service limiter

Turns identified robots away with a `503` while a server warms up (fresh caches, just deployed). The service level starts at `initialLevel` and only goes up:

| Level    | Served                                         |
| -------- | ---------------------------------------------- |
| < 50     | Unidentified requests and essential identities |
| 50 to 99 | Everything except the non-essential identities |
| 100      | Everything                                     |

```js
const { serviceLimiter } = require('@hyperwatch/middlewares');

const limiter = serviceLimiter({
  essentialIdentities: ['Facebook', 'Pingdom', 'Twitter'],
  nonEssentialIdentities: ['Ahrefs', 'PetalBot', 'Semrush'],
  message: 'Service Limited. Try again later.',
});

app.use(limiter);

server.listen(port, () => {
  setTimeout(() => limiter.increaseServiceLevel(50), 30 * 1000);
  setTimeout(() => limiter.increaseServiceLevel(100), 3 * 60 * 1000);
});
```

| Option                   | Default                                             | Description                       |
| ------------------------ | --------------------------------------------------- | --------------------------------- |
| `essentialIdentities`    | `[]`                                                | Served from level 0               |
| `nonEssentialIdentities` | `[]`                                                | Served only at level 100          |
| `initialLevel`           | `0`                                                 |                                   |
| `getIdentity`            | `req.identity`, else `req.hyperwatch.getIdentity()` | `(req) => identity`, may be async |
| `onLimited`              | a `503` with `message`                              | `(req, res) => void`              |
| `message`                | `Service Limited. Try again later.`                 | Body of the default `503`         |

The identities are [Hyperwatch](https://github.com/hyperwatch/hyperwatch) identities: a request only has one once its origin is verified. With Hyperwatch's Express input, define `req.hyperwatch.getIdentity` from the augmented log, or pass your own `getIdentity`.

The limiter object also has `getServiceLevel()`.

## License

Apache-2.0
