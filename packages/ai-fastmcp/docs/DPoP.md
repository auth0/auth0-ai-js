# DPoP

DPoP (RFC 9449) binds an access token to a key that the client holds, so a stolen token is useless without the key. A server that accepts DPoP has to verify a proof on every request.

This release of `@auth0/ai-fastmcp` does not verify DPoP proofs. It accepts Bearer tokens only, and it refuses DPoP requests with a clear 401 instead of treating a DPoP-bound token as an ordinary Bearer token. Accepting such a token without checking the proof would remove the protection DPoP exists to give.

## What the server does

| Request | Response |
| --- | --- |
| It has a `DPoP` header, even an empty one, with or without an `Authorization` header. | 401. The challenge is `Bearer` with `error="invalid_token"` and the description `DPoP is not supported by this server.` |
| It carries a Bearer token whose payload has a `cnf` claim, which is how a token declares that a key is bound to it. | 401, same shape, with the description `DPoP-bound access tokens are not supported by this server.` |
| It uses the `DPoP` authorization scheme (`Authorization: DPoP <token>`) and has no `DPoP` header. | 401 with the challenge `Bearer` and no error value. The scheme counts as no credential, like any scheme other than Bearer. |

The first two refusals happen before the adapter contacts your tenant: it makes no discovery request and no key request. The `cnf` check reads the token payload without verifying the signature. The adapter refuses a token that claims a binding whether or not its signature is good, so the check can only reject more requests, never fewer.

Challenges and metadata never mention DPoP. Every challenge lists the `Bearer` scheme only, and the metadata document has no `dpop_signing_alg_values_supported` or `dpop_bound_access_tokens_required` field. A client that reads them knows to send a Bearer token.

## The dpop option

You configure DPoP with the `dpop` option of the client, as in `@auth0/ai-mcp`:

| `dpop.mode` | Effect in this adapter |
| --- | --- |
| Not set, or `"allowed"` | Accepted. The adapter still answers Bearer only, as described above. |
| `"disabled"` | Accepted. A token that claims a binding is still refused, because the `cnf` check does not depend on the mode. |
| `"required"` | `createFastMcpAuth` throws `InvalidConfigurationError`: `DPoP mode "required" is not supported by the FastMCP adapter, which accepts Bearer tokens only. Use the default DPoP mode.` |

A client you pass in follows the same rules: when you create the adapter, `createFastMcpAuth` refuses one that requires DPoP.

## What to do

- Make the MCP client or application request Bearer tokens for your API.
- If you need DPoP now, serve MCP with `createMcpHandler` from `@auth0/ai-mcp`, or `createNodeMcpHandler` from `@auth0/ai-mcp/mcp-sdk`. Both accept the `DPoP` scheme. The [DPoP section](../../ai-mcp/docs/TokenVerification.md#dpop) of that package's guide describes what they support.
