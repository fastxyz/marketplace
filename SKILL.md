---
name: fast-marketplace
description: Discover services on the Fast Marketplace, choose the right endpoint, follow the Fast-native x402 payment flow with a funded local wallet, handle async job retrieval, onboard providers, manage draft services, review marketplace demand intake, and submit or review marketplace supply. Use this when a user wants to browse or call APIs exposed through fast.8o.vc or fastapi.8o.vc, or manage marketplace supply from the provider/admin surfaces.
---

# Fast Marketplace

Use this skill when a user wants to work with APIs listed on the Fast Marketplace.

## Use this skill when

- the user wants to find a service or endpoint on `https://fast.8o.vc`
- the user needs the exact request body, proxy URL, or response shape for a marketplace endpoint
- the user wants to sign into `https://fast.8o.vc` with a Fast browser wallet
- the user wants to pay and execute a marketplace route directly from the website with the Fast browser extension
- the user needs to call a paid Fast-native x402 route with a local Fast wallet
- the user needs to retrieve an async result from a previously paid job
- the user wants to suggest a missing endpoint or a new source/webservice for providers to build
- the user wants to create or update a provider profile and manage service drafts
- the user wants to claim provider-visible request intake and route it into a draft service
- the user wants to verify provider website ownership and submit a service for review
- the user wants to review, publish, or suspend provider supply from the admin surface

## Do not use this skill when

- the user wants a direct provider integration outside the marketplace
- the task is generic web research rather than using marketplace routes

## Inputs to gather

Before acting, identify:

- whether the user is acting as a buyer, provider, or marketplace operator
- the service or domain the user wants
- the endpoint or outcome they need
- whether the route is free, paid, sync, or async
- whether they want browser login only, browser execution, or a CLI/agent-wallet flow
- whether they already have a funded Fast wallet
- which Fast network the deployment is using: mainnet or testnet
- whether they need website session auth, job retrieval auth, or admin token auth
- for provider flows: service metadata, payout wallet, website URL, endpoint schemas/examples, and upstream execution details

## Workflow

1. Identify the role and flow first: buyer, provider, or admin/operator.
2. If the flow is website-based, connect the Fast browser wallet from the site header and sign the website challenge.
3. Use the role-specific flow below.

## Buyer workflow

1. Open the marketplace UI at `https://fast.8o.vc` and locate the relevant service.
2. Open the service page and use the published endpoint docs, pricing, and examples.
3. If the user wants browser execution, use the endpoint's browser execution panel and let the extension pay after the first `402` response.
4. If the user is delegating the task to another agent, copy the service page's "Use this service" block or the canonical skill URL.
5. For paid routes outside the browser panel, send the first request without payment proof and read the `402 Payment Required` response.
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
- website login uses a signed wallet challenge for the site session
- the website can also pay and execute routes directly through the Fast extension
- wallet identity is the payer identity
- use the same request body when retrying a paid request
- for safe retries, keep the same payment identifier for the same normalized request only

## Website auth flow

1. For website sessions, use the signed wallet challenge flow served by `/auth/wallet/challenge` and `/auth/wallet/session`.
2. The website session unlocks provider surfaces and browser-connected marketplace actions.
3. Website session auth is separate from job retrieval auth.

## Async retrieval flow

1. If a paid trigger returns `202`, persist the `jobToken`.
2. Create the job-scoped wallet auth session through `/auth/challenge` and `/auth/session`.
3. Poll `GET /api/jobs/{jobToken}` until the job completes or fails.
4. Use the same wallet that paid for the original trigger.

## Refund flow

1. If a sync paid trigger fails after payment verification, the marketplace may refund immediately.
2. If an async job permanently fails after acceptance, the worker issues a treasury refund.
3. Read the job retrieval payload or sync error payload for refund status, transaction hash, and any refund error details.

## Provider workflow

1. Sign into `https://fast.8o.vc` with the provider wallet and open `/providers` or `/providers/onboard`.
2. Create or update the provider profile tied to that wallet session.
3. If building from marketplace demand, review provider-visible request intake and claim the request you want to build.
4. Open `/providers/services` and create or update the target service draft.
5. Set the service metadata carefully: slug, API namespace, prompt intro, setup instructions, categories, website URL, and payout wallet.
6. Add endpoint drafts with the exact request schema, response schema, examples, price, mode, and upstream execution settings.
7. If the service website host must be verified, create a verification challenge and publish the requested token at the expected URL.
8. Verify website ownership from the provider review flow.
9. Submit the service for marketplace review once the draft is complete and verified.
10. After publish, use the public service page and paid proxy routes as the canonical execution surface.

Important provider constraints:

- provider drafts are scoped to the wallet that owns the provider profile
- payout wallet validation happens at draft/update time
- changing the service website host requires re-verification before submission
- request intake claiming is exclusive once another provider has claimed it

## Admin and review workflow

1. Sign into `/admin/login` with the marketplace admin token.
2. Open the internal review surfaces for suggestions and submitted provider services.
3. Review suggestion intake, update statuses, and add operator notes as needed.
4. Review submitted provider services for correctness, pricing, ownership verification, and marketplace fit.
5. Publish approved services so they appear in the public catalog and route registry.
6. Suspend services when they should no longer be publicly executable.

## Troubleshooting

- `402 Payment Required`: the route is payable; submit payment and retry the same request
- `400` on a paid trigger: the request body or payment identifier is invalid
- `401 Unauthorized` on job retrieval: create a wallet-bound session from the same paying wallet
- `409 Conflict`: the payment identifier was reused with a different request body
- permanent async failure after acceptance: the marketplace refund policy applies
- provider submission blocked: complete website verification or fix draft validation errors
- service website host changed: generate a new verification challenge and verify again
- provider request claim conflict: another provider already claimed the request
- admin review unavailable: confirm the correct admin token is present
- missing service or endpoint: submit a suggestion from the marketplace UI

## Discovery and reference URLs

- Marketplace UI: `https://fast.8o.vc`
- Canonical skill: `https://fast.8o.vc/skill.md`
- Suggest an endpoint: `https://fast.8o.vc/suggest?type=endpoint`
- Suggest a source: `https://fast.8o.vc/suggest?type=source`
- Provider dashboard: `https://fast.8o.vc/providers`
- Provider onboarding: `https://fast.8o.vc/providers/onboard`
- Provider services: `https://fast.8o.vc/providers/services`
- Admin login: `https://fast.8o.vc/admin/login`
- Admin suggestions: `https://fast.8o.vc/admin/suggestions`
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
- "Set up my provider profile and publish a new service."
- "Claim this request intake item and turn it into a provider draft."
- "Review the admin queue and publish the submitted service."
