---
name: fast-marketplace
description: Discover services on the Fast Marketplace, choose the right endpoint, follow the Fast-native x402 payment flow with a funded local wallet, handle async job retrieval, and submit missing endpoint or source suggestions. Use this when a user wants to browse or call APIs exposed through fast.8o.vc or fastapi.8o.vc.
---

# Fast Marketplace

Use this skill when a user wants to work with APIs listed on the Fast Marketplace.

## Use this skill when

- the user wants to find a service or endpoint on `https://fast.8o.vc`
- the user needs the exact request body, proxy URL, or response shape for a marketplace endpoint
- the user wants to sign into `https://fast.8o.vc` with a Fast browser wallet
- the user needs to call a paid Fast-native x402 route with a local Fast wallet
- the user needs to retrieve an async result from a previously paid job
- the user wants to suggest a missing endpoint or a new source/webservice for providers to build

## Do not use this skill when

- the user wants a direct provider integration outside the marketplace
- the user wants a fully in-browser paid call flow; website login is supported, but paid API execution still uses the CLI or another agent wallet client
- the task is generic web research rather than using marketplace routes

## Inputs to gather

Before acting, identify:

- the service or domain the user wants
- the endpoint or outcome they need
- whether the route is free, paid, sync, or async
- whether they want browser login only or a full paid API call
- whether they already have a funded Fast wallet
- which Fast network the deployment is using: mainnet or testnet

## Workflow

1. Open the marketplace UI at `https://fast.8o.vc` and locate the relevant service.
2. If the user wants website login, connect the Fast browser wallet from the site header and sign the website challenge.
3. Open the service page and use the published endpoint docs, pricing, and examples.
4. If the user is delegating the task to another agent, copy the service page's "Use this service" block or the canonical skill URL.
5. For paid routes, send the first request without payment proof and read the `402 Payment Required` response.
6. Pay from the funded local Fast wallet and retry the same request with the payment proof headers.
7. If the route returns `202 Accepted`, store the `jobToken` and switch to wallet-bound retrieval.
8. If the marketplace does not have the needed capability, submit a suggestion for an endpoint or source.

## Payment flow

The marketplace is Fast-native and wallet-first.

1. Use a persistent local Fast wallet funded with `fastUSDC` on mainnet or `testUSDC` on testnet.
2. Send the first request without payment proof.
3. Read the `402` response and payment requirements.
4. Authorize payment from the wallet.
5. Retry the same request with the payment proof.

Important constraints:

- paid routes do not use long-lived API keys
- website login uses a signed wallet challenge but does not pay for routes by itself
- wallet identity is the payer identity
- use the same request body when retrying a paid request
- for safe retries, keep the same payment identifier for the same normalized request only

## Async retrieval flow

1. If a paid trigger returns `202`, persist the `jobToken`.
2. Create the wallet-bound auth session for that job when prompted.
3. Poll `GET /api/jobs/{jobToken}` until the job completes or fails.
4. Use the same wallet that paid for the original trigger.

## Troubleshooting

- `402 Payment Required`: the route is payable; submit payment and retry the same request
- `401 Unauthorized` on job retrieval: create a wallet-bound session from the same paying wallet
- `409 Conflict`: the payment identifier was reused with a different request body
- permanent async failure after acceptance: the marketplace refund policy applies
- missing service or endpoint: submit a suggestion from the marketplace UI

## Discovery and reference URLs

- Marketplace UI: `https://fast.8o.vc`
- Canonical skill: `https://fast.8o.vc/skill.md`
- Suggest an endpoint: `https://fast.8o.vc/suggest?type=endpoint`
- Suggest a source: `https://fast.8o.vc/suggest?type=source`
- Website wallet login: use the `Connect Wallet` control in the site header
- OpenAPI: `https://fastapi.8o.vc/openapi.json`
- LLM summary: `https://fastapi.8o.vc/llms.txt`
- Marketplace catalog JSON: `https://fastapi.8o.vc/.well-known/marketplace.json`

## Example requests that should trigger this skill

- "Find me a paid Fast API for research signals."
- "Show me the exact curl body for a marketplace endpoint."
- "Call this Fast marketplace route and handle the 402 payment."
- "Retrieve the result for a previously paid async marketplace job."
- "Suggest a new source or endpoint for the marketplace."
