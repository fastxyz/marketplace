# Fast-Native Agent Data Marketplace v1

Greenfield TypeScript workspace for a Fast-native paid data marketplace.

## Workspace

- `apps/api`: Express gateway with x402 compatibility, wallet auth, docs, and mock provider routes
- `apps/facilitator`: x402 facilitator service for payment verification
- `apps/worker`: async job poller and refund worker
- `packages/shared`: shared route registry, hashing, auth, payment compatibility, docs, and stores
- `packages/cli`: buyer CLI for wallet, paid invocation, and job retrieval

## Quick Start

1. Install dependencies:

```bash
npm install
```

2. Set environment variables:

```bash
export DATABASE_URL=postgres://localhost:5432/fast_marketplace
export MARKETPLACE_TREASURY_ADDRESS=fast1...
export MARKETPLACE_FACILITATOR_URL=http://localhost:4020
export MARKETPLACE_SESSION_SECRET=change-me
```

Optional refund worker variables:

```bash
export MARKETPLACE_TREASURY_PRIVATE_KEY=<fast-ed25519-private-key-hex>
export FAST_RPC_URL=https://api.fast.xyz/proxy
```

Optional facilitator variables:

```bash
export FACILITATOR_PORT=4020
export FACILITATOR_FAST_RPC_URL=https://api.fast.xyz/proxy
export FACILITATOR_EVM_PRIVATE_KEY=<evm-private-key-if-you-later-enable-evm-settlement>
```

3. Run the facilitator:

```bash
npm run dev:facilitator
```

4. Run the API:

```bash
npm run dev:api
```

5. Run the worker:

```bash
npm run dev:worker
```

6. Use the CLI:

```bash
npm run cli -- wallet init
npm run cli -- wallet address
npm run cli -- invoke mock quick-insight --body '{"query":"alpha"}'
```

## Scripts

- `npm run build`: typecheck the workspace
- `npm run test`: run unit and integration tests
- `npm run dev:api`: run the API with `tsx`
- `npm run dev:facilitator`: run the facilitator with `tsx`
- `npm run dev:worker`: run the worker with `tsx`
- `npm run cli -- ...`: run the buyer CLI
