# Hyperwatch Middlewares

Node.js HTTP middlewares (Express, Connect or plain `http`) to protect a server from heavy traffic. Node.js 24 or later, TypeScript declarations included.

```sh
npm install @hyperwatch/middlewares
```

## Duplicate handler

Identical requests arriving while the first one is still being processed wait for it and get a copy of its response, instead of being processed again. Useful when a crawler or a burst of visitors asks for the same expensive page at once.

```js
const { duplicateHandler } = require('@hyperwatch/middlewares');

app.use(duplicateHandler());
```

Only `GET` and `HEAD` requests without credentials are shared, and never a response that sets a cookie.

[Documentation](docs/duplicate-handler.md): options, what is never shared, where to mount it, limits.

## Service limiter

Turns verified robots away with a `503` and `Retry-After` while a server warms up (fresh caches, just deployed), the least important the longest. People are never turned away.

```js
const { serviceLimiter } = require('@hyperwatch/middlewares');

const limiter = serviceLimiter();

// After Hyperwatch's Express input, which says who each request is from
app.use(limiter);

server.listen(port, () => {
  // From now: high priority only. After 30 s: normal too. After 3 min: everything.
  limiter.warmUp([
    { after: 30, serve: 'normal' },
    { after: 180, serve: 'low' },
  ]);
});
```

The priority of a request is decided by a function, `classify`, from the identity [Hyperwatch](https://github.com/hyperwatch/hyperwatch) verified and the kind of robot it is. The default is a few readable lines, to use as it is, wrap or copy.

[Documentation](docs/service-limiter.md): setup with Hyperwatch, the default policy, your own policy, options, failures, limits.

## License

Apache-2.0
