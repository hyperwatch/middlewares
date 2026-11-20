# Service limiter

Turns verified robots away with a `503` while a server warms up (fresh caches, just deployed), the least important the longest. People are never turned away.

Each request gets a **priority**, and the limiter serves down to one of them:

```js
const { serviceLimiter } = require('@hyperwatch/middlewares');

const limiter = serviceLimiter();

app.use(limiter);

server.listen(port, () => {
  // From now: high only. After 30 s: normal too. After 3 min: everything.
  limiter.warmUp([
    { after: 30, serve: 'normal' },
    { after: 180, serve: 'low' },
  ]);
});
```

A limited request gets a `503` with `Retry-After`, the seconds left until the step that serves its priority ([Google's crawlers read it](https://developers.google.com/search/docs/guides/reduce-crawl-rate)).

- Until `warmUp()` is called, everything is served.
- The first priority is always served.
- A request without a priority is never limited.
- `limiter.serving()` returns the lowest priority served now.

## Setup with Hyperwatch

The limiter needs to know who a request is from. By default it asks [Hyperwatch](https://github.com/hyperwatch/hyperwatch), through its Express input, for the `identity` (set only once the origin of the request is verified) and the `category` (the kind of robot it is in the [robots database](https://github.com/hyperwatch/database)).

```js
const hyperwatch = require('@hyperwatch/hyperwatch');
const { serviceLimiter } = require('@hyperwatch/middlewares');

hyperwatch.init({
  modules: {
    // What the identity module depends on, and itself
    agent: { active: true },
    hostname: { active: true },
    address: { active: true },
    signature: { active: true },
    webbotauth: { active: true },
    identity: { active: true },
  },
});

// First: the input, which sets req.hyperwatch
const input = hyperwatch.input.express.create();
app.use(input.middleware());
hyperwatch.pipeline.registerInput(input);

// Then the limiter
const limiter = serviceLimiter();
app.use(limiter);
```

See Hyperwatch's [Express embedding](https://github.com/hyperwatch/hyperwatch/blob/main/docs/express-embedding.md) for the rest (starting it, mounting its API).

- **Order matters.** Mounted before the input, the limiter finds no `req.hyperwatch`, no identity, and serves every request without saying so.
- **`category`.** <!-- TODO at release: the Hyperwatch version that sets `category` --> With a Hyperwatch that doesn't set `category`, every identified request is `normal`.
- **Hostname lookups.** The limiter asks Hyperwatch for a fast answer, without waiting for reverse DNS: a robot verified by its hostname passes until that lookup is cached. Robots verified by address list or by signature are identified at once.

### Without Hyperwatch

Without `req.hyperwatch`, the limiter reads `req.identity`, which a middleware of yours can set. Or give `identify`:

```js
serviceLimiter({
  // May be async. Only name what you verified: a user agent alone proves nothing
  identify(req) {
    return isOurMonitoring(req)
      ? { identity: 'Our monitoring', category: 'monitoring' }
      : undefined;
  },
});
```

## The default policy

`serviceLimiter()` alone is the same as:

```js
serviceLimiter({
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
```

The categories Hyperwatch sets, and where the default puts them:

| Category         | Examples of identities               | Default priority |
| ---------------- | ------------------------------------ | ---------------- |
| `social-preview` | Slack, Discord, Facebook, LinkedIn   | `high`           |
| `monitoring`     | Pingdom, Uptime Robot, Sentry        | `high`           |
| `search-engine`  | Googlebot, Bing, Applebot, Baidu     | `normal`         |
| `ai-search`      | OpenAI SearchBot, Amazon SearchBot   | `normal`         |
| `ai-assistant`   | ChatGPT, ChatGPT Agent, Google Agent | `normal`         |
| `other`          | Stripe, GitHub Camo, Shields.io      | `normal`         |
| `unknown`        | Bytespider, TikTok                   | `normal`         |
| none             | PayPal, Wise                         | `normal`         |
| `seo`            | Ahrefs, Majestic, Moz                | `low`            |
| `marketing`      | Comscore, Dataprovider.com           | `low`            |
| `ai-training`    | OpenAI GPTBot, ClaudeBot, Amazonbot  | `low`            |
| `archive`        | Archive.org, Common Crawl            | `low`            |
| `research`       | CMU, NICT                            | `low`            |

An identity can have robots of several kinds (Ahrefs: `seo` for AhrefsBot, `search-engine` for YepBot). Hyperwatch then gives the category of the robot the request claims to be, or none.

## Your own policy

`classify` is plain code: its precedence is the order of its lines. It returns one of `priorities`, or nothing (`undefined` or `null`) for a request that is never limited. It may be async.

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

`priorities` without `high`, `normal` or `low` need their own `classify`: the default one answers with those names.

## Options

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

Invalid options throw when the limiter is created: `priorities` that aren't unique, non-empty names, a `timeout` that isn't a positive number.

`limited` is what a limited request is told:

| Field        | Description                                                                      |
| ------------ | -------------------------------------------------------------------------------- |
| `identity`   | As identified                                                                    |
| `category`   | As identified                                                                    |
| `priority`   | The request's priority                                                           |
| `serving`    | The lowest priority served now                                                   |
| `retryAfter` | Seconds until the step serving this priority; `undefined` when no step ever does |

Counting what is limited, and answering in your own way:

```js
serviceLimiter({
  onLimited(req, { identity, priority, serving }) {
    logger.info(`Limited ${identity} (${priority}), serving ${serving}`);
  },
  respond(req, res, { retryAfter }) {
    res.statusCode = 503;
    if (retryAfter !== undefined) {
      res.setHeader('Retry-After', String(retryAfter));
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'warming up' }));
  },
});
```

Use `skip` for routes that must answer whatever happens (health checks, webhooks): it runs before the request is identified.

```js
serviceLimiter({ skip: (req) => req.url === '/health' });
```

## `warmUp(steps)`

Called once, usually when the server starts listening. From then, only the first priority is served; each step serves down to `serve` once `after` seconds have passed.

- Each step must come later and serve more than the one before. Invalid steps throw and change nothing.
- `warmUp([])` serves the first priority only, for good.
- If the last step isn't the last priority, the rest stays limited as long as the limiter lives, without `Retry-After`. That is how a deploy caps the service.
- A second call throws: the steps can't be changed afterwards, nor the service limited again. See [#4](https://github.com/hyperwatch/middlewares/issues/4) for a restriction set from outside.

The state is computed from the time elapsed since `warmUp()`, not set by timers.

While everything is served (before `warmUp()`, and after a last step serving the last priority), the limiter passes requests straight on: `identify` and `classify` are not called.

## Where to mount it

1. Hyperwatch's Express input, which identifies requests.
2. The service limiter.
3. The [duplicate handler](duplicate-handler.md), which shares a response between the requests waiting for it: mounted before the limiter, it would copy the `503` given to a robot to the people asking for the same page.
4. The routes.

## When the limiter itself fails

A mistake in the limiter must not take requests down, so the request is served when:

- `identify` or `classify` throws, rejects, or doesn't answer within `timeout` (kinds `identify`, `classify`, `timeout`);
- `classify` returns something that isn't one of `priorities` (kind `priority`).

Each case goes to `onError`. **A typo in a priority name therefore turns limiting off for those requests.** The default `onError` warns about it once per kind with `process.emitWarning`, so watch the logs when you change `classify`. The warnings have the codes `HYPERWATCH_SERVICE_LIMITER_IDENTIFY`, `_CLASSIFY`, `_PRIORITY` and `_TIMEOUT`.

Errors thrown by `skip`, `respond`, `onLimited` and `onError` are yours: they go to `next(err)`.

## What it is not

- **Not overload protection.** Clients without an identity always pass, and a priority is released at a set time whatever the load.
- **Per process.** Each process counts from its own `warmUp()`. During a rolling deploy processes differ, and a retry can reach a younger one and be refused again: `Retry-After` is an estimate.
- **Not access control.** An identity is as strong as Hyperwatch's check for it, and the category is the kind of robot the request claims to be within a verified operator.
- **Not immediate for every robot.** See _Hostname lookups_ above.

## Debugging

`DEBUG=hyperwatch:service-limiter` logs each limited request, each failure and the start of the warm-up, with the [debug](https://www.npmjs.com/package/debug) package.

## TypeScript

Exported types: `ServiceLimiter` (the middleware with `warmUp` and `serving`), `ServiceLimiterOptions`, `ClassifyContext`, `Robot` (what `identify` returns), `Limited` and `WarmUpStep`.
