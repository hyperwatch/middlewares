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
    // Responses for logged-in users must never be shared
    skip: (req) => Boolean(req.headers.cookie || req.headers.authorization),
  })
);
```

| Option    | Default        | Description                                                  |
| --------- | -------------- | ------------------------------------------------------------ |
| `skip`    | none           | `(req) => boolean`, true processes the request normally      |
| `key`     | method and URL | `(req) => string`, requests with the same key are duplicates |
| `timeout` | `30`           | Seconds after which a pending request is forgotten           |

A request is processed on its own when the response it would join has already started, or sets a cookie: such a response was made for one client. If the cookie only appears once requests are waiting, they are all processed on their own. Requests that carry credentials (cookies, `Authorization`) should still be skipped: their responses can depend on who asks without setting a cookie.

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
