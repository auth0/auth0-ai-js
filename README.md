# Auth0 AI for JavaScript

> [!WARNING]
> Auth0 AI is currently **under heavy development**. We strictly follow [Semantic Versioning (SemVer)](https://semver.org/), meaning all **breaking changes will only occur in major versions**. However, please note that during this early phase, **major versions may be released frequently** as the API evolves. We recommend locking versions when using this in production.

[Auth0 AI](https://www.auth0.ai/) helps you build secure AI-powered
applications.

Developers are using LLMs to build generative AI applications that deliver
powerful new experiences for customers and employees. Maintaining security and
privacy while allowing AI agents to assist people in their work and lives is a
critical need. Auth0 AI helps you meet these requirements, ensuring that agents
are properly authorized when taking actions or accessing resources on behalf of
a person or organization. Common use cases include:

- **Authenticate users**: Easily implement login experiences, tailor made for
  AI agents and assistants.
- **Call APIs on users' behalf**: Use secure standards to call APIs from tools,
  integrating your app with other products.
- **Authorization for RAG**: Generate more relevant responses while ensuring
  that the agent is only incorporating information that the user has access to.
- **Async user confirmation**: Allow agents to operate autonomously in the
  background while requiring human approval when needed.

## Packages

- [`@auth0/ai`](https://github.com/auth0/auth0-ai-js/tree/main/packages/ai) -
  Base abstractions for authentication and authorization in AI applications.

- [`@auth0/ai-genkit`](https://github.com/auth0/auth0-ai-js/tree/main/packages/ai-genkit) -
  Integration with [Genkit](https://firebase.google.com/docs/genkit) framework.

- [`@auth0/ai-llamaindex`](https://github.com/auth0/auth0-ai-js/tree/main/packages/ai-llamaindex) -
  Integration with [LlamaIndex.TS](https://ts.llamaindex.ai/) framework.

- [`@auth0/ai-langchain`](https://github.com/auth0/auth0-ai-js/tree/main/packages/ai-langchain) -
  Integration with [LangchainJS](https://js.langchain.com/docs/introduction/) framework.

- [`@auth0/ai-vercel`](https://github.com/auth0/auth0-ai-js/tree/main/packages/ai-vercel) -
  Integration with [AI SDK](https://sdk.vercel.ai/) framework.

- [`@auth0/ai-redis`](https://github.com/auth0/auth0-ai-js/tree/main/packages/ai-redis) - 
 A secure [Redis](https://redis.com/)-based data store implementation for Credentials and Authorization requests.

- [`@auth0/ai-components`](https://github.com/auth0/auth0-ai-js/tree/main/packages/ai-components) -
  A library of React components to help integrate `@auth0/ai` with a UI.

## Running examples

## Prepare the workspace

1. Install dependencies for the workspace

   ```sh
   npm install
   ```

2. Run [Turbo](https://turbo.build/)

   ```sh
   npm run build
   ```

3. Follow the examples instructions below

### Examples list

- [**Async User Confirmation**](./examples/async-authorization/README.md)
- [**Authorization for RAG**](./examples/authorization-for-rag/README.md)
- [**Authorization for Tools**](./examples/authorization-for-tools/README.md)

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
