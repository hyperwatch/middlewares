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

Turns verified robots away with a `503` while a server warms up (fresh caches, just deployed), the least important the longest. People are never turned away.

Each request gets a **priority**, and the limiter serves down to one of them:

```js
const { serviceLimiter } = require('@hyperwatch/middlewares');

const limiter = serviceLimiter({
  // Most important first
  priorities: ['high', 'normal', 'low'],

  classify({ identity, category, req }) {
    // People, and clients that aren't verified: never limited
    if (!identity) {
      return;
    }
    // Someone is waiting: link previews, uptime checks
    if (['social-preview', 'monitoring'].includes(category)) {
      return 'high';
    }
    // Usually able to wait
    if (
      ['seo', 'marketing', 'ai-training', 'archive', 'research'].includes(
        category
      )
    ) {
      return 'low';
    }
    // Everything else that is identified: other robots, and what we know nothing about
    return 'normal';
  },
});

app.use(limiter);

server.listen(port, () => {
  // From now: high only. After 30 s: normal too. After 3 min: everything.
  limiter.warmUp([
    { after: 30, serve: 'normal' },
    { after: 180, serve: 'low' },
  ]);
});
```

What is written above is the default: `serviceLimiter()` alone does the same. A limited request gets a `503` with `Retry-After`, the seconds left until the step that serves its priority ([Google's crawlers read it](https://developers.google.com/search/docs/guides/reduce-crawl-rate)).

- Until `warmUp()` is called, everything is served.
- The first priority is always served.
- A request `classify` gives no priority to (`undefined` or `null`) is never limited.
- `limiter.serving()` returns the lowest priority served now.

The `identity` and the `category` come from [Hyperwatch](https://github.com/hyperwatch/hyperwatch): a request only has an identity once its origin is verified, and the category is the kind of robot it is in the [robots database](https://github.com/hyperwatch/database). <!-- TODO at release: the Hyperwatch version that sets `category` --> With a Hyperwatch that doesn't set `category`, every identified request is `normal`.

### Your own policy

`classify` is plain code: its precedence is the order of its lines.

**One exception, keeping the default.** The default improves with releases, and this keeps following it:

```js
const { serviceLimiter, defaultClassify } = require('@hyperwatch/middlewares');

const limiter = serviceLimiter({
  classify(context) {
    if (context.identity === 'PetalBot') {
      return 'low';
    }
    return defaultClassify(context);
  },
});
```

**The whole policy.** Copy the function above and change it. Your copy no longer follows the package: a new robot in a category you list needs nothing, a new category is whatever your last line says.

**Other priorities.** Give your own names, and a `classify` that returns them:

```js
serviceLimiter({
  priorities: ['critical', 'high', 'normal', 'low'],
  classify({ identity, category }) {
    if (!identity) {
      return;
    }
    if (category === 'monitoring') {
      return 'critical';
    }
    return defaultClassify({ identity, category });
  },
});
```

### Options

| Option       | Default                              | Description                                                                                             |
| ------------ | ------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| `priorities` | `['high', 'normal', 'low']`          | Ordered names, most important first                                                                     |
| `classify`   | `defaultClassify`                    | `({ identity, category, req }) => priority`, may be async                                               |
| `skip`       | none                                 | `(req) => boolean`, synchronous, runs first: true passes the request without identifying it             |
| `identify`   | from Hyperwatch, else `req.identity` | `(req) => ({ identity, category })`, may be async                                                       |
| `timeout`    | `1`                                  | Seconds `identify` and `classify` get together                                                          |
| `respond`    | a `503`, `Retry-After`, `message`    | `(req, res, limited) => void`: the response to a limited request                                        |
| `message`    | `Service Limited. Try again later.`  | Body of the default response                                                                            |
| `onLimited`  | none                                 | `(req, limited) => void`: told of each limited request, for logs and counts; the response is still sent |
| `onError`    | a warning, once per kind             | `(error, { kind, req }) => void`: told when a request is served because the limiter failed              |

`limited` is `{ identity, category, priority, serving, retryAfter }`.

Use `skip` for routes that must answer whatever happens (health checks, webhooks): it runs before the request is identified.

### `warmUp(steps)`

Called once, usually when the server starts listening. From then, only the first priority is served; each step serves down to `serve` once `after` seconds have passed.

- Each step must come later and serve more than the one before. Invalid steps throw and change nothing.
- `warmUp([])` serves the first priority only, for good.
- If the last step isn't the last priority, the rest stays limited as long as the limiter lives, without `Retry-After`. That is how a deploy caps the service.
- A second call throws.

### When the limiter itself fails

A mistake in the limiter must not take requests down, so the request is served when:

- `identify` or `classify` throws, rejects, or doesn't answer within `timeout` (kinds `identify`, `classify`, `timeout`);
- `classify` returns something that isn't one of `priorities` (kind `priority`).

Each case goes to `onError`. **A typo in a priority name therefore turns limiting off for those requests:** the default `onError` warns about it once per kind (`process.emitWarning`), so watch the logs when you change `classify`.

Errors thrown by `skip`, `respond`, `onLimited` and `onError` are yours: they go to `next(err)`.

### What it is not

- **Not overload protection.** Clients without an identity always pass, and a priority is released at a set time whatever the load.
- **Per process.** Each process counts from its own `warmUp()`. During a rolling deploy processes differ, and a retry can reach a younger one and be refused again: `Retry-After` is an estimate.
- **Not access control.** An identity is as strong as Hyperwatch's check for it, and the category is the kind of robot the request claims to be within a verified operator.
- **Not immediate for every robot.** The default `identify` asks Hyperwatch for a fast answer, without waiting for reverse DNS: a robot verified by its hostname passes until that lookup is cached. Robots verified by address list or by signature are identified at once.

## License

Apache-2.0
