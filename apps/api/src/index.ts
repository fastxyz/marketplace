import { Pool } from "pg";

import { PostgresMarketplaceStore, createFastRefundService } from "@marketplace/shared";

import { createMarketplaceApi, createX402FacilitatorClient } from "./app.js";

const port = Number(process.env.PORT ?? 3000);
const databaseUrl = process.env.DATABASE_URL;
const payTo = process.env.MARKETPLACE_TREASURY_ADDRESS;
const facilitatorUrl = process.env.MARKETPLACE_FACILITATOR_URL ?? "http://localhost:4020";
const sessionSecret = process.env.MARKETPLACE_SESSION_SECRET;
const adminToken = process.env.MARKETPLACE_ADMIN_TOKEN;
const baseUrl = process.env.MARKETPLACE_BASE_URL ?? `http://localhost:${port}`;
const webBaseUrl = process.env.MARKETPLACE_WEB_BASE_URL ?? baseUrl;
const secretsKey = process.env.MARKETPLACE_SECRETS_KEY;
const refundPrivateKey = process.env.MARKETPLACE_TREASURY_PRIVATE_KEY;
const refundKeyfile = process.env.MARKETPLACE_TREASURY_KEYFILE;
const refundRpcUrl = process.env.FAST_RPC_URL;

if (!databaseUrl) {
  throw new Error("DATABASE_URL is required.");
}

if (!payTo) {
  throw new Error("MARKETPLACE_TREASURY_ADDRESS is required.");
}

if (!adminToken) {
  throw new Error("MARKETPLACE_ADMIN_TOKEN is required.");
}

if (!sessionSecret) {
  throw new Error("MARKETPLACE_SESSION_SECRET is required.");
}

if (!secretsKey) {
  throw new Error("MARKETPLACE_SECRETS_KEY is required.");
}

const pool = new Pool({ connectionString: databaseUrl });
const store = new PostgresMarketplaceStore(pool);

await store.ensureSchema();

const app = createMarketplaceApi({
  store,
  payTo,
  sessionSecret,
  adminToken,
  facilitatorClient: createX402FacilitatorClient(facilitatorUrl),
  refundService: createFastRefundService({
    rpcUrl: refundRpcUrl,
    privateKey: refundPrivateKey,
    keyfilePath: refundKeyfile
  }),
  baseUrl,
  webBaseUrl,
  secretsKey,
  siteProofToken: process.env.MARKETPLACE_SITE_PROOF
});

const server = app.listen(port, () => {
  console.log(`Marketplace API listening on ${baseUrl}`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    server.close();
    await pool.end();
    process.exit(0);
  });
}
