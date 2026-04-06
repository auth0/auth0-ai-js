# Redis Store for Auth0 AI

`@auth0/ai-redis` is a secure Redis-based data store implementation for the [Auth0 AI SDK](https://github.com/auth0/auth0-ai-js/).

## Install

> [!WARNING]
> `@auth0/ai-redis` is currently **under heavy development**. We strictly follow [Semantic Versioning (SemVer)](https://semver.org/), meaning all **breaking changes will only occur in major versions**. However, please note that during this early phase, **major versions may be released frequently** as the API evolves. We recommend locking versions when using this in production.

```
$ npm install @auth0/ai-redis
```

## Usage

Initialize the Redis store and use it with the Auth0 AI SDK:

```typescript
import { RedisStore } from "@auth0/ai-redis";
import { Auth0AI } from "@auth0/ai-vercel"; //or ai-langchain, etc.

const auth0AI = new Auth0AI({
  store: new RedisStore({
    encryption: {
      key: "YOUR_ENCRYPTION_KEY",
      alg: "aes-256-cbc",
    },
  }),
});
```

### RedisStore Options

The `RedisStore` constructor accepts the following options:

- **client**: An existing `ioredis` client instance.
- **encryption** (optional): Configuration for encrypting data stored in Redis.
  - `key`: The encryption key (required if `encryption` is provided).
  - `alg`: The encryption algorithm. Supported values are `aes-256-cbc`, `aes-192-cbc`, and `aes-128-cbc`. Defaults to `aes-256-cbc`.

Alternatively, you can pass a configuration object compatible with `ioredis` to initialize a new Redis client.

### Example with an Existing Redis Client

```typescript
import { Redis } from "ioredis";
import { RedisStore } from "@auth0/ai-redis";

const redisClient = new Redis();

const store = new RedisStore({
  client: redisClient, //Optional: Default to `new Redis()`
  encryption: {
    key: "YOUR_ENCRYPTION_KEY",
  },
});
```

## Features

- **Encryption**: Securely encrypts data before storing it in Redis.
- **Namespace Support**: Organize keys using namespaces.
- **Expiration**: Supports setting expiration times for stored data.

## Feedback

### Contributing

We appreciate feedback and contributions to this repo! Before you get started, please see the following:

- [Auth0's general contribution guidelines](https://github.com/auth0/open-source-template/blob/master/GENERAL-CONTRIBUTING.md)
- [Auth0's code of conduct guidelines](https://github.com/auth0/open-source-template/blob/master/CODE-OF-CONDUCT.md)

### Raise an issue

To provide feedback or report a bug, please [raise an issue on our issue tracker](https://github.com/auth0/auth0-ai-js/issues).

### Vulnerability Reporting

Please do not report security vulnerabilities on the public GitHub issue tracker. The [Responsible Disclosure Program](https://auth0.com/responsible-disclosure-policy) details the procedure for disclosing security issues.

---

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: light)" srcset="https://cdn.auth0.com/website/sdks/logos/auth0_light_mode.png"   width="150">
    <source media="(prefers-color-scheme: dark)" srcset="https://cdn.auth0.com/website/sdks/logos/auth0_dark_mode.png" width="150">
    <img alt="Auth0 Logo" src="https://cdn.auth0.com/website/sdks/logos/auth0_light_mode.png" width="150">
  </picture>
</p>
<p align="center">Auth0 is an easy to implement, adaptable authentication and authorization platform. To learn more checkout <a href="https://auth0.com/why-auth0">Why Auth0?</a></p>
<p align="center">
This project is licensed under the Apache 2.0 license. See the <a href="/LICENSE"> LICENSE</a> file for more info.</p>
