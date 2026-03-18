import { Pool } from "pg";

import {
  DEFAULT_JOB_POLL_INTERVAL_MS,
  PostgresMarketplaceStore,
  normalizeMarketplaceDeploymentNetwork,
  resolveMarketplaceNetworkConfig
} from "@marketplace/shared";

import { createFastRefundService, runMarketplaceWorkerCycle } from "./worker.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required.");
}

const pool = new Pool({ connectionString: databaseUrl });
const store = new PostgresMarketplaceStore(pool);
await store.ensureSchema();
const network = resolveMarketplaceNetworkConfig({
  deploymentNetwork: normalizeMarketplaceDeploymentNetwork(process.env.MARKETPLACE_FAST_NETWORK),
  rpcUrl: process.env.FAST_RPC_URL
});

const refundService = createFastRefundService({
  deploymentNetwork: network.deploymentNetwork,
  rpcUrl: network.rpcUrl,
  privateKey: process.env.MARKETPLACE_TREASURY_PRIVATE_KEY,
  keyfilePath: process.env.MARKETPLACE_TREASURY_KEYFILE
});

const intervalMs = Number(process.env.WORKER_POLL_INTERVAL_MS ?? DEFAULT_JOB_POLL_INTERVAL_MS);

const timer = setInterval(() => {
  void runMarketplaceWorkerCycle({
    store,
    refundService
  }).catch((error) => {
    console.error("Worker cycle failed:", error);
  });
}, intervalMs);

void runMarketplaceWorkerCycle({ store, refundService }).catch((error) => {
  console.error("Initial worker cycle failed:", error);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    clearInterval(timer);
    await pool.end();
    process.exit(0);
  });
}
