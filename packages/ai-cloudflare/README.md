> [!WARNING]
> Auth0 AI is currently **under heavy development**. We strictly follow [Semantic Versioning (SemVer)](https://semver.org/), meaning all **breaking changes will only occur in major versions**. However, please note that during this early phase, **major versions may be released frequently** as the API evolves. We recommend locking versions when using this in production.

This package contains helper methods for the [Cloudflare Agents](https://developers.cloudflare.com/agents/) SDK. 

Please note that most examples for Cloudflare Agents use the [Vercel AI SDK](https://ai-sdk.dev/).

We will provide a full sample and template to get started with Cloudflare Agents.

## Installation

```
npm i @auth0/ai-cloudflare @auth0/ai-vercel @auth0/ai
```

## Interrupt handling in react

This module provides a custom React hook `useAgentChatInterruptions` that extends the functionality of the `useAgentChat` hook from the "agent/ai-react" module. It allows you to handle tool interruptions in your agent chat.

Replace `useAgentChat` with `useAgentChatInterruptions` in your code to get access to `toolInterrupt`.

```js
  const {
    messages: agentMessages,
    input: agentInput,
    handleInputChange: handleAgentInputChange,
    handleSubmit: handleAgentSubmit,
    addToolResult,
    clearHistory,
    toolInterrupt,
  } = useAgentChatInterruptions({
    agent,
    id: threadID,
  });
```

## Async User Confirmation resumer

This module provides the `AsyncUserConfirmationResumer` mixin that can extend `AIChatAgent` to handle user confirmations asynchronously. 

This work with the `withAsyncAuthorization` authorizer and allow the agent to continue processing after the user has confirmed the action.

```js
import { AsyncUserConfirmationResumer } from '@auth0/ai-cloudflare';

export class Chat extends AsyncUserConfirmationResumer(AIChatAgent) {
 // Your agent implementation
}
```

Then when defining the authorizer:

```js
export const withAsyncAuthorization = auth0AI.withAsyncAuthorization({
  // The authorizer configuration
  onAuthorizationInterrupt: async (interrupt, context) => {
    const { agent } = getCurrentAgent<Chat>();
    agent?.schedulePoller({ interrupt, context });
  },
});
```

## CloudflareKVStore

This module provides `CloudflareKVStore`. An implementation of auth0-ai `Store` interface that uses Cloudflare Workers KV to store and retrieve data. The `kv` option should be a reference to your [Cloudflare KV namespace](https://developers.cloudflare.com/kv/get-started/#5-access-your-kv-namespace-from-your-worker) or a compatible store.

```js
import { CloudflareKVStore } from '@auth0/ai-cloudflare';
const kvStore = new CloudflareKVStore({
  kv: env.Auth0AINamespace, // The KV namespace to use
});
```


## Feedback

### Contributing

We appreciate feedback and contribution to this repo! Before you get started, please see the following:

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
