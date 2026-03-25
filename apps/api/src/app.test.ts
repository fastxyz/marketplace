import type { Express } from "express";
import { FastProvider, FastWallet } from "@fastxyz/sdk";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildMarketplaceCallbackHeaders,
  InMemoryMarketplaceStore,
  MARKETPLACE_JOB_TOKEN_HEADER,
  resolveMarketplaceNetworkConfig,
  verifyMarketplaceIdentityHeaders,
  type ProviderExecuteContext
} from "@marketplace/shared";

import { createMarketplaceApi } from "./app.js";
import { runMarketplaceWorkerCycle } from "../../worker/src/worker.js";

const TEST_PRIVATE_KEY = "22".repeat(32);
const PROVIDER_PRIVATE_KEY = "33".repeat(32);
const OTHER_PRIVATE_KEY = "44".repeat(32);

async function createTestWallet(privateKey = TEST_PRIVATE_KEY) {
  const provider = new FastProvider({
    network: "mainnet",
    networks: {
      mainnet: {
        rpc: "https://api.fast.xyz/proxy",
        explorer: "https://explorer.fast.xyz"
      }
    }
  });
  const wallet = await FastWallet.fromPrivateKey(privateKey, provider);
  const exported = await wallet.exportKeys();
  return {
    wallet,
    address: wallet.address,
    payerHex: `0x${exported.publicKey}`
  };
}

async function createSiteSession(app: Express, wallet: Awaited<ReturnType<typeof createTestWallet>>) {
  const challenge = await request(app)
    .post("/auth/wallet/challenge")
    .send({
      wallet: wallet.address
    });

  expect(challenge.status).toBe(200);

  const signed = await wallet.wallet.sign({ message: challenge.body.message });
  const session = await request(app)
    .post("/auth/wallet/session")
    .send({
      wallet: wallet.address,
      nonce: challenge.body.nonce,
      expiresAt: challenge.body.expiresAt,
      signature: signed.signature
    });

  expect(session.status).toBe(200);
  return session.body.accessToken as string;
}

async function createTestApp(
  input: {
    deploymentNetwork?: "mainnet" | "testnet";
    store?: InMemoryMarketplaceStore;
    providers?: Parameters<typeof createMarketplaceApi>[0]["providers"];
    refundService?: Parameters<typeof createMarketplaceApi>[0]["refundService"];
    baseUrl?: string;
  } = {}
) {
  const buyer = await createTestWallet();
  const deploymentNetwork = input.deploymentNetwork ?? "mainnet";
  const networkConfig = resolveMarketplaceNetworkConfig({
    deploymentNetwork
  });
  const previousNetwork = process.env.MARKETPLACE_FAST_NETWORK;
  process.env.MARKETPLACE_FAST_NETWORK = deploymentNetwork;

  const store = input.store ?? new InMemoryMarketplaceStore(networkConfig);
  const app = createMarketplaceApi({
    store,
    payTo: buyer.address,
    sessionSecret: "test-session-secret",
    secretsKey: "test-secrets-key",
    adminToken: "test-admin-token",
    facilitatorClient: {
      async verify() {
        return {
          isValid: true,
          payer: buyer.payerHex,
          network: networkConfig.paymentNetwork
        };
      }
    },
    refundService:
      input.refundService ??
      {
        async issueRefund() {
          return { txHash: "0xrefund" };
        }
      },
    providers: input.providers,
    baseUrl: input.baseUrl,
    webBaseUrl: "https://marketplace.example.com"
  });

  if (previousNetwork === undefined) {
    delete process.env.MARKETPLACE_FAST_NETWORK;
  } else {
    process.env.MARKETPLACE_FAST_NETWORK = previousNetwork;
  }

  return {
    app,
    store,
    buyer
  };
}

function marketplaceServiceDraft<T extends Record<string, unknown>>(input: T) {
  return {
    serviceType: "marketplace_proxy" as const,
    ...input
  };
}

function marketplaceEndpointDraft<T extends Record<string, unknown>>(input: T) {
  return {
    endpointType: "marketplace_proxy" as const,
    ...input
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("marketplace api", () => {
  it("returns catalog services and service details with generated prompts", async () => {
    const { app } = await createTestApp({
      deploymentNetwork: "testnet"
    });

    const listResponse = await request(app).get("/catalog/services");
    expect(listResponse.status).toBe(200);
    expect(listResponse.body.services.some((service: { slug: string }) => service.slug === "mock-research-signals")).toBe(
      true
    );

    const detailResponse = await request(app).get("/catalog/services/mock-research-signals");
    expect(detailResponse.status).toBe(200);
    expect(detailResponse.body.summary.endpointCount).toBe(2);
    expect(detailResponse.body.skillUrl).toBe("https://marketplace.example.com/skill.md");
    expect(detailResponse.body.useThisServicePrompt).toContain("https://marketplace.example.com/skill.md");
  });

  it("accepts public suggestions and requires an admin token for internal review", async () => {
    const { app } = await createTestApp({
      deploymentNetwork: "testnet"
    });

    const created = await request(app)
      .post("/catalog/suggestions")
      .send({
        type: "endpoint",
        serviceSlug: "mock-research-signals",
        title: "Add a structured watchlist endpoint",
        description: "Expose a watchlist-friendly endpoint that returns a ranked signal feed.",
        requesterEmail: "builder@example.com"
      });

    expect(created.status).toBe(201);
    expect(created.body.status).toBe("submitted");

    const unauthorized = await request(app).get("/internal/suggestions");
    expect(unauthorized.status).toBe(401);

    const listed = await request(app)
      .get("/internal/suggestions")
      .set("Authorization", "Bearer test-admin-token");
    expect(listed.status).toBe(200);
    expect(listed.body.suggestions).toHaveLength(1);

    const patched = await request(app)
      .patch(`/internal/suggestions/${created.body.id}`)
      .set("Authorization", "Bearer test-admin-token")
      .send({
        status: "reviewing",
        internalNotes: "Looks viable for the mock catalog."
      });

    expect(patched.status).toBe(200);
    expect(patched.body.status).toBe("reviewing");
  });

  it("lets providers list and claim request intake from their wallet session", async () => {
    const providerWallet = await createTestWallet(PROVIDER_PRIVATE_KEY);
    const otherWallet = await createTestWallet(OTHER_PRIVATE_KEY);
    const { app } = await createTestApp({
      deploymentNetwork: "testnet"
    });
    const providerToken = await createSiteSession(app, providerWallet);
    const otherToken = await createSiteSession(app, otherWallet);

    const created = await request(app)
      .post("/catalog/suggestions")
      .send({
        type: "endpoint",
        serviceSlug: "mock-research-signals",
        title: "Add a structured watchlist endpoint",
        description: "Expose a watchlist-friendly endpoint that returns a ranked signal feed.",
        requesterEmail: "builder@example.com"
      });

    expect(created.status).toBe(201);

    await request(app)
      .post("/provider/me")
      .set("Authorization", `Bearer ${providerToken}`)
      .send({
        displayName: "Signal Labs"
      });

    await request(app)
      .post("/provider/me")
      .set("Authorization", `Bearer ${otherToken}`)
      .send({
        displayName: "Other Provider"
      });

    const listed = await request(app)
      .get("/provider/requests")
      .set("Authorization", `Bearer ${providerToken}`);

    expect(listed.status).toBe(200);
    expect(listed.body.requests).toHaveLength(1);
    expect(listed.body.requests[0].claimedByCurrentProvider).toBe(false);
    expect(listed.body.requests[0].claimable).toBe(true);
    expect(listed.body.requests[0].requesterEmail).toBeUndefined();
    expect(listed.body.requests[0].internalNotes).toBeUndefined();

    const claimed = await request(app)
      .post(`/provider/requests/${created.body.id}/claim`)
      .set("Authorization", `Bearer ${providerToken}`);

    expect(claimed.status).toBe(200);
    expect(claimed.body.status).toBe("reviewing");
    expect(claimed.body.claimedByProviderName).toBe("Signal Labs");
    expect(claimed.body.claimedByCurrentProvider).toBe(true);
    expect(claimed.body.requesterEmail).toBeUndefined();

    const reopened = await request(app)
      .patch(`/internal/suggestions/${created.body.id}`)
      .set("Authorization", "Bearer test-admin-token")
      .send({
        status: "submitted",
        internalNotes: "Reopen for reassignment."
      });

    expect(reopened.status).toBe(200);
    expect(reopened.body.claimedByProviderAccountId).toBeNull();

    const reassigned = await request(app)
      .post(`/provider/requests/${created.body.id}/claim`)
      .set("Authorization", `Bearer ${otherToken}`);

    expect(reassigned.status).toBe(200);
    expect(reassigned.body.claimedByProviderName).toBe("Other Provider");
    expect(reassigned.body.claimedByCurrentProvider).toBe(true);

    await request(app)
      .patch(`/internal/suggestions/${created.body.id}`)
      .set("Authorization", "Bearer test-admin-token")
      .send({
        status: "shipped"
      });

    const afterShip = await request(app)
      .get("/provider/requests")
      .set("Authorization", `Bearer ${providerToken}`);

    expect(afterShip.status).toBe(200);
    expect(afterShip.body.requests).toHaveLength(0);
  });

  it("returns 402 and payment requirements for unpaid routes", async () => {
    const { app } = await createTestApp({
      deploymentNetwork: "testnet"
    });

    const response = await request(app)
      .post("/api/mock/quick-insight")
      .send({ query: "alpha" });

    expect(response.status).toBe(402);
    expect(response.headers["payment-required"]).toBeDefined();
    expect(response.body.accepts[0].network).toBe("fast-testnet");
  });

  it("allows browser CORS requests from the configured web origin", async () => {
    const { app } = await createTestApp();

    const response = await request(app)
      .options("/api/mock/quick-insight")
      .set("Origin", "https://marketplace.example.com")
      .set("Access-Control-Request-Method", "POST")
      .set("Access-Control-Request-Headers", "content-type,payment-identifier,payment-signature");

    expect(response.status).toBe(204);
    expect(response.headers["access-control-allow-origin"]).toBe("https://marketplace.example.com");
    expect(response.headers["access-control-allow-headers"]).toContain("PAYMENT-IDENTIFIER");
    expect(response.headers["access-control-expose-headers"]).toContain("PAYMENT-REQUIRED");
  });

  it("accepts legacy X-PAYMENT on a sync route", async () => {
    const { app, store } = await createTestApp({
      deploymentNetwork: "testnet"
    });

    const response = await request(app)
      .post("/api/mock/quick-insight")
      .set("X-PAYMENT", Buffer.from(JSON.stringify({ paid: true })).toString("base64"))
      .set("PAYMENT-IDENTIFIER", "payment_sync_1")
      .send({ query: "alpha" });

    expect(response.status).toBe(200);
    expect(response.headers["payment-response"]).toBeDefined();
    expect(response.body.operation).toBe("quick-insight");

    const record = await store.getIdempotencyByPaymentId("payment_sync_1");
    expect(record?.payoutSplit.marketplaceAmount).toBe("50000");
    expect(record?.payoutSplit.providerAmount).toBe("0");
    expect(record?.payoutSplit.providerAccountId).toBe("provider_marketplace");
  });

  it("replays the same sync response for the same payment id and request", async () => {
    const { app } = await createTestApp({
      deploymentNetwork: "testnet"
    });

    const first = await request(app)
      .post("/api/mock/quick-insight")
      .set("X-PAYMENT", Buffer.from(JSON.stringify({ paid: true })).toString("base64"))
      .set("PAYMENT-IDENTIFIER", "payment_sync_2")
      .send({ query: "alpha" });

    const second = await request(app)
      .post("/api/mock/quick-insight")
      .set("X-PAYMENT", Buffer.from(JSON.stringify({ paid: true })).toString("base64"))
      .set("PAYMENT-IDENTIFIER", "payment_sync_2")
      .send({ query: "alpha" });

    const conflict = await request(app)
      .post("/api/mock/quick-insight")
      .set("X-PAYMENT", Buffer.from(JSON.stringify({ paid: true })).toString("base64"))
      .set("PAYMENT-IDENTIFIER", "payment_sync_2")
      .send({ query: "different" });

    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);
    expect(conflict.status).toBe(409);
  });

  it("recovers stale pending sync payments with a refreshed recovery lease and stable request id", async () => {
    class FlakySyncStore extends InMemoryMarketplaceStore {
      private remainingCompletedWriteFailures = 2;

      override async saveSyncIdempotency(input: Parameters<InMemoryMarketplaceStore["saveSyncIdempotency"]>[0]) {
        if (this.remainingCompletedWriteFailures > 0 && input.statusCode >= 200 && input.statusCode < 400) {
          this.remainingCompletedWriteFailures -= 1;
          throw new Error("sync idempotency write failed");
        }

        return super.saveSyncIdempotency(input);
      }
    }

    const store = new FlakySyncStore(
      resolveMarketplaceNetworkConfig({
        deploymentNetwork: "testnet"
      })
    );
    const requestIds: string[] = [];
    const { app } = await createTestApp({
      deploymentNetwork: "testnet",
      store,
      providers: {
        mock: {
          async execute(context: ProviderExecuteContext) {
            requestIds.push(context.requestId);
            return {
              kind: "sync" as const,
              statusCode: 200,
              body: {
                ok: true,
                requestId: context.requestId
              }
            };
          },
          async poll() {
            return {
              status: "completed" as const,
              body: {}
            };
          }
        }
      }
    });

    const first = await request(app)
      .post("/api/mock/quick-insight")
      .set("X-PAYMENT", Buffer.from(JSON.stringify({ paid: true })).toString("base64"))
      .set("PAYMENT-IDENTIFIER", "payment_sync_recovery_1")
      .send({ query: "alpha" });

    expect(first.status).toBe(500);
    expect(requestIds).toHaveLength(1);

    const second = await request(app)
      .post("/api/mock/quick-insight")
      .set("X-PAYMENT", Buffer.from(JSON.stringify({ paid: true })).toString("base64"))
      .set("PAYMENT-IDENTIFIER", "payment_sync_recovery_1")
      .send({ query: "alpha" });

    expect(second.status).toBe(202);
    expect(requestIds).toHaveLength(1);

    const idempotencyByPaymentId = (store as unknown as {
      idempotencyByPaymentId: Map<string, {
        updatedAt: string;
      }>;
    }).idempotencyByPaymentId;
    const pending = idempotencyByPaymentId.get("payment_sync_recovery_1");
    if (!pending) {
      throw new Error("Missing pending idempotency record.");
    }
    idempotencyByPaymentId.set("payment_sync_recovery_1", {
      ...pending,
      updatedAt: new Date(Date.now() - 20_000).toISOString()
    });

    const firstRecoveryAttempt = await request(app)
      .post("/api/mock/quick-insight")
      .set("X-PAYMENT", Buffer.from(JSON.stringify({ paid: true })).toString("base64"))
      .set("PAYMENT-IDENTIFIER", "payment_sync_recovery_1")
      .send({ query: "alpha" });

    expect(firstRecoveryAttempt.status).toBe(500);
    expect(requestIds).toHaveLength(2);
    expect(new Set(requestIds).size).toBe(1);

    const third = await request(app)
      .post("/api/mock/quick-insight")
      .set("X-PAYMENT", Buffer.from(JSON.stringify({ paid: true })).toString("base64"))
      .set("PAYMENT-IDENTIFIER", "payment_sync_recovery_1")
      .send({ query: "alpha" });

    expect(third.status).toBe(202);
    expect(requestIds).toHaveLength(2);

    const refreshedPending = idempotencyByPaymentId.get("payment_sync_recovery_1");
    if (!refreshedPending) {
      throw new Error("Missing refreshed pending idempotency record.");
    }
    idempotencyByPaymentId.set("payment_sync_recovery_1", {
      ...refreshedPending,
      updatedAt: new Date(Date.now() - 20_000).toISOString()
    });

    const recovered = await request(app)
      .post("/api/mock/quick-insight")
      .set("X-PAYMENT", Buffer.from(JSON.stringify({ paid: true })).toString("base64"))
      .set("PAYMENT-IDENTIFIER", "payment_sync_recovery_1")
      .send({ query: "alpha" });

    expect(recovered.status).toBe(200);
    expect(requestIds).toHaveLength(3);
    expect(new Set(requestIds).size).toBe(1);

    const record = await store.getIdempotencyByPaymentId("payment_sync_recovery_1");
    expect(record?.executionStatus).toBe("completed");
    expect(record?.requestId).toBe(requestIds[0]);
  });

  it("creates an async job and lets the paying wallet poll it for free", async () => {
    const { app, buyer, store } = await createTestApp({
      deploymentNetwork: "testnet"
    });

    const accepted = await request(app)
      .post("/api/mock/async-report")
      .set("X-PAYMENT", Buffer.from(JSON.stringify({ paid: true })).toString("base64"))
      .set("PAYMENT-IDENTIFIER", "payment_async_1")
      .send({ topic: "market depth", delayMs: 60_000 });

    expect(accepted.status).toBe(202);
    const { jobToken } = accepted.body;

    const challenge = await request(app)
      .post("/auth/challenge")
      .send({
        wallet: buyer.address,
        resourceType: "job",
        resourceId: jobToken
      });

    expect(challenge.status).toBe(200);
    const signed = await buyer.wallet.sign({ message: challenge.body.message });

    const session = await request(app)
      .post("/auth/session")
      .send({
        wallet: buyer.address,
        resourceType: "job",
        resourceId: jobToken,
        nonce: challenge.body.nonce,
        expiresAt: challenge.body.expiresAt,
        signature: signed.signature
      });

    expect(session.status).toBe(200);

    const polled = await request(app)
      .get(`/api/jobs/${jobToken}`)
      .set("Authorization", `Bearer ${session.body.accessToken}`);

    expect(polled.status).toBe(200);
    expect(polled.body.status).toBe("pending");

    const job = await store.getJob(jobToken);
    expect(job?.payoutSplit.marketplaceAmount).toBe("150000");
    expect(job?.payoutSplit.providerAmount).toBe("0");
    expect(job?.payoutSplit.providerAccountId).toBe("provider_marketplace");
  });

  it("keeps accepted async payments replayable when saveAsyncAcceptance fails after upstream acceptance", async () => {
    class FlakyAsyncStore extends InMemoryMarketplaceStore {
      private failNextAcceptanceWrite = true;

      override async saveAsyncAcceptance(input: Parameters<InMemoryMarketplaceStore["saveAsyncAcceptance"]>[0]) {
        if (this.failNextAcceptanceWrite) {
          this.failNextAcceptanceWrite = false;
          throw new Error("async acceptance write failed");
        }

        return super.saveAsyncAcceptance(input);
      }
    }

    const store = new FlakyAsyncStore(
      resolveMarketplaceNetworkConfig({
        deploymentNetwork: "testnet"
      })
    );
    const requestIds: string[] = [];
    const { app, buyer } = await createTestApp({
      deploymentNetwork: "testnet",
      store,
      providers: {
        mock: {
          async execute(context: ProviderExecuteContext) {
            requestIds.push(context.requestId);
            return {
              kind: "async" as const,
              providerJobId: `provider_${context.requestId}`,
              pollAfterMs: 5_000,
              providerState: {
                requestId: context.requestId
              }
            };
          },
          async poll() {
            return {
              status: "pending" as const,
              pollAfterMs: 5_000,
              providerState: {}
            };
          }
        }
      }
    });

    const first = await request(app)
      .post("/api/mock/async-report")
      .set("X-PAYMENT", Buffer.from(JSON.stringify({ paid: true })).toString("base64"))
      .set("PAYMENT-IDENTIFIER", "payment_async_recovery_1")
      .send({ topic: "market depth", delayMs: 60_000 });

    expect(first.status).toBe(202);
    expect(first.body.jobToken).toBeDefined();
    expect(requestIds).toHaveLength(1);

    const second = await request(app)
      .post("/api/mock/async-report")
      .set("X-PAYMENT", Buffer.from(JSON.stringify({ paid: true })).toString("base64"))
      .set("PAYMENT-IDENTIFIER", "payment_async_recovery_1")
      .send({ topic: "market depth", delayMs: 60_000 });

    expect(second.status).toBe(202);
    expect(second.body).toEqual(first.body);
    expect(requestIds).toHaveLength(1);

    const challenge = await request(app)
      .post("/auth/challenge")
      .send({
        wallet: buyer.address,
        resourceType: "job",
        resourceId: first.body.jobToken
      });

    expect(challenge.status).toBe(200);

    const record = await store.getIdempotencyByPaymentId("payment_async_recovery_1");
    expect(record?.executionStatus).toBe("completed");
    expect(record?.requestId).toBe(requestIds[0]);
    expect(record?.jobToken).toBe(first.body.jobToken);
  });

  it("repairs a missing async job access grant when replaying an existing payment", async () => {
    const { app, buyer, store } = await createTestApp({
      deploymentNetwork: "testnet"
    });

    const accepted = await request(app)
      .post("/api/mock/async-report")
      .set("X-PAYMENT", Buffer.from(JSON.stringify({ paid: true })).toString("base64"))
      .set("PAYMENT-IDENTIFIER", "payment_async_replay_repair_1")
      .send({ topic: "market depth", delayMs: 60_000 });

    expect(accepted.status).toBe(202);
    const { jobToken } = accepted.body as { jobToken: string };

    const accessGrants = (store as unknown as {
      accessGrants: Map<string, unknown>;
    }).accessGrants;
    accessGrants.delete(`job:${jobToken}:${buyer.address}`);
    await store.completeJob(jobToken, { done: true });

    const replayed = await request(app)
      .post("/api/mock/async-report")
      .set("X-PAYMENT", Buffer.from(JSON.stringify({ paid: true })).toString("base64"))
      .set("PAYMENT-IDENTIFIER", "payment_async_replay_repair_1")
      .send({ topic: "market depth", delayMs: 60_000 });

    expect(replayed.status).toBe(202);
    expect(replayed.body).toEqual(accepted.body);

    const challenge = await request(app)
      .post("/auth/challenge")
      .send({
        wallet: buyer.address,
        resourceType: "job",
        resourceId: jobToken
      });

    expect(challenge.status).toBe(200);
  });

  it("creates a website wallet session from a signed challenge", async () => {
    const { app, buyer } = await createTestApp();

    const challenge = await request(app)
      .post("/auth/wallet/challenge")
      .send({
        wallet: buyer.address
      });

    expect(challenge.status).toBe(200);
    expect(challenge.body.resourceType).toBe("site");
    expect(challenge.body.resourceId).toBe("https://marketplace.example.com");

    const signed = await buyer.wallet.sign({ message: challenge.body.message });
    const session = await request(app)
      .post("/auth/wallet/session")
      .send({
        wallet: buyer.address,
        nonce: challenge.body.nonce,
        expiresAt: challenge.body.expiresAt,
        signature: signed.signature
      });

    expect(session.status).toBe(200);
    expect(session.body.wallet).toBe(buyer.address);
    expect(session.body.resourceType).toBe("site");
    expect(session.body.resourceId).toBe("https://marketplace.example.com");
    expect(session.body.accessToken).toBeDefined();
  });

  it("rejects a payment proof if the facilitator verifies the wrong Fast network", async () => {
    const buyer = await createTestWallet();
    const previousNetwork = process.env.MARKETPLACE_FAST_NETWORK;
    process.env.MARKETPLACE_FAST_NETWORK = "testnet";
    const app = createMarketplaceApi({
      store: new InMemoryMarketplaceStore(
        resolveMarketplaceNetworkConfig({
          deploymentNetwork: "testnet"
        })
      ),
      payTo: buyer.address,
      sessionSecret: "test-session-secret",
      secretsKey: "test-secrets-key",
      adminToken: "test-admin-token",
      facilitatorClient: {
        async verify() {
          return {
            isValid: true,
            payer: buyer.payerHex,
            network: "fast-mainnet"
          };
        }
      },
      refundService: {
        async issueRefund() {
          return { txHash: "0xrefund" };
        }
      },
      webBaseUrl: "https://marketplace.example.com"
    });
    if (previousNetwork === undefined) {
      delete process.env.MARKETPLACE_FAST_NETWORK;
    } else {
      process.env.MARKETPLACE_FAST_NETWORK = previousNetwork;
    }

    const response = await request(app)
      .post("/api/mock/quick-insight")
      .set("X-PAYMENT", Buffer.from(JSON.stringify({ paid: true })).toString("base64"))
      .set("PAYMENT-IDENTIFIER", "payment_wrong_network_1")
      .send({ query: "alpha" });

    expect(response.status).toBe(402);
    expect(response.body.error).toContain("Expected fast-testnet");
  });

  it("supports provider onboarding, review publish, and paid execution for a self-serve service", async () => {
    const providerWallet = await createTestWallet(PROVIDER_PRIVATE_KEY);
    const replacementPayoutWallet = await createTestWallet(OTHER_PRIVATE_KEY);
    const { app, buyer, store } = await createTestApp();
    const providerToken = await createSiteSession(app, providerWallet);

    const profile = await request(app)
      .post("/provider/me")
      .set("Authorization", `Bearer ${providerToken}`)
      .send({
        displayName: "Signal Labs",
        bio: "Quant feeds for agent workflows.",
        websiteUrl: "https://provider.example.com",
        contactEmail: "ops@provider.example.com"
      });

    expect(profile.status).toBe(201);

    const createdService = await request(app)
      .post("/provider/services")
      .set("Authorization", `Bearer ${providerToken}`)
      .send({
        serviceType: "marketplace_proxy",
        slug: "signal-labs",
        apiNamespace: "signals",
        name: "Signal Labs",
        tagline: "Short-form market signals",
        about: "Provider-authored signal endpoints.",
        categories: ["Research", "Trading"],
        promptIntro: 'I want to use the "Signal Labs" service on Fast Marketplace.',
        setupInstructions: ["Use a funded Fast wallet.", "Call the marketplace proxy route."],
        websiteUrl: "https://provider.example.com",
        payoutWallet: providerWallet.address
      });

    expect(createdService.status).toBe(201);
    const serviceId = createdService.body.service.id as string;
    const providerAccountId = createdService.body.account.id as string;

    const runtimeKeyResponse = await request(app)
      .post(`/provider/services/${serviceId}/runtime-key`)
      .set("Authorization", `Bearer ${providerToken}`)
      .send({});

    expect(runtimeKeyResponse.status).toBe(201);

    const createdEndpoint = await request(app)
      .post(`/provider/services/${serviceId}/endpoints`)
      .set("Authorization", `Bearer ${providerToken}`)
      .send({
        endpointType: "marketplace_proxy",
        operation: "quote",
        method: "POST",
        title: "Quote",
        description: "Return a single quote snapshot.",
        billingType: "fixed_x402",
        price: "$0.25",
        mode: "sync",
        requestSchemaJson: {
          type: "object",
          properties: {
            symbol: { type: "string", minLength: 1 }
          },
          required: ["symbol"],
          additionalProperties: false
        },
        responseSchemaJson: {
          type: "object",
          properties: {
            symbol: { type: "string" },
            price: { type: "number" }
          },
          required: ["symbol", "price"],
          additionalProperties: false
        },
        requestExample: {
          symbol: "FAST"
        },
        responseExample: {
          symbol: "FAST",
          price: 42.5
        },
        usageNotes: "Returns the latest quote only.",
        upstreamBaseUrl: "https://provider.example.com",
        upstreamPath: "/api/quote",
        upstreamAuthMode: "none"
      });

    expect(createdEndpoint.status).toBe(201);

    const updatedService = await request(app)
      .patch(`/provider/services/${serviceId}`)
      .set("Authorization", `Bearer ${providerToken}`)
      .send({
        payoutWallet: replacementPayoutWallet.address
      });

    expect(updatedService.status).toBe(200);

    const verificationChallenge = await request(app)
      .post(`/provider/services/${serviceId}/verification-challenge`)
      .set("Authorization", `Bearer ${providerToken}`);

    expect(verificationChallenge.status).toBe(200);

    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url === verificationChallenge.body.expectedUrl) {
        return new Response(verificationChallenge.body.token, { status: 200 });
      }

      if (url === "https://provider.example.com/api/quote") {
        return new Response(JSON.stringify({ symbol: "FAST", price: 42.5 }), {
          status: 200,
          headers: {
            "content-type": "application/json"
          }
        });
      }

      return new Response("not found", { status: 404 });
    });

    const verified = await request(app)
      .post(`/provider/services/${serviceId}/verify`)
      .set("Authorization", `Bearer ${providerToken}`);

    expect(verified.status).toBe(200);
    expect(verified.body.status).toBe("verified");

    const submitted = await request(app)
      .post(`/provider/services/${serviceId}/submit`)
      .set("Authorization", `Bearer ${providerToken}`);

    expect(submitted.status).toBe(202);
    expect(submitted.body.service.status).toBe("pending_review");

    const hiddenBeforePublish = await request(app).get("/catalog/services/signal-labs");
    expect(hiddenBeforePublish.status).toBe(404);

    const published = await request(app)
      .post(`/internal/provider-services/${serviceId}/publish`)
      .set("Authorization", "Bearer test-admin-token")
      .send({
        reviewerIdentity: "ops@test",
        settlementMode: "community_direct"
      });

    expect(published.status).toBe(200);
    expect(published.body.service.status).toBe("published");

    const publicList = await request(app).get("/catalog/services");
    expect(publicList.status).toBe(200);
    expect(publicList.body.services.some((service: { slug: string }) => service.slug === "signal-labs")).toBe(true);

    const publicDetail = await request(app).get("/catalog/services/signal-labs");
    expect(publicDetail.status).toBe(200);
    expect(publicDetail.body.summary.endpointCount).toBe(1);
    expect(publicDetail.body.endpoints[0].proxyUrl).toContain("/api/signals/quote");

    const openApi = await request(app).get("/openapi.json");
    expect(openApi.status).toBe(200);
    expect(openApi.body.paths["/api/signals/quote"]).toBeDefined();

    const unpaid = await request(app)
      .post("/api/signals/quote")
      .send({ symbol: "FAST" });

    expect(unpaid.status).toBe(402);
    expect(unpaid.body.accepts[0].payTo).toBe(replacementPayoutWallet.address);

    const paid = await request(app)
      .post("/api/signals/quote")
      .set("X-PAYMENT", Buffer.from(JSON.stringify({ paid: true })).toString("base64"))
      .set("PAYMENT-IDENTIFIER", "payment_provider_sync_1")
      .send({ symbol: "FAST" });

    expect(paid.status).toBe(200);
    expect(paid.body).toEqual({ symbol: "FAST", price: 42.5 });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://provider.example.com/api/quote",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "X-MARKETPLACE-BUYER-WALLET": buyer.address,
          "X-MARKETPLACE-SERVICE-ID": serviceId,
          "X-MARKETPLACE-PAYMENT-ID": "payment_provider_sync_1"
        })
      })
    );

    const record = await store.getIdempotencyByPaymentId("payment_provider_sync_1");
    expect(record?.routeId).toBe("signals.quote.v1");
    expect(record?.payoutSplit.providerAccountId).toBe(providerAccountId);
    expect(record?.payoutSplit.settlementMode).toBe("community_direct");
    expect(record?.payoutSplit.providerWallet).toBe(replacementPayoutWallet.address);
    expect(record?.payoutSplit.paymentDestinationWallet).toBe(replacementPayoutWallet.address);
    expect(record?.payoutSplit.usesTreasurySettlement).toBe(false);
    expect(record?.payoutSplit.providerAmount).toBe("250000");
    expect(record?.payoutSplit.marketplaceAmount).toBe("0");
    expect(await store.listPendingProviderPayouts(10)).toHaveLength(0);
  });

  it("supports provider onboarding, publish, and free execution for a self-serve service", async () => {
    const providerWallet = await createTestWallet(PROVIDER_PRIVATE_KEY);
    const { app, store } = await createTestApp();
    const providerToken = await createSiteSession(app, providerWallet);

    const profile = await request(app)
      .post("/provider/me")
      .set("Authorization", `Bearer ${providerToken}`)
      .send({
        displayName: "Signal Labs",
        websiteUrl: "https://provider.example.com"
      });

    expect(profile.status).toBe(201);

    const createdService = await request(app)
      .post("/provider/services")
      .set("Authorization", `Bearer ${providerToken}`)
      .send({
        serviceType: "marketplace_proxy",
        slug: "signal-labs-free",
        apiNamespace: "signals-free",
        name: "Signal Labs Free",
        tagline: "Free short-form market signals",
        about: "Provider-authored free signal endpoints.",
        categories: ["Research"],
        promptIntro: 'I want to use the "Signal Labs Free" service on Fast Marketplace.',
        setupInstructions: ["Call the marketplace proxy route."],
        websiteUrl: "https://provider.example.com",
        payoutWallet: providerWallet.address
      });

    expect(createdService.status).toBe(201);
    const serviceId = createdService.body.service.id as string;

    const runtimeKeyResponse = await request(app)
      .post(`/provider/services/${serviceId}/runtime-key`)
      .set("Authorization", `Bearer ${providerToken}`)
      .send({});

    expect(runtimeKeyResponse.status).toBe(201);
    const runtimeKey = runtimeKeyResponse.body.plaintextKey as string;

    const createdEndpoint = await request(app)
      .post(`/provider/services/${serviceId}/endpoints`)
      .set("Authorization", `Bearer ${providerToken}`)
      .send({
        endpointType: "marketplace_proxy",
        operation: "search",
        method: "POST",
        title: "Search",
        description: "Return a free signal snapshot.",
        billingType: "free",
        mode: "sync",
        requestSchemaJson: {
          type: "object",
          properties: {
            query: { type: "string", minLength: 1 }
          },
          required: ["query"],
          additionalProperties: false
        },
        responseSchemaJson: {
          type: "object",
          properties: {
            items: {
              type: "array",
              items: { type: "string" }
            }
          },
          required: ["items"],
          additionalProperties: false
        },
        requestExample: {
          query: "FAST"
        },
        responseExample: {
          items: ["alpha"]
        },
        upstreamBaseUrl: "https://provider.example.com",
        upstreamPath: "/api/search",
        upstreamAuthMode: "none"
      });

    expect(createdEndpoint.status).toBe(201);

    const verificationChallenge = await request(app)
      .post(`/provider/services/${serviceId}/verification-challenge`)
      .set("Authorization", `Bearer ${providerToken}`);

    expect(verificationChallenge.status).toBe(200);

    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === verificationChallenge.body.expectedUrl) {
        return new Response(verificationChallenge.body.token, { status: 200 });
      }

      if (url === "https://provider.example.com/api/search") {
        const headers = Object.fromEntries(new Headers(init?.headers).entries());
        const requestBody = JSON.parse(String(init?.body ?? "{}")) as { query?: string };
        const identity = verifyMarketplaceIdentityHeaders({
          headers,
          signingSecret: runtimeKey
        });

        expect(headers["x-marketplace-buyer-wallet"] ?? "").toBe("");
        expect(identity.buyerWallet).toBeNull();
        expect(identity.paymentId).toBeNull();
        expect(identity.serviceId).toBe(serviceId);
        expect(headers["x-marketplace-payment-id"]).toBe("");

        if (requestBody.query === "FAIL") {
          return new Response(JSON.stringify({ error: "upstream failed" }), {
            status: 502,
            headers: {
              "content-type": "application/json"
            }
          });
        }

        return new Response(JSON.stringify({ items: ["alpha"] }), {
          status: 200,
          headers: {
            "content-type": "application/json"
          }
        });
      }

      return new Response("not found", { status: 404 });
    });

    const verified = await request(app)
      .post(`/provider/services/${serviceId}/verify`)
      .set("Authorization", `Bearer ${providerToken}`);

    expect(verified.status).toBe(200);

    const submitted = await request(app)
      .post(`/provider/services/${serviceId}/submit`)
      .set("Authorization", `Bearer ${providerToken}`);

    expect(submitted.status).toBe(202);

    const published = await request(app)
      .post(`/internal/provider-services/${serviceId}/publish`)
      .set("Authorization", "Bearer test-admin-token")
      .send({
        reviewerIdentity: "ops@test",
        settlementMode: "verified_escrow"
      });

    expect(published.status).toBe(200);

    const publicDetail = await request(app).get("/catalog/services/signal-labs-free");
    expect(publicDetail.status).toBe(200);
    expect(publicDetail.body.endpoints[0].price).toBe("Free");

    const openApi = await request(app).get("/openapi.json");
    expect(openApi.status).toBe(200);
    expect(openApi.body.paths["/api/signals-free/search"].post.responses["402"]).toBeUndefined();
    expect(openApi.body.paths["/api/signals-free/search"].post.responses["202"]).toBeUndefined();
    expect(openApi.body.paths["/api/signals-free/search"].post.parameters).toEqual([]);

    const response = await request(app)
      .post("/api/signals-free/search")
      .send({ query: "FAST" });
    const failedResponse = await request(app)
      .post("/api/signals-free/search")
      .send({ query: "FAIL" });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ items: ["alpha"] });
    expect(failedResponse.status).toBe(502);
    expect(failedResponse.body).toEqual({ error: "upstream failed" });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://provider.example.com/api/search",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ query: "FAST" })
      })
    );

    const analytics = await store.getServiceAnalytics(["signals-free.search.v1"]);
    expect(analytics.totalCalls).toBe(2);
    expect(analytics.revenueRaw).toBe("0");
    expect(analytics.successRate30d).toBe(50);
  });

  it("accepts webhook callbacks for async free routes after runtime-key rotation", async () => {
    const providerWallet = await createTestWallet(PROVIDER_PRIVATE_KEY);
    const { app } = await createTestApp({
      baseUrl: "https://marketplace.example.com"
    });
    const providerToken = await createSiteSession(app, providerWallet);

    await request(app)
      .post("/provider/me")
      .set("Authorization", `Bearer ${providerToken}`)
      .send({
        displayName: "Signal Labs",
        websiteUrl: "https://provider.example.com"
      });

    const createdService = await request(app)
      .post("/provider/services")
      .set("Authorization", `Bearer ${providerToken}`)
      .send({
        serviceType: "marketplace_proxy",
        slug: "signal-labs-free-async",
        apiNamespace: "signals-free-async",
        name: "Signal Labs Free Async",
        tagline: "Free async signal snapshots",
        about: "Provider-authored async free signal endpoints.",
        categories: ["Research"],
        promptIntro: 'I want to use the "Signal Labs Free Async" service on Fast Marketplace.',
        setupInstructions: ["Call the marketplace proxy route."],
        websiteUrl: "https://provider.example.com",
        payoutWallet: providerWallet.address
      });

    expect(createdService.status).toBe(201);
    const serviceId = createdService.body.service.id as string;

    const runtimeKeyResponse = await request(app)
      .post(`/provider/services/${serviceId}/runtime-key`)
      .set("Authorization", `Bearer ${providerToken}`)
      .send({});

    expect(runtimeKeyResponse.status).toBe(201);
    const runtimeKey = runtimeKeyResponse.body.plaintextKey as string;

    const createdEndpoint = await request(app)
      .post(`/provider/services/${serviceId}/endpoints`)
      .set("Authorization", `Bearer ${providerToken}`)
      .send({
        endpointType: "marketplace_proxy",
        operation: "search",
        method: "POST",
        title: "Search",
        description: "Return a free async signal snapshot.",
        billingType: "free",
        mode: "async",
        asyncStrategy: "webhook",
        asyncTimeoutMs: 300000,
        requestSchemaJson: {
          type: "object",
          properties: {
            query: { type: "string", minLength: 1 }
          },
          required: ["query"],
          additionalProperties: false
        },
        responseSchemaJson: {
          type: "object",
          properties: {
            items: {
              type: "array",
              items: { type: "string" }
            }
          },
          required: ["items"],
          additionalProperties: false
        },
        requestExample: {
          query: "FAST"
        },
        responseExample: {
          items: ["alpha"]
        },
        upstreamBaseUrl: "https://provider.example.com",
        upstreamPath: "/api/search",
        upstreamAuthMode: "none"
      });

    expect(createdEndpoint.status).toBe(201);

    const verificationChallenge = await request(app)
      .post(`/provider/services/${serviceId}/verification-challenge`)
      .set("Authorization", `Bearer ${providerToken}`);

    let callbackUrl = "";
    let callbackAuth = "";

    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === verificationChallenge.body.expectedUrl) {
        return new Response(verificationChallenge.body.token, { status: 200 });
      }

      if (url === "https://provider.example.com/api/search") {
        const headers = Object.fromEntries(new Headers(init?.headers).entries());
        const identity = verifyMarketplaceIdentityHeaders({
          headers,
          signingSecret: runtimeKey
        });

        expect(identity.serviceId).toBe(serviceId);
        expect(identity.buyerWallet).toBe(providerWallet.address);

        callbackUrl = headers["x-marketplace-callback-url"] ?? "";
        callbackAuth = headers["x-marketplace-callback-auth"] ?? "";
        expect(headers["x-marketplace-job-token"]).toBeTruthy();

        return new Response(JSON.stringify({
          status: "accepted",
          providerJobId: "provider_job_1"
        }), {
          status: 202,
          headers: {
            "content-type": "application/json"
          }
        });
      }

      return new Response("not found", { status: 404 });
    });

    const verified = await request(app)
      .post(`/provider/services/${serviceId}/verify`)
      .set("Authorization", `Bearer ${providerToken}`);

    expect(verified.status).toBe(200);

    const submitted = await request(app)
      .post(`/provider/services/${serviceId}/submit`)
      .set("Authorization", `Bearer ${providerToken}`);

    expect(submitted.status).toBe(202);

    const published = await request(app)
      .post(`/internal/provider-services/${serviceId}/publish`)
      .set("Authorization", "Bearer test-admin-token")
      .send({
        reviewerIdentity: "ops@test",
        settlementMode: "verified_escrow"
      });

    expect(published.status).toBe(200);

    const challenge = await request(app)
      .post("/auth/challenge")
      .send({
        wallet: providerWallet.address,
        resourceType: "api",
        resourceId: "signals-free-async.search.v1"
      });

    expect(challenge.status).toBe(200);

    const signed = await providerWallet.wallet.sign({ message: challenge.body.message });
    const apiSession = await request(app)
      .post("/auth/session")
      .send({
        wallet: providerWallet.address,
        resourceType: "api",
        resourceId: "signals-free-async.search.v1",
        nonce: challenge.body.nonce,
        expiresAt: challenge.body.expiresAt,
        signature: signed.signature
      });

    expect(apiSession.status).toBe(200);

    const accepted = await request(app)
      .post("/api/signals-free-async/search")
      .set("Authorization", `Bearer ${apiSession.body.accessToken}`)
      .send({ query: "FAST" });

    expect(accepted.status).toBe(202);
    expect(callbackUrl).toContain(`/provider/runtime/jobs/${accepted.body.jobToken}/callback`);
    expect(callbackAuth.startsWith("Bearer ")).toBe(true);

    const rotatedRuntimeKey = await request(app)
      .post(`/provider/services/${serviceId}/runtime-key`)
      .set("Authorization", `Bearer ${providerToken}`)
      .send({});

    expect(rotatedRuntimeKey.status).toBe(201);
    expect(rotatedRuntimeKey.body.plaintextKey).not.toBe(runtimeKey);

    const callbackBody = {
      providerJobId: "provider_job_1",
      status: "completed",
      result: { items: ["alpha"] }
    };
    const callbackPath = new URL(callbackUrl).pathname;
    const callbackHeaders = buildMarketplaceCallbackHeaders({
      method: "POST",
      path: callbackPath,
      body: JSON.stringify(callbackBody),
      sharedSecret: callbackAuth.replace(/^Bearer\s+/u, "")
    });

    const callbackResponse = await request(app)
      .post(callbackPath)
      .set("Authorization", callbackHeaders.authorization)
      .set("X-Marketplace-Timestamp", callbackHeaders["X-MARKETPLACE-TIMESTAMP"])
      .set("X-Marketplace-Signature", callbackHeaders["X-MARKETPLACE-SIGNATURE"])
      .send(callbackBody);

    expect(callbackResponse.status).toBe(200);
    expect(callbackResponse.body.status).toBe("completed");
    expect(callbackResponse.body.result).toEqual({ items: ["alpha"] });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://provider.example.com/api/search",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ query: "FAST" })
      })
    );
  });

  it("accepts webhook callbacks that arrive before async acceptance is persisted", async () => {
    const providerWallet = await createTestWallet(PROVIDER_PRIVATE_KEY);
    const { app } = await createTestApp({
      baseUrl: "https://marketplace.example.com"
    });
    const providerToken = await createSiteSession(app, providerWallet);

    await request(app)
      .post("/provider/me")
      .set("Authorization", `Bearer ${providerToken}`)
      .send({
        displayName: "Signal Labs",
        websiteUrl: "https://provider.example.com"
      });

    const createdService = await request(app)
      .post("/provider/services")
      .set("Authorization", `Bearer ${providerToken}`)
      .send({
        serviceType: "marketplace_proxy",
        slug: "signals-free-async-early-callback",
        apiNamespace: "signals-free-async-early",
        name: "Signal Labs Free Async Early",
        tagline: "Async callbacks can arrive immediately",
        about: "Provider-authored signal endpoints.",
        categories: ["Research"],
        promptIntro: 'I want to use the "Signal Labs Free Async Early" service on Fast Marketplace.',
        setupInstructions: ["Use a funded Fast wallet."],
        websiteUrl: "https://provider.example.com",
        payoutWallet: providerWallet.address
      });

    expect(createdService.status).toBe(201);
    const serviceId = createdService.body.service.id as string;

    const runtimeKeyResponse = await request(app)
      .post(`/provider/services/${serviceId}/runtime-key`)
      .set("Authorization", `Bearer ${providerToken}`)
      .send({});

    expect(runtimeKeyResponse.status).toBe(201);
    const runtimeKey = runtimeKeyResponse.body.plaintextKey as string;

    const createdEndpoint = await request(app)
      .post(`/provider/services/${serviceId}/endpoints`)
      .set("Authorization", `Bearer ${providerToken}`)
      .send({
        endpointType: "marketplace_proxy",
        operation: "search",
        method: "POST",
        title: "Search",
        description: "Return a free async signal snapshot.",
        billingType: "free",
        mode: "async",
        asyncStrategy: "webhook",
        asyncTimeoutMs: 300000,
        requestSchemaJson: {
          type: "object",
          properties: {
            query: { type: "string", minLength: 1 }
          },
          required: ["query"],
          additionalProperties: false
        },
        responseSchemaJson: {
          type: "object",
          properties: {
            items: {
              type: "array",
              items: { type: "string" }
            }
          },
          required: ["items"],
          additionalProperties: false
        },
        requestExample: {
          query: "FAST"
        },
        responseExample: {
          items: ["alpha"]
        },
        upstreamBaseUrl: "https://provider.example.com",
        upstreamPath: "/api/search",
        upstreamAuthMode: "none"
      });

    expect(createdEndpoint.status).toBe(201);

    const verificationChallenge = await request(app)
      .post(`/provider/services/${serviceId}/verification-challenge`)
      .set("Authorization", `Bearer ${providerToken}`);

    let earlyCallbackStatus = 0;

    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === verificationChallenge.body.expectedUrl) {
        return new Response(verificationChallenge.body.token, { status: 200 });
      }

      if (url === "https://provider.example.com/api/search") {
        const headers = Object.fromEntries(new Headers(init?.headers).entries());
        const identity = verifyMarketplaceIdentityHeaders({
          headers,
          signingSecret: runtimeKey
        });

        expect(identity.serviceId).toBe(serviceId);
        expect(identity.buyerWallet).toBe(providerWallet.address);

        const callbackUrl = headers["x-marketplace-callback-url"] ?? "";
        const callbackAuth = headers["x-marketplace-callback-auth"] ?? "";
        const callbackPath = new URL(callbackUrl).pathname;
        const callbackBody = {
          providerJobId: "provider_job_early_1",
          status: "completed",
          result: { items: ["alpha"] }
        };
        const callbackHeaders = buildMarketplaceCallbackHeaders({
          method: "POST",
          path: callbackPath,
          body: JSON.stringify(callbackBody),
          sharedSecret: callbackAuth.replace(/^Bearer\s+/u, "")
        });

        const callbackResponse = await request(app)
          .post(callbackPath)
          .set("Authorization", callbackHeaders.authorization)
          .set("X-Marketplace-Timestamp", callbackHeaders["X-MARKETPLACE-TIMESTAMP"])
          .set("X-Marketplace-Signature", callbackHeaders["X-MARKETPLACE-SIGNATURE"])
          .send(callbackBody);

        earlyCallbackStatus = callbackResponse.status;
        expect(callbackResponse.body.status).toBe("completed");

        return new Response(JSON.stringify({
          status: "accepted",
          providerJobId: "provider_job_early_1"
        }), {
          status: 202,
          headers: {
            "content-type": "application/json"
          }
        });
      }

      return new Response("not found", { status: 404 });
    });

    const verified = await request(app)
      .post(`/provider/services/${serviceId}/verify`)
      .set("Authorization", `Bearer ${providerToken}`);

    expect(verified.status).toBe(200);

    const submitted = await request(app)
      .post(`/provider/services/${serviceId}/submit`)
      .set("Authorization", `Bearer ${providerToken}`);

    expect(submitted.status).toBe(202);

    const published = await request(app)
      .post(`/internal/provider-services/${serviceId}/publish`)
      .set("Authorization", "Bearer test-admin-token")
      .send({
        reviewerIdentity: "ops@test",
        settlementMode: "verified_escrow"
      });

    expect(published.status).toBe(200);

    const challenge = await request(app)
      .post("/auth/challenge")
      .send({
        wallet: providerWallet.address,
        resourceType: "api",
        resourceId: "signals-free-async-early.search.v1"
      });

    expect(challenge.status).toBe(200);

    const signed = await providerWallet.wallet.sign({ message: challenge.body.message });
    const apiSession = await request(app)
      .post("/auth/session")
      .send({
        wallet: providerWallet.address,
        resourceType: "api",
        resourceId: "signals-free-async-early.search.v1",
        nonce: challenge.body.nonce,
        expiresAt: challenge.body.expiresAt,
        signature: signed.signature
      });

    expect(apiSession.status).toBe(200);

    const accepted = await request(app)
      .post("/api/signals-free-async-early/search")
      .set("Authorization", `Bearer ${apiSession.body.accessToken}`)
      .send({ query: "FAST" });

    expect(accepted.status).toBe(202);
    expect(earlyCallbackStatus).toBe(200);

    const jobChallenge = await request(app)
      .post("/auth/challenge")
      .send({
        wallet: providerWallet.address,
        resourceType: "job",
        resourceId: accepted.body.jobToken
      });

    expect(jobChallenge.status).toBe(200);

    const signedJob = await providerWallet.wallet.sign({ message: jobChallenge.body.message });
    const jobSession = await request(app)
      .post("/auth/session")
      .send({
        wallet: providerWallet.address,
        resourceType: "job",
        resourceId: accepted.body.jobToken,
        nonce: jobChallenge.body.nonce,
        expiresAt: jobChallenge.body.expiresAt,
        signature: signedJob.signature
      });

    expect(jobSession.status).toBe(200);

    const retrieved = await request(app)
      .get(`/api/jobs/${accepted.body.jobToken}`)
      .set("Authorization", `Bearer ${jobSession.body.accessToken}`);

    expect(retrieved.status).toBe(200);
    expect(retrieved.body.status).toBe("completed");
    expect(retrieved.body.result).toEqual({ items: ["alpha"] });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://provider.example.com/api/search",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ query: "FAST" })
      })
    );
  });

  it("keeps wallet-session async jobs reachable without saveAsyncAcceptance", async () => {
    class WalletSessionAsyncStore extends InMemoryMarketplaceStore {
      override async saveAsyncAcceptance(): Promise<never> {
        throw new Error("wallet-session async routes should not call saveAsyncAcceptance");
      }
    }

    const providerWallet = await createTestWallet(PROVIDER_PRIVATE_KEY);
    const store = new WalletSessionAsyncStore(
      resolveMarketplaceNetworkConfig({
        deploymentNetwork: "mainnet"
      })
    );
    const { app } = await createTestApp({
      baseUrl: "https://marketplace.example.com",
      store
    });
    const providerToken = await createSiteSession(app, providerWallet);

    await request(app)
      .post("/provider/me")
      .set("Authorization", `Bearer ${providerToken}`)
      .send({
        displayName: "Signal Labs Wallet Session",
        websiteUrl: "https://provider.example.com"
      });

    const createdService = await request(app)
      .post("/provider/services")
      .set("Authorization", `Bearer ${providerToken}`)
      .send({
        serviceType: "marketplace_proxy",
        slug: "signals-free-async-wallet-safe",
        apiNamespace: "signals-free-async-wallet-safe",
        name: "Signal Labs Wallet Session Safe",
        tagline: "Wallet-session async does not rely on saveAsyncAcceptance",
        about: "Provider-authored signal endpoints.",
        categories: ["Research"],
        promptIntro: 'I want to use the "Signal Labs Wallet Session Safe" service on Fast Marketplace.',
        setupInstructions: ["Use a funded Fast wallet."],
        websiteUrl: "https://provider.example.com",
        payoutWallet: providerWallet.address
      });

    expect(createdService.status).toBe(201);
    const serviceId = createdService.body.service.id as string;

    const runtimeKeyResponse = await request(app)
      .post(`/provider/services/${serviceId}/runtime-key`)
      .set("Authorization", `Bearer ${providerToken}`)
      .send({});

    expect(runtimeKeyResponse.status).toBe(201);
    const runtimeKey = runtimeKeyResponse.body.plaintextKey as string;

    const createdEndpoint = await request(app)
      .post(`/provider/services/${serviceId}/endpoints`)
      .set("Authorization", `Bearer ${providerToken}`)
      .send({
        endpointType: "marketplace_proxy",
        operation: "search",
        method: "POST",
        title: "Search",
        description: "Return a free async signal snapshot.",
        billingType: "free",
        mode: "async",
        asyncStrategy: "webhook",
        asyncTimeoutMs: 300000,
        requestSchemaJson: {
          type: "object",
          properties: {
            query: { type: "string", minLength: 1 }
          },
          required: ["query"],
          additionalProperties: false
        },
        responseSchemaJson: {
          type: "object",
          properties: {
            items: {
              type: "array",
              items: { type: "string" }
            }
          },
          required: ["items"],
          additionalProperties: false
        },
        requestExample: {
          query: "FAST"
        },
        responseExample: {
          items: ["alpha"]
        },
        upstreamBaseUrl: "https://provider.example.com",
        upstreamPath: "/api/search",
        upstreamAuthMode: "none"
      });

    expect(createdEndpoint.status).toBe(201);

    const verificationChallenge = await request(app)
      .post(`/provider/services/${serviceId}/verification-challenge`)
      .set("Authorization", `Bearer ${providerToken}`);

    let earlyCallbackStatus = 0;

    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === verificationChallenge.body.expectedUrl) {
        return new Response(verificationChallenge.body.token, { status: 200 });
      }

      if (url === "https://provider.example.com/api/search") {
        const headers = Object.fromEntries(new Headers(init?.headers).entries());
        const identity = verifyMarketplaceIdentityHeaders({
          headers,
          signingSecret: runtimeKey
        });

        expect(identity.serviceId).toBe(serviceId);
        expect(identity.buyerWallet).toBe(providerWallet.address);

        const callbackUrl = headers["x-marketplace-callback-url"] ?? "";
        const callbackAuth = headers["x-marketplace-callback-auth"] ?? "";
        const callbackPath = new URL(callbackUrl).pathname;
        const callbackBody = {
          providerJobId: "provider_job_wallet_safe_1",
          status: "completed",
          result: { items: ["alpha"] }
        };
        const callbackHeaders = buildMarketplaceCallbackHeaders({
          method: "POST",
          path: callbackPath,
          body: JSON.stringify(callbackBody),
          sharedSecret: callbackAuth.replace(/^Bearer\s+/u, "")
        });

        const callbackResponse = await request(app)
          .post(callbackPath)
          .set("Authorization", callbackHeaders.authorization)
          .set("X-Marketplace-Timestamp", callbackHeaders["X-MARKETPLACE-TIMESTAMP"])
          .set("X-Marketplace-Signature", callbackHeaders["X-MARKETPLACE-SIGNATURE"])
          .send(callbackBody);

        earlyCallbackStatus = callbackResponse.status;

        return new Response(JSON.stringify({
          status: "accepted",
          providerJobId: "provider_job_wallet_safe_1"
        }), {
          status: 202,
          headers: {
            "content-type": "application/json"
          }
        });
      }

      return new Response("not found", { status: 404 });
    });

    expect(
      await request(app)
        .post(`/provider/services/${serviceId}/verify`)
        .set("Authorization", `Bearer ${providerToken}`)
    ).toMatchObject({ status: 200 });
    expect(
      await request(app)
        .post(`/provider/services/${serviceId}/submit`)
        .set("Authorization", `Bearer ${providerToken}`)
    ).toMatchObject({ status: 202 });
    expect(
      await request(app)
        .post(`/internal/provider-services/${serviceId}/publish`)
        .set("Authorization", "Bearer test-admin-token")
        .send({
          reviewerIdentity: "ops@test",
          settlementMode: "verified_escrow"
        })
    ).toMatchObject({ status: 200 });

    const challenge = await request(app)
      .post("/auth/challenge")
      .send({
        wallet: providerWallet.address,
        resourceType: "api",
        resourceId: "signals-free-async-wallet-safe.search.v1"
      });

    expect(challenge.status).toBe(200);

    const signed = await providerWallet.wallet.sign({ message: challenge.body.message });
    const apiSession = await request(app)
      .post("/auth/session")
      .send({
        wallet: providerWallet.address,
        resourceType: "api",
        resourceId: "signals-free-async-wallet-safe.search.v1",
        nonce: challenge.body.nonce,
        expiresAt: challenge.body.expiresAt,
        signature: signed.signature
      });

    expect(apiSession.status).toBe(200);

    const accepted = await request(app)
      .post("/api/signals-free-async-wallet-safe/search")
      .set("Authorization", `Bearer ${apiSession.body.accessToken}`)
      .send({ query: "FAST" });

    expect(accepted.status).toBe(202);
    expect(earlyCallbackStatus).toBe(200);

    const jobChallenge = await request(app)
      .post("/auth/challenge")
      .send({
        wallet: providerWallet.address,
        resourceType: "job",
        resourceId: accepted.body.jobToken
      });

    expect(jobChallenge.status).toBe(200);

    const signedJob = await providerWallet.wallet.sign({ message: jobChallenge.body.message });
    const jobSession = await request(app)
      .post("/auth/session")
      .send({
        wallet: providerWallet.address,
        resourceType: "job",
        resourceId: accepted.body.jobToken,
        nonce: jobChallenge.body.nonce,
        expiresAt: jobChallenge.body.expiresAt,
        signature: signedJob.signature
      });

    expect(jobSession.status).toBe(200);

    const retrieved = await request(app)
      .get(`/api/jobs/${accepted.body.jobToken}`)
      .set("Authorization", `Bearer ${jobSession.body.accessToken}`);

    expect(retrieved.status).toBe(200);
    expect(retrieved.body.status).toBe("completed");
    expect(retrieved.body.result).toEqual({ items: ["alpha"] });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://provider.example.com/api/search",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ query: "FAST" })
      })
    );
  });

  it("returns the wallet-session job token and lets the worker repair poll metadata when the accepted placeholder update fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});

    class WalletSessionPendingStore extends InMemoryMarketplaceStore {
      private failAcceptedPlaceholderWrite = true;

      override async savePendingAsyncJob(input: Parameters<InMemoryMarketplaceStore["savePendingAsyncJob"]>[0]) {
        if (this.failAcceptedPlaceholderWrite && input.providerJobId) {
          this.failAcceptedPlaceholderWrite = false;
          throw new Error("accepted wallet-session placeholder write failed");
        }

        return super.savePendingAsyncJob(input);
      }
    }

    const providerWallet = await createTestWallet(PROVIDER_PRIVATE_KEY);
    const store = new WalletSessionPendingStore(
      resolveMarketplaceNetworkConfig({
        deploymentNetwork: "mainnet"
      })
    );
    const { app } = await createTestApp({
      baseUrl: "https://marketplace.example.com",
      store
    });
    const providerToken = await createSiteSession(app, providerWallet);

    expect(
      await request(app)
        .post("/provider/me")
        .set("Authorization", `Bearer ${providerToken}`)
        .send({
          displayName: "Signal Labs Wallet Pending Repair",
          websiteUrl: "https://provider.example.com"
        })
    ).toMatchObject({ status: 201 });

    const createdService = await request(app)
      .post("/provider/services")
      .set("Authorization", `Bearer ${providerToken}`)
      .send({
        serviceType: "marketplace_proxy",
        slug: "signals-free-async-wallet-repair",
        apiNamespace: "signals-free-async-wallet-repair",
        name: "Signal Labs Wallet Pending Repair",
        tagline: "Wallet-session async survives accepted placeholder write failures",
        about: "Provider-authored signal endpoints.",
        categories: ["Research"],
        promptIntro: 'I want to use the "Signal Labs Wallet Pending Repair" service on Fast Marketplace.',
        setupInstructions: ["Use a funded Fast wallet."],
        websiteUrl: "https://provider.example.com",
        payoutWallet: providerWallet.address
      });

    expect(createdService.status).toBe(201);
    const serviceId = createdService.body.service.id as string;

    const runtimeKeyResponse = await request(app)
      .post(`/provider/services/${serviceId}/runtime-key`)
      .set("Authorization", `Bearer ${providerToken}`)
      .send({});

    expect(runtimeKeyResponse.status).toBe(201);
    const runtimeKey = runtimeKeyResponse.body.plaintextKey as string;

    expect(
      await request(app)
        .post(`/provider/services/${serviceId}/endpoints`)
        .set("Authorization", `Bearer ${providerToken}`)
        .send({
          endpointType: "marketplace_proxy",
          operation: "search",
          method: "POST",
          title: "Search",
          description: "Return a free async signal snapshot.",
          billingType: "free",
          mode: "async",
          asyncStrategy: "poll",
          asyncTimeoutMs: 300000,
          pollPath: "/api/poll",
          requestSchemaJson: {
            type: "object",
            properties: {
              query: { type: "string", minLength: 1 }
            },
            required: ["query"],
            additionalProperties: false
          },
          responseSchemaJson: {
            type: "object",
            properties: {
              items: {
                type: "array",
                items: { type: "string" }
              }
            },
            required: ["items"],
            additionalProperties: false
          },
          requestExample: {
            query: "FAST"
          },
          responseExample: {
            items: ["alpha"]
          },
          upstreamBaseUrl: "https://provider.example.com",
          upstreamPath: "/api/search",
          upstreamAuthMode: "none"
        })
    ).toMatchObject({ status: 201 });

    const verificationChallenge = await request(app)
      .post(`/provider/services/${serviceId}/verification-challenge`)
      .set("Authorization", `Bearer ${providerToken}`);

    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === verificationChallenge.body.expectedUrl) {
        return new Response(verificationChallenge.body.token, { status: 200 });
      }

      if (url === "https://provider.example.com/api/search") {
        const headers = Object.fromEntries(new Headers(init?.headers).entries());
        const identity = verifyMarketplaceIdentityHeaders({
          headers,
          signingSecret: runtimeKey
        });

        expect(identity.serviceId).toBe(serviceId);
        expect(identity.buyerWallet).toBe(providerWallet.address);

        return new Response(JSON.stringify({
          status: "accepted",
          providerJobId: "provider_job_wallet_repair_1",
          pollAfterMs: 5_000,
          providerState: {
            query: "FAST",
            readyAt: Date.now() + 60_000
          }
        }), {
          status: 202,
          headers: {
            "content-type": "application/json"
          }
        });
      }

      return new Response("not found", { status: 404 });
    });

    expect(
      await request(app)
        .post(`/provider/services/${serviceId}/verify`)
        .set("Authorization", `Bearer ${providerToken}`)
    ).toMatchObject({ status: 200 });
    expect(
      await request(app)
        .post(`/provider/services/${serviceId}/submit`)
        .set("Authorization", `Bearer ${providerToken}`)
    ).toMatchObject({ status: 202 });
    expect(
      await request(app)
        .post(`/internal/provider-services/${serviceId}/publish`)
        .set("Authorization", "Bearer test-admin-token")
        .send({
          reviewerIdentity: "ops@test",
          settlementMode: "verified_escrow"
        })
    ).toMatchObject({ status: 200 });

    const challenge = await request(app)
      .post("/auth/challenge")
      .send({
        wallet: providerWallet.address,
        resourceType: "api",
        resourceId: "signals-free-async-wallet-repair.search.v1"
      });

    expect(challenge.status).toBe(200);

    const signed = await providerWallet.wallet.sign({ message: challenge.body.message });
    const apiSession = await request(app)
      .post("/auth/session")
      .send({
        wallet: providerWallet.address,
        resourceType: "api",
        resourceId: "signals-free-async-wallet-repair.search.v1",
        nonce: challenge.body.nonce,
        expiresAt: challenge.body.expiresAt,
        signature: signed.signature
      });

    expect(apiSession.status).toBe(200);

    const accepted = await request(app)
      .post("/api/signals-free-async-wallet-repair/search")
      .set("Authorization", `Bearer ${apiSession.body.accessToken}`)
      .send({ query: "FAST" });

    expect(accepted.status).toBe(202);
    expect(accepted.body.jobToken).toBeDefined();

    const challengeJob = await request(app)
      .post("/auth/challenge")
      .send({
        wallet: providerWallet.address,
        resourceType: "job",
        resourceId: accepted.body.jobToken
      });

    expect(challengeJob.status).toBe(200);

    const signedJob = await providerWallet.wallet.sign({ message: challengeJob.body.message });
    const jobSession = await request(app)
      .post("/auth/session")
      .send({
        wallet: providerWallet.address,
        resourceType: "job",
        resourceId: accepted.body.jobToken,
        nonce: challengeJob.body.nonce,
        expiresAt: challengeJob.body.expiresAt,
        signature: signedJob.signature
      });

    expect(jobSession.status).toBe(200);

    const pendingJob = await request(app)
      .get(`/api/jobs/${accepted.body.jobToken}`)
      .set("Authorization", `Bearer ${jobSession.body.accessToken}`);

    expect(pendingJob.status).toBe(200);
    expect(pendingJob.body.status).toBe("pending");

    expect((await store.getJob(accepted.body.jobToken))?.providerJobId).toBeNull();
    await store.updateJobPending({
      jobToken: accepted.body.jobToken,
      nextPollAt: new Date(Date.now() - 1_000).toISOString()
    });

    await runMarketplaceWorkerCycle({
      store,
      secretsKey: "test-secrets-key",
      refundService: {
        async issueRefund() {
          return { txHash: "0xwallet-repair-refund" };
        }
      }
    });

    const repairedJob = await store.getJob(accepted.body.jobToken);
    expect(repairedJob?.providerJobId).toBe("provider_job_wallet_repair_1");
    expect(repairedJob?.providerState).toEqual({
      query: "FAST",
      readyAt: expect.any(Number)
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://provider.example.com/api/search",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ query: "FAST" })
      })
    );
  });

  it("supports fixed-price GET routes with x402 preflight and wrong-method 405", async () => {
    const providerWallet = await createTestWallet(PROVIDER_PRIVATE_KEY);
    const { app } = await createTestApp();
    const providerToken = await createSiteSession(app, providerWallet);

    await request(app)
      .post("/provider/me")
      .set("Authorization", `Bearer ${providerToken}`)
      .send({
        displayName: "Signal Labs",
        websiteUrl: "https://provider.example.com"
      });

    const createdService = await request(app)
      .post("/provider/services")
      .set("Authorization", `Bearer ${providerToken}`)
      .send({
        serviceType: "marketplace_proxy",
        slug: "signal-labs-get",
        apiNamespace: "signals-get",
        name: "Signal Labs GET",
        tagline: "Query-first market signals",
        about: "Provider-authored signal endpoints.",
        categories: ["Research"],
        promptIntro: 'I want to use the "Signal Labs GET" service on Fast Marketplace.',
        setupInstructions: ["Use a funded Fast wallet."],
        websiteUrl: "https://provider.example.com",
        payoutWallet: providerWallet.address
      });

    expect(createdService.status).toBe(201);
    const serviceId = createdService.body.service.id as string;

    const createdEndpoint = await request(app)
      .post(`/provider/services/${serviceId}/endpoints`)
      .set("Authorization", `Bearer ${providerToken}`)
      .send({
        endpointType: "marketplace_proxy",
        operation: "quote",
        method: "GET",
        title: "Quote",
        description: "Return a single quote snapshot.",
        billingType: "fixed_x402",
        price: "$0.25",
        mode: "sync",
        requestSchemaJson: {
          type: "object",
          properties: {
            symbol: { type: "string" }
          },
          required: ["symbol"],
          additionalProperties: false
        },
        responseSchemaJson: {
          type: "object",
          properties: {
            symbol: { type: "string" },
            price: { type: "number" }
          },
          required: ["symbol", "price"],
          additionalProperties: false
        },
        requestExample: { symbol: "FAST" },
        responseExample: { symbol: "FAST", price: 42.5 },
        upstreamBaseUrl: "https://provider.example.com",
        upstreamPath: "/api/quote",
        upstreamAuthMode: "none"
      });

    expect(createdEndpoint.status).toBe(201);

    const verificationChallenge = await request(app)
      .post(`/provider/services/${serviceId}/verification-challenge`)
      .set("Authorization", `Bearer ${providerToken}`);

    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === verificationChallenge.body.expectedUrl) {
        return new Response(verificationChallenge.body.token, { status: 200 });
      }

      if (url === "https://provider.example.com/api/quote?symbol=FAST") {
        expect(init?.method).toBe("GET");
        expect(init?.body).toBeUndefined();
        return new Response(JSON.stringify({ symbol: "FAST", price: 42.5 }), {
          status: 200,
          headers: {
            "content-type": "application/json"
          }
        });
      }

      return new Response("not found", { status: 404 });
    });

    expect(
      await request(app)
        .post(`/provider/services/${serviceId}/verify`)
        .set("Authorization", `Bearer ${providerToken}`)
    ).toMatchObject({ status: 200 });

    expect(
      await request(app)
        .post(`/provider/services/${serviceId}/submit`)
        .set("Authorization", `Bearer ${providerToken}`)
    ).toMatchObject({ status: 202 });

    expect(
      await request(app)
        .post(`/internal/provider-services/${serviceId}/publish`)
        .set("Authorization", "Bearer test-admin-token")
        .send({
          reviewerIdentity: "ops@test",
          settlementMode: "verified_escrow"
        })
    ).toMatchObject({ status: 200 });

    const openApi = await request(app).get("/openapi.json");
    expect(openApi.status).toBe(200);
    expect(openApi.body.paths["/api/signals-get/quote"].get.requestBody).toBeUndefined();
    expect(openApi.body.paths["/api/signals-get/quote"].get.parameters).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: "symbol",
        in: "query",
        required: true
      })
    ]));
    expect(openApi.body.paths["/api/signals-get/quote"].post).toBeUndefined();

    const wrongMethod = await request(app)
      .post("/api/signals-get/quote")
      .send({ symbol: "FAST" });

    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.allow).toBe("GET");

    const unpaid = await request(app)
      .get("/api/signals-get/quote")
      .query({ symbol: "FAST" });

    expect(unpaid.status).toBe(402);

    const paid = await request(app)
      .get("/api/signals-get/quote")
      .query({ symbol: "FAST" })
      .set("X-PAYMENT", Buffer.from(JSON.stringify({ paid: true })).toString("base64"))
      .set("PAYMENT-IDENTIFIER", "payment_provider_get_1");

    expect(paid.status).toBe(200);
    expect(paid.body).toEqual({ symbol: "FAST", price: 42.5 });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://provider.example.com/api/quote?symbol=FAST",
      expect.objectContaining({
        method: "GET"
      })
    );
  });

  it("supports free GET execution for a self-serve service", async () => {
    const providerWallet = await createTestWallet(PROVIDER_PRIVATE_KEY);
    const { app, store } = await createTestApp();
    const providerToken = await createSiteSession(app, providerWallet);

    await request(app)
      .post("/provider/me")
      .set("Authorization", `Bearer ${providerToken}`)
      .send({
        displayName: "Signal Labs",
        websiteUrl: "https://provider.example.com"
      });

    const createdService = await request(app)
      .post("/provider/services")
      .set("Authorization", `Bearer ${providerToken}`)
      .send({
        serviceType: "marketplace_proxy",
        slug: "signal-labs-free-get",
        apiNamespace: "signals-free-get",
        name: "Signal Labs Free GET",
        tagline: "Query-first free signals",
        about: "Provider-authored signal endpoints.",
        categories: ["Research"],
        promptIntro: 'I want to use the "Signal Labs Free GET" service on Fast Marketplace.',
        setupInstructions: ["Use a funded Fast wallet."],
        websiteUrl: "https://provider.example.com",
        payoutWallet: providerWallet.address
      });

    expect(createdService.status).toBe(201);
    const serviceId = createdService.body.service.id as string;

    const createdEndpoint = await request(app)
      .post(`/provider/services/${serviceId}/endpoints`)
      .set("Authorization", `Bearer ${providerToken}`)
      .send({
        endpointType: "marketplace_proxy",
        operation: "search",
        method: "GET",
        title: "Search",
        description: "Return a free signal snapshot.",
        billingType: "free",
        mode: "sync",
        requestSchemaJson: {
          type: "object",
          properties: {
            query: { type: "string" }
          },
          required: ["query"],
          additionalProperties: false
        },
        responseSchemaJson: {
          type: "object",
          properties: {
            items: {
              type: "array",
              items: { type: "string" }
            }
          },
          required: ["items"],
          additionalProperties: false
        },
        requestExample: { query: "FAST" },
        responseExample: { items: ["alpha"] },
        upstreamBaseUrl: "https://provider.example.com",
        upstreamPath: "/api/search",
        upstreamAuthMode: "none"
      });

    expect(createdEndpoint.status).toBe(201);

    const verificationChallenge = await request(app)
      .post(`/provider/services/${serviceId}/verification-challenge`)
      .set("Authorization", `Bearer ${providerToken}`);

    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === verificationChallenge.body.expectedUrl) {
        return new Response(verificationChallenge.body.token, { status: 200 });
      }

      if (url === "https://provider.example.com/api/search?query=FAST") {
        expect(init?.method).toBe("GET");
        expect(init?.body).toBeUndefined();
        return new Response(JSON.stringify({ items: ["alpha"] }), {
          status: 200,
          headers: {
            "content-type": "application/json"
          }
        });
      }

      return new Response("not found", { status: 404 });
    });

    expect(
      await request(app)
        .post(`/provider/services/${serviceId}/verify`)
        .set("Authorization", `Bearer ${providerToken}`)
    ).toMatchObject({ status: 200 });
    expect(
      await request(app)
        .post(`/provider/services/${serviceId}/submit`)
        .set("Authorization", `Bearer ${providerToken}`)
    ).toMatchObject({ status: 202 });
    expect(
      await request(app)
        .post(`/internal/provider-services/${serviceId}/publish`)
        .set("Authorization", "Bearer test-admin-token")
        .send({
          reviewerIdentity: "ops@test",
          settlementMode: "verified_escrow"
        })
    ).toMatchObject({ status: 200 });

    const openApi = await request(app).get("/openapi.json");
    expect(openApi.status).toBe(200);
    expect(openApi.body.paths["/api/signals-free-get/search"].get.requestBody).toBeUndefined();
    expect(openApi.body.paths["/api/signals-free-get/search"].get.responses["402"]).toBeUndefined();

    const response = await request(app)
      .get("/api/signals-free-get/search")
      .query({ query: "FAST" });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ items: ["alpha"] });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://provider.example.com/api/search?query=FAST",
      expect.objectContaining({
        method: "GET"
      })
    );

    const analytics = await store.getServiceAnalytics(["signals-free-get.search.v1"]);
    expect(analytics.totalCalls).toBe(1);
    expect(analytics.revenueRaw).toBe("0");
  });

  it("supports prepaid-credit GET execution with wallet-session auth", async () => {
    const providerWallet = await createTestWallet(PROVIDER_PRIVATE_KEY);
    const { app, buyer, store } = await createTestApp();
    const providerToken = await createSiteSession(app, providerWallet);

    await request(app)
      .post("/provider/me")
      .set("Authorization", `Bearer ${providerToken}`)
      .send({
        displayName: "Order Desk",
        websiteUrl: "https://orders.example.com"
      });

    const createdService = await request(app)
      .post("/provider/services")
      .set("Authorization", `Bearer ${providerToken}`)
      .send({
        serviceType: "marketplace_proxy",
        slug: "order-desk-get",
        apiNamespace: "orders-get",
        name: "Order Desk GET",
        tagline: "Prepaid GET orders",
        about: "Provider-authored order routes.",
        categories: ["Shopping"],
        promptIntro: "Use this order desk.",
        setupInstructions: ["Use a funded Fast wallet."],
        websiteUrl: "https://orders.example.com",
        payoutWallet: providerWallet.address
      });

    expect(createdService.status).toBe(201);
    const serviceId = createdService.body.service.id as string;

    const runtimeKeyResponse = await request(app)
      .post(`/provider/services/${serviceId}/runtime-key`)
      .set("Authorization", `Bearer ${providerToken}`)
      .send({});

    expect(runtimeKeyResponse.status).toBe(201);
    const runtimeKey = runtimeKeyResponse.body.plaintextKey as string;

    const topupEndpoint = await request(app)
      .post(`/provider/services/${serviceId}/endpoints`)
      .set("Authorization", `Bearer ${providerToken}`)
      .send({
        endpointType: "marketplace_proxy",
        operation: "topup",
        method: "POST",
        title: "Top Up",
        description: "Add prepaid marketplace credit.",
        billingType: "topup_x402_variable",
        minAmount: "10",
        maxAmount: "100",
        mode: "sync",
        requestSchemaJson: {
          type: "object",
          properties: {
            amount: { type: "string" }
          },
          required: ["amount"],
          additionalProperties: false
        },
        responseSchemaJson: {
          type: "object",
          properties: {
            topupAmount: { type: "string" }
          },
          required: ["topupAmount"],
          additionalProperties: true
        },
        requestExample: {
          amount: "25"
        },
        responseExample: {
          topupAmount: "25"
        }
      });

    expect(topupEndpoint.status).toBe(201);

    const prepaidEndpoint = await request(app)
      .post(`/provider/services/${serviceId}/endpoints`)
      .set("Authorization", `Bearer ${providerToken}`)
      .send({
        endpointType: "marketplace_proxy",
        operation: "place-order",
        method: "GET",
        title: "Place Order",
        description: "Place an order against prepaid credit.",
        billingType: "prepaid_credit",
        mode: "sync",
        requestSchemaJson: {
          type: "object",
          properties: {
            item: { type: "string" },
            quantity: { type: "integer" }
          },
          required: ["item", "quantity"],
          additionalProperties: false
        },
        responseSchemaJson: {
          type: "object",
          properties: {
            orderId: { type: "string" }
          },
          required: ["orderId"],
          additionalProperties: false
        },
        requestExample: {
          item: "notebook",
          quantity: 2
        },
        responseExample: {
          orderId: "ord_123"
        },
        upstreamBaseUrl: "https://orders.example.com",
        upstreamPath: "/api/place-order",
        upstreamAuthMode: "none"
      });

    expect(prepaidEndpoint.status).toBe(201);

    const verificationChallenge = await request(app)
      .post(`/provider/services/${serviceId}/verification-challenge`)
      .set("Authorization", `Bearer ${providerToken}`);

    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (fetchInput, init) => {
      const url = String(fetchInput);
      if (url === verificationChallenge.body.expectedUrl) {
        return new Response(verificationChallenge.body.token, { status: 200 });
      }

      if (url === "https://orders.example.com/api/place-order?item=notebook&quantity=2") {
        const headers = Object.fromEntries(new Headers(init?.headers).entries());
        const identity = verifyMarketplaceIdentityHeaders({
          headers,
          signingSecret: runtimeKey
        });
        if (!identity.buyerWallet) {
          throw new Error("Prepaid route execution must include a buyer wallet.");
        }

        const reserveResponse = await request(app)
          .post("/provider/runtime/credits/reserve")
          .set("Authorization", `Bearer ${runtimeKey}`)
          .send({
            buyerWallet: identity.buyerWallet,
            amount: "12.5",
            idempotencyKey: `reserve_${identity.requestId}`,
            providerReference: "order-get-123"
          });

        if (reserveResponse.status !== 200) {
          return new Response(JSON.stringify(reserveResponse.body), {
            status: reserveResponse.status,
            headers: {
              "content-type": "application/json"
            }
          });
        }

        const captureResponse = await request(app)
          .post(`/provider/runtime/credits/${reserveResponse.body.reservation.id}/capture`)
          .set("Authorization", `Bearer ${runtimeKey}`)
          .send({
            amount: "12.5"
          });

        if (captureResponse.status !== 200) {
          return new Response(JSON.stringify(captureResponse.body), {
            status: captureResponse.status,
            headers: {
              "content-type": "application/json"
            }
          });
        }

        expect(init?.method).toBe("GET");
        expect(init?.body).toBeUndefined();

        return new Response(JSON.stringify({ orderId: "ord_123" }), {
          status: 200,
          headers: {
            "content-type": "application/json"
          }
        });
      }

      return new Response("not found", { status: 404 });
    });

    expect(
      await request(app)
        .post(`/provider/services/${serviceId}/verify`)
        .set("Authorization", `Bearer ${providerToken}`)
    ).toMatchObject({ status: 200 });
    expect(
      await request(app)
        .post(`/provider/services/${serviceId}/submit`)
        .set("Authorization", `Bearer ${providerToken}`)
    ).toMatchObject({ status: 202 });
    expect(
      await request(app)
        .post(`/internal/provider-services/${serviceId}/publish`)
        .set("Authorization", "Bearer test-admin-token")
        .send({
          reviewerIdentity: "ops@test",
          settlementMode: "verified_escrow"
        })
    ).toMatchObject({ status: 200 });

    const toppedUp = await request(app)
      .post("/api/orders-get/topup")
      .set("X-PAYMENT", Buffer.from(JSON.stringify({ paid: true })).toString("base64"))
      .set("PAYMENT-IDENTIFIER", "payment_orders_get_topup_1")
      .send({ amount: "25" });

    expect(toppedUp.status).toBe(200);

    const unauthorized = await request(app)
      .get("/api/orders-get/place-order")
      .query({ item: "notebook", quantity: 2 });

    expect(unauthorized.status).toBe(401);

    const challenge = await request(app)
      .post("/auth/challenge")
      .send({
        wallet: buyer.address,
        resourceType: "api",
        resourceId: "orders-get.place-order.v1"
      });

    expect(challenge.status).toBe(200);

    const signed = await buyer.wallet.sign({ message: challenge.body.message });
    const apiSession = await request(app)
      .post("/auth/session")
      .send({
        wallet: buyer.address,
        resourceType: "api",
        resourceId: "orders-get.place-order.v1",
        nonce: challenge.body.nonce,
        expiresAt: challenge.body.expiresAt,
        signature: signed.signature
      });

    expect(apiSession.status).toBe(200);

    const prepaid = await request(app)
      .get("/api/orders-get/place-order")
      .query({ item: "notebook", quantity: 2 })
      .set("Authorization", `Bearer ${apiSession.body.accessToken}`);

    expect(prepaid.status).toBe(200);
    expect(prepaid.body).toEqual({ orderId: "ord_123" });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://orders.example.com/api/place-order?item=notebook&quantity=2",
      expect.objectContaining({
        method: "GET"
      })
    );

    const creditAccount = await store.getCreditAccount(serviceId, buyer.address, "fastUSDC");
    expect(creditAccount?.availableAmount).toBe("12500000");
    expect(creditAccount?.reservedAmount).toBe("0");
  });

  it("supports async prepaid-credit reservation during execute with the injected marketplace job token", async () => {
    const providerWallet = await createTestWallet(PROVIDER_PRIVATE_KEY);
    const { app, buyer, store } = await createTestApp();
    const providerToken = await createSiteSession(app, providerWallet);

    await request(app)
      .post("/provider/me")
      .set("Authorization", `Bearer ${providerToken}`)
      .send({
        displayName: "Order Desk",
        websiteUrl: "https://orders.example.com"
      });

    const createdService = await request(app)
      .post("/provider/services")
      .set("Authorization", `Bearer ${providerToken}`)
      .send({
        serviceType: "marketplace_proxy",
        slug: "order-desk-async-prepaid",
        apiNamespace: "orders-async",
        name: "Order Desk Async",
        tagline: "Async prepaid orders",
        about: "Provider-authored async prepaid order routes.",
        categories: ["Shopping"],
        promptIntro: "Use this async order desk.",
        setupInstructions: ["Use a funded Fast wallet."],
        websiteUrl: "https://orders.example.com",
        payoutWallet: providerWallet.address
      });

    expect(createdService.status).toBe(201);
    const serviceId = createdService.body.service.id as string;

    const runtimeKeyResponse = await request(app)
      .post(`/provider/services/${serviceId}/runtime-key`)
      .set("Authorization", `Bearer ${providerToken}`)
      .send({});

    expect(runtimeKeyResponse.status).toBe(201);
    const runtimeKey = runtimeKeyResponse.body.plaintextKey as string;

    const topupEndpoint = await request(app)
      .post(`/provider/services/${serviceId}/endpoints`)
      .set("Authorization", `Bearer ${providerToken}`)
      .send({
        endpointType: "marketplace_proxy",
        operation: "topup",
        method: "POST",
        title: "Top Up",
        description: "Top up a prepaid order balance.",
        billingType: "topup_x402_variable",
        minAmount: "5",
        maxAmount: "100",
        mode: "sync",
        requestSchemaJson: {
          type: "object",
          properties: {
            amount: { type: "string" }
          },
          required: ["amount"],
          additionalProperties: false
        },
        responseSchemaJson: {
          type: "object",
          properties: {
            topupAmount: { type: "string" }
          },
          required: ["topupAmount"],
          additionalProperties: true
        },
        requestExample: { amount: "25" },
        responseExample: { topupAmount: "25" }
      });

    expect(topupEndpoint.status).toBe(201);

    const prepaidEndpoint = await request(app)
      .post(`/provider/services/${serviceId}/endpoints`)
      .set("Authorization", `Bearer ${providerToken}`)
      .send({
        endpointType: "marketplace_proxy",
        operation: "place-order",
        method: "POST",
        title: "Place Order",
        description: "Reserve prepaid credit and place an async order.",
        billingType: "prepaid_credit",
        mode: "async",
        asyncStrategy: "poll",
        asyncTimeoutMs: 300000,
        pollPath: "/api/jobs/poll",
        requestSchemaJson: {
          type: "object",
          properties: {
            item: { type: "string" }
          },
          required: ["item"],
          additionalProperties: false
        },
        responseSchemaJson: {
          type: "object",
          properties: {
            orderId: { type: "string" }
          },
          required: ["orderId"],
          additionalProperties: false
        },
        requestExample: {
          item: "notebook"
        },
        responseExample: {
          orderId: "ord_123"
        },
        upstreamBaseUrl: "https://orders.example.com",
        upstreamPath: "/api/place-order-async",
        upstreamAuthMode: "none"
      });

    expect(prepaidEndpoint.status).toBe(201);

    const verificationChallenge = await request(app)
      .post(`/provider/services/${serviceId}/verification-challenge`)
      .set("Authorization", `Bearer ${providerToken}`);

    let reserveStatus = 0;
    let reservedJobToken = "";

    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (fetchInput, init) => {
      const url = String(fetchInput);
      if (url === verificationChallenge.body.expectedUrl) {
        return new Response(verificationChallenge.body.token, { status: 200 });
      }

      if (url === "https://orders.example.com/api/place-order-async") {
        const headers = Object.fromEntries(new Headers(init?.headers).entries());
        const identity = verifyMarketplaceIdentityHeaders({
          headers,
          signingSecret: runtimeKey
        });
        if (!identity.buyerWallet) {
          throw new Error("Async prepaid route execution must include a buyer wallet.");
        }

        reservedJobToken = headers[MARKETPLACE_JOB_TOKEN_HEADER.toLowerCase()] ?? "";
        expect(reservedJobToken).toBeTruthy();

        const reserveResponse = await request(app)
          .post("/provider/runtime/credits/reserve")
          .set("Authorization", `Bearer ${runtimeKey}`)
          .set(MARKETPLACE_JOB_TOKEN_HEADER, reservedJobToken)
          .send({
            buyerWallet: identity.buyerWallet,
            amount: "12.5",
            idempotencyKey: `reserve_${identity.requestId}`,
            providerReference: "order-async-123"
          });

        reserveStatus = reserveResponse.status;
        if (reserveResponse.status !== 200) {
          return new Response(JSON.stringify(reserveResponse.body), {
            status: reserveResponse.status,
            headers: {
              "content-type": "application/json"
            }
          });
        }

        return new Response(JSON.stringify({
          status: "accepted",
          providerJobId: "provider_async_prepaid_1",
          pollAfterMs: 5000
        }), {
          status: 202,
          headers: {
            "content-type": "application/json"
          }
        });
      }

      return new Response("not found", { status: 404 });
    });

    expect(
      await request(app)
        .post(`/provider/services/${serviceId}/verify`)
        .set("Authorization", `Bearer ${providerToken}`)
    ).toMatchObject({ status: 200 });
    expect(
      await request(app)
        .post(`/provider/services/${serviceId}/submit`)
        .set("Authorization", `Bearer ${providerToken}`)
    ).toMatchObject({ status: 202 });
    expect(
      await request(app)
        .post(`/internal/provider-services/${serviceId}/publish`)
        .set("Authorization", "Bearer test-admin-token")
        .send({
          reviewerIdentity: "ops@test",
          settlementMode: "verified_escrow"
        })
    ).toMatchObject({ status: 200 });

    const toppedUp = await request(app)
      .post("/api/orders-async/topup")
      .set("X-PAYMENT", Buffer.from(JSON.stringify({ paid: true })).toString("base64"))
      .set("PAYMENT-IDENTIFIER", "payment_orders_async_topup_1")
      .send({ amount: "25" });

    expect(toppedUp.status).toBe(200);

    const challenge = await request(app)
      .post("/auth/challenge")
      .send({
        wallet: buyer.address,
        resourceType: "api",
        resourceId: "orders-async.place-order.v1"
      });

    expect(challenge.status).toBe(200);

    const signed = await buyer.wallet.sign({ message: challenge.body.message });
    const apiSession = await request(app)
      .post("/auth/session")
      .send({
        wallet: buyer.address,
        resourceType: "api",
        resourceId: "orders-async.place-order.v1",
        nonce: challenge.body.nonce,
        expiresAt: challenge.body.expiresAt,
        signature: signed.signature
      });

    expect(apiSession.status).toBe(200);

    const accepted = await request(app)
      .post("/api/orders-async/place-order")
      .set("Authorization", `Bearer ${apiSession.body.accessToken}`)
      .send({ item: "notebook" });

    expect(accepted.status).toBe(202);
    expect(reserveStatus).toBe(200);
    expect(reservedJobToken).toBe(accepted.body.jobToken);

    const reservation = await store.getCreditReservationByJobToken(serviceId, accepted.body.jobToken);
    const creditAccount = await store.getCreditAccount(serviceId, buyer.address, "fastUSDC");
    const job = await store.getJob(accepted.body.jobToken);

    expect(reservation?.status).toBe("reserved");
    expect(creditAccount?.availableAmount).toBe("12500000");
    expect(creditAccount?.reservedAmount).toBe("12500000");
    expect(job?.status).toBe("pending");
    expect(job?.providerJobId).toBe("provider_async_prepaid_1");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://orders.example.com/api/place-order-async",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ item: "notebook" })
      })
    );
  });

  it("rejects invalid GET endpoint drafts for topups and nested request schemas", async () => {
    const providerWallet = await createTestWallet(PROVIDER_PRIVATE_KEY);
    const { app } = await createTestApp();
    const providerToken = await createSiteSession(app, providerWallet);

    await request(app)
      .post("/provider/me")
      .set("Authorization", `Bearer ${providerToken}`)
      .send({
        displayName: "Signal Labs",
        websiteUrl: "https://provider.example.com"
      });

    const createdService = await request(app)
      .post("/provider/services")
      .set("Authorization", `Bearer ${providerToken}`)
      .send({
        serviceType: "marketplace_proxy",
        slug: "signal-labs-get-validation",
        apiNamespace: "signals-get-validation",
        name: "Signal Labs GET Validation",
        tagline: "Validation coverage",
        about: "Provider-authored signal endpoints.",
        categories: ["Research"],
        promptIntro: "Prompt intro",
        setupInstructions: ["Use a funded Fast wallet."],
        websiteUrl: "https://provider.example.com",
        payoutWallet: providerWallet.address
      });

    expect(createdService.status).toBe(201);

    const invalidTopup = await request(app)
      .post(`/provider/services/${createdService.body.service.id}/endpoints`)
      .set("Authorization", `Bearer ${providerToken}`)
      .send({
        endpointType: "marketplace_proxy",
        operation: "topup",
        method: "GET",
        title: "Top Up",
        description: "Invalid GET topup.",
        billingType: "topup_x402_variable",
        minAmount: "10",
        maxAmount: "100",
        mode: "sync",
        requestSchemaJson: {
          type: "object",
          properties: {
            amount: { type: "string" }
          },
          required: ["amount"],
          additionalProperties: false
        },
        responseSchemaJson: {
          type: "object",
          properties: {
            ok: { type: "boolean" }
          },
          required: ["ok"],
          additionalProperties: false
        },
        requestExample: { amount: "25" },
        responseExample: { ok: true }
      });

    expect(invalidTopup.status).toBe(400);
    expect(invalidTopup.body.error).toContain("method=POST");

    const invalidNested = await request(app)
      .post(`/provider/services/${createdService.body.service.id}/endpoints`)
      .set("Authorization", `Bearer ${providerToken}`)
      .send({
        endpointType: "marketplace_proxy",
        operation: "search",
        method: "GET",
        title: "Search",
        description: "Invalid nested GET input.",
        billingType: "free",
        mode: "sync",
        requestSchemaJson: {
          type: "object",
          properties: {
            filters: {
              type: "object",
              properties: {
                symbol: { type: "string" }
              },
              additionalProperties: false
            }
          },
          additionalProperties: false
        },
        responseSchemaJson: {
          type: "object",
          properties: {
            ok: { type: "boolean" }
          },
          required: ["ok"],
          additionalProperties: false
        },
        requestExample: { filters: { symbol: "FAST" } },
        responseExample: { ok: true },
        upstreamBaseUrl: "https://provider.example.com",
        upstreamPath: "/api/search",
        upstreamAuthMode: "none"
      });

    expect(invalidNested.status).toBe(400);
    expect(invalidNested.body.error).toContain('GET property "filters"');
  });

  it("publishes discovery-only external registry services without executable marketplace routes", async () => {
    const providerWallet = await createTestWallet(PROVIDER_PRIVATE_KEY);
    const { app } = await createTestApp();
    const providerToken = await createSiteSession(app, providerWallet);

    const profile = await request(app)
      .post("/provider/me")
      .set("Authorization", `Bearer ${providerToken}`)
      .send({
        displayName: "Signal Labs",
        websiteUrl: "https://provider.example.com"
      });

    expect(profile.status).toBe(201);

    const createdService = await request(app)
      .post("/provider/services")
      .set("Authorization", `Bearer ${providerToken}`)
      .send({
        serviceType: "external_registry",
        slug: "signal-labs-direct",
        name: "Signal Labs Direct",
        tagline: "Direct provider APIs",
        about: "Discovery-only direct APIs that the marketplace lists but does not execute.",
        categories: ["Research"],
        promptIntro: 'I want to use the "Signal Labs Direct" service.',
        setupInstructions: ["Read the provider docs first."],
        websiteUrl: "https://provider.example.com"
      });

    expect(createdService.status).toBe(201);
    const serviceId = createdService.body.service.id as string;

    const createdEndpoint = await request(app)
      .post(`/provider/services/${serviceId}/endpoints`)
      .set("Authorization", `Bearer ${providerToken}`)
      .send({
        endpointType: "external_registry",
        title: "Status",
        description: "Returns service status directly from the provider.",
        method: "GET",
        publicUrl: "https://provider.example.com/api/status",
        docsUrl: "https://provider.example.com/docs/status",
        authNotes: "Bearer token required.",
        requestExample: {},
        responseExample: { status: "ok" }
      });

    expect(createdEndpoint.status).toBe(201);

    const verificationChallenge = await request(app)
      .post(`/provider/services/${serviceId}/verification-challenge`)
      .set("Authorization", `Bearer ${providerToken}`);

    expect(verificationChallenge.status).toBe(200);

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url === verificationChallenge.body.expectedUrl) {
        return new Response(verificationChallenge.body.token, { status: 200 });
      }

      return new Response("not found", { status: 404 });
    });

    const verified = await request(app)
      .post(`/provider/services/${serviceId}/verify`)
      .set("Authorization", `Bearer ${providerToken}`);

    expect(verified.status).toBe(200);

    const submitted = await request(app)
      .post(`/provider/services/${serviceId}/submit`)
      .set("Authorization", `Bearer ${providerToken}`);

    expect(submitted.status).toBe(202);

    const published = await request(app)
      .post(`/internal/provider-services/${serviceId}/publish`)
      .set("Authorization", "Bearer test-admin-token")
      .send({
        reviewerIdentity: "ops@test"
      });

    expect(published.status).toBe(200);

    const publicDetail = await request(app).get("/catalog/services/signal-labs-direct");
    expect(publicDetail.status).toBe(200);
    expect(publicDetail.body.serviceType).toBe("external_registry");
    expect(publicDetail.body.skillUrl).toBeNull();
    expect(publicDetail.body.endpoints[0]).toMatchObject({
      endpointType: "external_registry",
      method: "GET",
      publicUrl: "https://provider.example.com/api/status",
      docsUrl: "https://provider.example.com/docs/status"
    });

    const llms = await request(app).get("/llms.txt");
    expect(llms.status).toBe(200);
    expect(llms.text).toContain("## Discovery-Only External APIs");
    expect(llms.text).toContain("https://provider.example.com/api/status");

    const routeResponse = await request(app)
      .post("/api/signal-labs-direct/status")
      .send({});

    expect(routeResponse.status).toBe(404);
  });

  it("returns 409 when an external service tries to add a duplicate external endpoint", async () => {
    const providerWallet = await createTestWallet(PROVIDER_PRIVATE_KEY);
    const { app } = await createTestApp();
    const providerToken = await createSiteSession(app, providerWallet);

    const profile = await request(app)
      .post("/provider/me")
      .set("Authorization", `Bearer ${providerToken}`)
      .send({
        displayName: "Signal Labs",
        websiteUrl: "https://provider.example.com"
      });

    expect(profile.status).toBe(201);

    const createdService = await request(app)
      .post("/provider/services")
      .set("Authorization", `Bearer ${providerToken}`)
      .send({
        serviceType: "external_registry",
        slug: "signal-labs-direct-duplicate",
        name: "Signal Labs Direct Duplicate",
        tagline: "Direct provider APIs",
        about: "Discovery-only direct APIs that the marketplace lists but does not execute.",
        categories: ["Research"],
        promptIntro: 'I want to use the "Signal Labs Direct Duplicate" service.',
        setupInstructions: ["Read the provider docs first."],
        websiteUrl: "https://provider.example.com"
      });

    expect(createdService.status).toBe(201);

    const firstEndpoint = await request(app)
      .post(`/provider/services/${createdService.body.service.id}/endpoints`)
      .set("Authorization", `Bearer ${providerToken}`)
      .send({
        endpointType: "external_registry",
        title: "Status",
        description: "Returns service status directly from the provider.",
        method: "GET",
        publicUrl: "https://provider.example.com/api/status",
        docsUrl: "https://provider.example.com/docs/status",
        authNotes: "Bearer token required.",
        requestExample: {},
        responseExample: { status: "ok" }
      });

    expect(firstEndpoint.status).toBe(201);

    const duplicateEndpoint = await request(app)
      .post(`/provider/services/${createdService.body.service.id}/endpoints`)
      .set("Authorization", `Bearer ${providerToken}`)
      .send({
        endpointType: "external_registry",
        title: "Status duplicate",
        description: "Duplicate provider status route.",
        method: "GET",
        publicUrl: "https://provider.example.com/api/status",
        docsUrl: "https://provider.example.com/docs/status-v2",
        authNotes: "Bearer token required.",
        requestExample: {},
        responseExample: { status: "ok" }
      });

    expect(duplicateEndpoint.status).toBe(409);
    expect(duplicateEndpoint.body.error).toContain("External endpoint already exists");
  });

  it("keeps the published catalog bound to the published slug while the next draft slug changes", async () => {
    const providerWallet = await createTestWallet(PROVIDER_PRIVATE_KEY);
    const { app } = await createTestApp();
    const providerToken = await createSiteSession(app, providerWallet);

    const profile = await request(app)
      .post("/provider/me")
      .set("Authorization", `Bearer ${providerToken}`)
      .send({
        displayName: "Signal Labs",
        websiteUrl: "https://provider.example.com"
      });

    expect(profile.status).toBe(201);

    const createdService = await request(app)
      .post("/provider/services")
      .set("Authorization", `Bearer ${providerToken}`)
      .send({
        serviceType: "marketplace_proxy",
        slug: "signal-labs",
        apiNamespace: "signals",
        name: "Signal Labs",
        tagline: "Short-form market signals",
        about: "Provider-authored signal endpoints.",
        categories: ["Research"],
        promptIntro: 'I want to use the "Signal Labs" service on Fast Marketplace.',
        setupInstructions: ["Use a funded Fast wallet."],
        websiteUrl: "https://provider.example.com",
        payoutWallet: providerWallet.address
      });

    expect(createdService.status).toBe(201);
    const serviceId = createdService.body.service.id as string;

    const createdEndpoint = await request(app)
      .post(`/provider/services/${serviceId}/endpoints`)
      .set("Authorization", `Bearer ${providerToken}`)
      .send({
        endpointType: "marketplace_proxy",
        operation: "quote",
        method: "POST",
        title: "Quote",
        description: "Return a single quote snapshot.",
        billingType: "fixed_x402",
        price: "$0.25",
        mode: "sync",
        requestSchemaJson: {
          type: "object",
          properties: {
            symbol: { type: "string" }
          },
          required: ["symbol"],
          additionalProperties: false
        },
        responseSchemaJson: {
          type: "object",
          properties: {
            symbol: { type: "string" },
            price: { type: "number" }
          },
          required: ["symbol", "price"],
          additionalProperties: false
        },
        requestExample: { symbol: "FAST" },
        responseExample: { symbol: "FAST", price: 42.5 },
        upstreamBaseUrl: "https://provider.example.com",
        upstreamPath: "/api/quote",
        upstreamAuthMode: "none"
      });

    expect(createdEndpoint.status).toBe(201);

    const verificationChallenge = await request(app)
      .post(`/provider/services/${serviceId}/verification-challenge`)
      .set("Authorization", `Bearer ${providerToken}`);

    expect(verificationChallenge.status).toBe(200);

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url === verificationChallenge.body.expectedUrl) {
        return new Response(verificationChallenge.body.token, { status: 200 });
      }

      return new Response("not found", { status: 404 });
    });

    const verified = await request(app)
      .post(`/provider/services/${serviceId}/verify`)
      .set("Authorization", `Bearer ${providerToken}`);

    expect(verified.status).toBe(200);

    const submitted = await request(app)
      .post(`/provider/services/${serviceId}/submit`)
      .set("Authorization", `Bearer ${providerToken}`);

    expect(submitted.status).toBe(202);

    const published = await request(app)
      .post(`/internal/provider-services/${serviceId}/publish`)
      .set("Authorization", "Bearer test-admin-token")
      .send({
        reviewerIdentity: "ops@test",
        settlementMode: "verified_escrow"
      });

    expect(published.status).toBe(200);

    const originalDetail = await request(app).get("/catalog/services/signal-labs");
    expect(originalDetail.status).toBe(200);

    const updatedDraft = await request(app)
      .patch(`/provider/services/${serviceId}`)
      .set("Authorization", `Bearer ${providerToken}`)
      .send({
        slug: "signal-labs-next"
      });

    expect(updatedDraft.status).toBe(200);
    expect(updatedDraft.body.slug).toBe("signal-labs-next");

    const publicList = await request(app).get("/catalog/services");
    expect(publicList.status).toBe(200);
    expect(publicList.body.services.some((service: { slug: string }) => service.slug === "signal-labs")).toBe(true);
    expect(publicList.body.services.some((service: { slug: string }) => service.slug === "signal-labs-next")).toBe(false);

    const publishedDetail = await request(app).get("/catalog/services/signal-labs");
    expect(publishedDetail.status).toBe(200);
    expect(publishedDetail.body.summary.slug).toBe("signal-labs");

    const draftSlugDetail = await request(app).get("/catalog/services/signal-labs-next");
    expect(draftSlugDetail.status).toBe(404);
  });

  it("returns 409 when serviceType changes after endpoints already exist", async () => {
    const providerWallet = await createTestWallet(PROVIDER_PRIVATE_KEY);
    const { app } = await createTestApp();
    const providerToken = await createSiteSession(app, providerWallet);

    const profile = await request(app)
      .post("/provider/me")
      .set("Authorization", `Bearer ${providerToken}`)
      .send({
        displayName: "Signal Labs",
        websiteUrl: "https://provider.example.com"
      });

    expect(profile.status).toBe(201);

    const createdService = await request(app)
      .post("/provider/services")
      .set("Authorization", `Bearer ${providerToken}`)
      .send({
        serviceType: "marketplace_proxy",
        slug: "signal-labs-service-type-lock",
        apiNamespace: "signals-service-type-lock",
        name: "Signal Labs Service Type Lock",
        tagline: "Short-form market signals",
        about: "Provider-authored signal endpoints.",
        categories: ["Research"],
        promptIntro: 'I want to use the "Signal Labs Service Type Lock" service on Fast Marketplace.',
        setupInstructions: ["Use a funded Fast wallet."],
        websiteUrl: "https://provider.example.com",
        payoutWallet: providerWallet.address
      });

    expect(createdService.status).toBe(201);
    const serviceId = createdService.body.service.id as string;

    const createdEndpoint = await request(app)
      .post(`/provider/services/${serviceId}/endpoints`)
      .set("Authorization", `Bearer ${providerToken}`)
      .send({
        endpointType: "marketplace_proxy",
        operation: "quote",
        method: "POST",
        title: "Quote",
        description: "Return a single quote snapshot.",
        billingType: "fixed_x402",
        price: "$0.25",
        mode: "sync",
        requestSchemaJson: {
          type: "object",
          properties: {
            symbol: { type: "string" }
          },
          required: ["symbol"],
          additionalProperties: false
        },
        responseSchemaJson: {
          type: "object",
          properties: {
            symbol: { type: "string" },
            price: { type: "number" }
          },
          required: ["symbol", "price"],
          additionalProperties: false
        },
        requestExample: { symbol: "FAST" },
        responseExample: { symbol: "FAST", price: 42.5 },
        upstreamBaseUrl: "https://provider.example.com",
        upstreamPath: "/api/quote",
        upstreamAuthMode: "none"
      });

    expect(createdEndpoint.status).toBe(201);

    const updatedService = await request(app)
      .patch(`/provider/services/${serviceId}`)
      .set("Authorization", `Bearer ${providerToken}`)
      .send({
        serviceType: "external_registry"
      });

    expect(updatedService.status).toBe(409);
    expect(updatedService.body.error).toContain("serviceType can only change before");
  });

  it("returns 409 when republishing a submitted snapshot whose apiNamespace is now claimed by another service", async () => {
    const providerWallet = await createTestWallet(PROVIDER_PRIVATE_KEY);
    const { app } = await createTestApp();
    const providerToken = await createSiteSession(app, providerWallet);

    const profile = await request(app)
      .post("/provider/me")
      .set("Authorization", `Bearer ${providerToken}`)
      .send({
        displayName: "Signal Labs",
        websiteUrl: "https://provider.example.com"
      });

    expect(profile.status).toBe(201);

    const firstService = await request(app)
      .post("/provider/services")
      .set("Authorization", `Bearer ${providerToken}`)
      .send({
        serviceType: "marketplace_proxy",
        slug: "signal-labs-republish-a",
        apiNamespace: "signals-republish",
        name: "Signal Labs Republish A",
        tagline: "Short-form market signals",
        about: "Provider-authored signal endpoints.",
        categories: ["Research"],
        promptIntro: 'I want to use the "Signal Labs Republish A" service on Fast Marketplace.',
        setupInstructions: ["Use a funded Fast wallet."],
        websiteUrl: "https://provider.example.com",
        payoutWallet: providerWallet.address
      });

    expect(firstService.status).toBe(201);
    const firstServiceId = firstService.body.service.id as string;

    const firstEndpoint = await request(app)
      .post(`/provider/services/${firstServiceId}/endpoints`)
      .set("Authorization", `Bearer ${providerToken}`)
      .send({
        endpointType: "marketplace_proxy",
        operation: "quote",
        method: "POST",
        title: "Quote",
        description: "Return a single quote snapshot.",
        billingType: "fixed_x402",
        price: "$0.25",
        mode: "sync",
        requestSchemaJson: {
          type: "object",
          properties: {
            symbol: { type: "string" }
          },
          required: ["symbol"],
          additionalProperties: false
        },
        responseSchemaJson: {
          type: "object",
          properties: {
            symbol: { type: "string" },
            price: { type: "number" }
          },
          required: ["symbol", "price"],
          additionalProperties: false
        },
        requestExample: { symbol: "FAST" },
        responseExample: { symbol: "FAST", price: 42.5 },
        upstreamBaseUrl: "https://provider.example.com",
        upstreamPath: "/api/quote",
        upstreamAuthMode: "none"
      });

    expect(firstEndpoint.status).toBe(201);

    const fetchMock = vi.spyOn(globalThis, "fetch");

    const firstChallenge = await request(app)
      .post(`/provider/services/${firstServiceId}/verification-challenge`)
      .set("Authorization", `Bearer ${providerToken}`);

    expect(firstChallenge.status).toBe(200);
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url === firstChallenge.body.expectedUrl) {
        return new Response(firstChallenge.body.token, { status: 200 });
      }

      return new Response("not found", { status: 404 });
    });

    const firstVerified = await request(app)
      .post(`/provider/services/${firstServiceId}/verify`)
      .set("Authorization", `Bearer ${providerToken}`);

    expect(firstVerified.status).toBe(200);

    const firstSubmitted = await request(app)
      .post(`/provider/services/${firstServiceId}/submit`)
      .set("Authorization", `Bearer ${providerToken}`);

    expect(firstSubmitted.status).toBe(202);

    const firstPublished = await request(app)
      .post(`/internal/provider-services/${firstServiceId}/publish`)
      .set("Authorization", "Bearer test-admin-token")
      .send({
        reviewerIdentity: "ops@test",
        settlementMode: "verified_escrow"
      });

    expect(firstPublished.status).toBe(200);

    const firstReviewChanges = await request(app)
      .post(`/internal/provider-services/${firstServiceId}/request-changes`)
      .set("Authorization", "Bearer test-admin-token")
      .send({
        reviewerIdentity: "ops@test",
        reviewNotes: "Move the provider namespace before republishing."
      });

    expect(firstReviewChanges.status).toBe(200);

    const firstEndpointDeleted = await request(app)
      .delete(`/provider/services/${firstServiceId}/endpoints/${firstEndpoint.body.id}`)
      .set("Authorization", `Bearer ${providerToken}`);

    expect(firstEndpointDeleted.status).toBe(204);

    const firstUpdatedDraft = await request(app)
      .patch(`/provider/services/${firstServiceId}`)
      .set("Authorization", `Bearer ${providerToken}`)
      .send({
        apiNamespace: "signals-republish-next"
      });

    expect(firstUpdatedDraft.status).toBe(200);

    const secondService = await request(app)
      .post("/provider/services")
      .set("Authorization", `Bearer ${providerToken}`)
      .send({
        serviceType: "marketplace_proxy",
        slug: "signal-labs-republish-b",
        apiNamespace: "signals-republish",
        name: "Signal Labs Republish B",
        tagline: "Short-form market signals",
        about: "Provider-authored signal endpoints.",
        categories: ["Research"],
        promptIntro: 'I want to use the "Signal Labs Republish B" service on Fast Marketplace.',
        setupInstructions: ["Use a funded Fast wallet."],
        websiteUrl: "https://provider.example.com",
        payoutWallet: providerWallet.address
      });

    expect(secondService.status).toBe(201);
    const secondServiceId = secondService.body.service.id as string;

    const secondEndpoint = await request(app)
      .post(`/provider/services/${secondServiceId}/endpoints`)
      .set("Authorization", `Bearer ${providerToken}`)
      .send({
        endpointType: "marketplace_proxy",
        operation: "quote",
        method: "POST",
        title: "Quote",
        description: "Return a single quote snapshot.",
        billingType: "fixed_x402",
        price: "$0.25",
        mode: "sync",
        requestSchemaJson: {
          type: "object",
          properties: {
            symbol: { type: "string" }
          },
          required: ["symbol"],
          additionalProperties: false
        },
        responseSchemaJson: {
          type: "object",
          properties: {
            symbol: { type: "string" },
            price: { type: "number" }
          },
          required: ["symbol", "price"],
          additionalProperties: false
        },
        requestExample: { symbol: "FAST" },
        responseExample: { symbol: "FAST", price: 42.5 },
        upstreamBaseUrl: "https://provider.example.com",
        upstreamPath: "/api/quote",
        upstreamAuthMode: "none"
      });

    expect(secondEndpoint.status).toBe(201);

    const secondChallenge = await request(app)
      .post(`/provider/services/${secondServiceId}/verification-challenge`)
      .set("Authorization", `Bearer ${providerToken}`);

    expect(secondChallenge.status).toBe(200);
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url === secondChallenge.body.expectedUrl) {
        return new Response(secondChallenge.body.token, { status: 200 });
      }

      return new Response("not found", { status: 404 });
    });

    const secondVerified = await request(app)
      .post(`/provider/services/${secondServiceId}/verify`)
      .set("Authorization", `Bearer ${providerToken}`);

    expect(secondVerified.status).toBe(200);

    const secondSubmitted = await request(app)
      .post(`/provider/services/${secondServiceId}/submit`)
      .set("Authorization", `Bearer ${providerToken}`);

    expect(secondSubmitted.status).toBe(202);

    const secondPublished = await request(app)
      .post(`/internal/provider-services/${secondServiceId}/publish`)
      .set("Authorization", "Bearer test-admin-token")
      .send({
        reviewerIdentity: "ops@test",
        settlementMode: "verified_escrow"
      });

    expect(secondPublished.status).toBe(200);

    const republishedFirst = await request(app)
      .post(`/internal/provider-services/${firstServiceId}/publish`)
      .set("Authorization", "Bearer test-admin-token")
      .send({
        reviewerIdentity: "ops@test",
        settlementMode: "verified_escrow"
      });

    expect(republishedFirst.status).toBe(409);
    expect(republishedFirst.body.error).toContain("API namespace already exists: signals-republish");
  });

  it("still returns the free upstream result when completion persistence fails", async () => {
    class FailingCompletionAttemptStore extends InMemoryMarketplaceStore {
      private attemptWrites = 0;

      override async recordProviderAttempt(
        input: Parameters<InMemoryMarketplaceStore["recordProviderAttempt"]>[0]
      ): Promise<Awaited<ReturnType<InMemoryMarketplaceStore["recordProviderAttempt"]>>> {
        this.attemptWrites += 1;
        if (this.attemptWrites > 1) {
          throw new Error("Provider attempt persistence failed.");
        }

        return super.recordProviderAttempt(input);
      }
    }

    vi.spyOn(console, "error").mockImplementation(() => {});

    const providerWallet = await createTestWallet(PROVIDER_PRIVATE_KEY);
    const store = new FailingCompletionAttemptStore();
    const { app } = await createTestApp({ store });
    const providerToken = await createSiteSession(app, providerWallet);

    const profile = await request(app)
      .post("/provider/me")
      .set("Authorization", `Bearer ${providerToken}`)
      .send({
        displayName: "Signal Labs",
        websiteUrl: "https://provider.example.com"
      });

    expect(profile.status).toBe(201);

    const createdService = await request(app)
      .post("/provider/services")
      .set("Authorization", `Bearer ${providerToken}`)
      .send({
        serviceType: "marketplace_proxy",
        slug: "signal-labs-free-persist",
        apiNamespace: "signals-free-persist",
        name: "Signal Labs Free Persist",
        tagline: "Free signal route with strict persistence",
        about: "Provider-authored free signal endpoints.",
        categories: ["Research"],
        promptIntro: 'I want to use the "Signal Labs Free Persist" service on Fast Marketplace.',
        setupInstructions: ["Call the marketplace proxy route."],
        websiteUrl: "https://provider.example.com",
        payoutWallet: providerWallet.address
      });

    expect(createdService.status).toBe(201);
    const serviceId = createdService.body.service.id as string;

    const createdEndpoint = await request(app)
      .post(`/provider/services/${serviceId}/endpoints`)
      .set("Authorization", `Bearer ${providerToken}`)
      .send({
        endpointType: "marketplace_proxy",
        operation: "search",
        method: "POST",
        title: "Search",
        description: "Return a free signal snapshot.",
        billingType: "free",
        mode: "sync",
        requestSchemaJson: {
          type: "object",
          properties: {
            query: { type: "string", minLength: 1 }
          },
          required: ["query"],
          additionalProperties: false
        },
        responseSchemaJson: {
          type: "object",
          properties: {
            items: {
              type: "array",
              items: { type: "string" }
            }
          },
          required: ["items"],
          additionalProperties: false
        },
        requestExample: {
          query: "FAST"
        },
        responseExample: {
          items: ["alpha"]
        },
        upstreamBaseUrl: "https://provider.example.com",
        upstreamPath: "/api/search",
        upstreamAuthMode: "none"
      });

    expect(createdEndpoint.status).toBe(201);

    const verificationChallenge = await request(app)
      .post(`/provider/services/${serviceId}/verification-challenge`)
      .set("Authorization", `Bearer ${providerToken}`);

    expect(verificationChallenge.status).toBe(200);

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url === verificationChallenge.body.expectedUrl) {
        return new Response(verificationChallenge.body.token, { status: 200 });
      }

      if (url === "https://provider.example.com/api/search") {
        return new Response(JSON.stringify({ items: ["alpha"] }), {
          status: 200,
          headers: {
            "content-type": "application/json"
          }
        });
      }

      return new Response("not found", { status: 404 });
    });

    const verified = await request(app)
      .post(`/provider/services/${serviceId}/verify`)
      .set("Authorization", `Bearer ${providerToken}`);

    expect(verified.status).toBe(200);

    const submitted = await request(app)
      .post(`/provider/services/${serviceId}/submit`)
      .set("Authorization", `Bearer ${providerToken}`);

    expect(submitted.status).toBe(202);

    const published = await request(app)
      .post(`/internal/provider-services/${serviceId}/publish`)
      .set("Authorization", "Bearer test-admin-token")
      .send({
        reviewerIdentity: "ops@test",
        settlementMode: "verified_escrow"
      });

    expect(published.status).toBe(200);

    const response = await request(app)
      .post("/api/signals-free-persist/search")
      .send({ query: "FAST" });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ items: ["alpha"] });

    const analytics = await store.getServiceAnalytics(["signals-free-persist.search.v1"]);
    expect(analytics.totalCalls).toBe(1);
    expect(analytics.successRate30d).toBe(0);
  });

  it("publishes the submitted snapshot even if later draft edits are community-incompatible", async () => {
    const providerWallet = await createTestWallet(PROVIDER_PRIVATE_KEY);
    const { app } = await createTestApp();
    const providerToken = await createSiteSession(app, providerWallet);

    const profile = await request(app)
      .post("/provider/me")
      .set("Authorization", `Bearer ${providerToken}`)
      .send({
        displayName: "Signal Labs",
        websiteUrl: "https://provider.example.com"
      });

    expect(profile.status).toBe(201);

    const createdService = await request(app)
      .post("/provider/services")
      .set("Authorization", `Bearer ${providerToken}`)
      .send({
        serviceType: "marketplace_proxy",
        slug: "signal-labs-snapshot",
        apiNamespace: "signals-snapshot",
        name: "Signal Snapshot",
        tagline: "Validated against the submitted snapshot.",
        about: "A provider-owned pricing API used to verify publish validation matches the submitted version.",
        categories: ["analytics"],
        promptIntro: "Use this API to fetch a fixed-price market signal.",
        setupInstructions: ["Create a provider account.", "Verify the provider domain before submitting."],
        websiteUrl: "https://provider.example.com",
        payoutWallet: providerWallet.address
      });

    expect(createdService.status).toBe(201);
    const serviceId = createdService.body.service.id as string;

    const runtimeKey = await request(app)
      .post(`/provider/services/${serviceId}/runtime-key`)
      .set("Authorization", `Bearer ${providerToken}`);
    expect(runtimeKey.status).toBe(201);

    const fixedEndpoint = await request(app)
      .post(`/provider/services/${serviceId}/endpoints`)
      .set("Authorization", `Bearer ${providerToken}`)
      .send({
        endpointType: "marketplace_proxy",
        operation: "quote",
        method: "POST",
        title: "Get Quote",
        description: "Returns the latest signal quote.",
        billingType: "fixed_x402",
        price: "$0.25",
        mode: "sync",
        requestSchemaJson: {
          type: "object",
          properties: {
            symbol: { type: "string" }
          },
          required: ["symbol"],
          additionalProperties: false
        },
        responseSchemaJson: {
          type: "object",
          properties: {
            symbol: { type: "string" },
            price: { type: "number" }
          },
          required: ["symbol", "price"],
          additionalProperties: false
        },
        requestExample: { symbol: "FAST" },
        responseExample: { symbol: "FAST", price: 42.5 },
        upstreamBaseUrl: "https://provider.example.com",
        upstreamPath: "/api/quote",
        upstreamAuthMode: "none"
      });
    expect(fixedEndpoint.status).toBe(201);

    const verificationChallenge = await request(app)
      .post(`/provider/services/${serviceId}/verification-challenge`)
      .set("Authorization", `Bearer ${providerToken}`);
    expect(verificationChallenge.status).toBe(200);

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      if (String(input) === verificationChallenge.body.expectedUrl) {
        return new Response(verificationChallenge.body.token, { status: 200 });
      }

      return new Response("not found", { status: 404 });
    });

    const verified = await request(app)
      .post(`/provider/services/${serviceId}/verify`)
      .set("Authorization", `Bearer ${providerToken}`);
    expect(verified.status).toBe(200);

    const submitted = await request(app)
      .post(`/provider/services/${serviceId}/submit`)
      .set("Authorization", `Bearer ${providerToken}`);
    expect(submitted.status).toBe(202);

    const laterDraftEndpoint = await request(app)
      .post(`/provider/services/${serviceId}/endpoints`)
      .set("Authorization", `Bearer ${providerToken}`)
      .send({
        endpointType: "marketplace_proxy",
        operation: "topup",
        method: "POST",
        title: "Top Up",
        description: "Funds marketplace-managed balance for later spending.",
        billingType: "topup_x402_variable",
        minAmount: "10",
        maxAmount: "100",
        mode: "sync",
        requestSchemaJson: {
          type: "object",
          properties: {
            amount: { type: "string" }
          },
          required: ["amount"],
          additionalProperties: false
        },
        responseSchemaJson: {
          type: "object",
          properties: {
            ok: { type: "boolean" }
          },
          required: ["ok"],
          additionalProperties: false
        },
        requestExample: { amount: "25" },
        responseExample: { ok: true }
      });
    expect(laterDraftEndpoint.status).toBe(201);

    const published = await request(app)
      .post(`/internal/provider-services/${serviceId}/publish`)
      .set("Authorization", "Bearer test-admin-token")
      .send({
        reviewerIdentity: "ops@test",
        settlementMode: "community_direct"
      });

    expect(published.status).toBe(200);
    expect(published.body.endpoints).toHaveLength(2);

    const publicDetail = await request(app).get("/catalog/services/signal-labs-snapshot");
    expect(publicDetail.status).toBe(200);
    expect(publicDetail.body.endpoints).toHaveLength(1);
    expect(publicDetail.body.endpoints[0].proxyUrl).toContain("/api/signals-snapshot/quote");
  });

  it("does not re-execute stale pending self-serve HTTP charges and auto-refunds them in the worker", async () => {
    class FlakyProviderStore extends InMemoryMarketplaceStore {
      private remainingCompletedWriteFailures = 1;

      override async saveSyncIdempotency(input: Parameters<InMemoryMarketplaceStore["saveSyncIdempotency"]>[0]) {
        if (this.remainingCompletedWriteFailures > 0 && input.statusCode >= 200 && input.statusCode < 400) {
          this.remainingCompletedWriteFailures -= 1;
          throw new Error("sync idempotency write failed");
        }

        return super.saveSyncIdempotency(input);
      }
    }

    const providerWallet = await createTestWallet(PROVIDER_PRIVATE_KEY);
    const store = new FlakyProviderStore();
    const { app } = await createTestApp({ store });
    const providerToken = await createSiteSession(app, providerWallet);

    const profile = await request(app)
      .post("/provider/me")
      .set("Authorization", `Bearer ${providerToken}`)
      .send({
        displayName: "Signal Labs",
        websiteUrl: "https://provider.example.com"
      });

    expect(profile.status).toBe(201);

    const createdService = await request(app)
      .post("/provider/services")
      .set("Authorization", `Bearer ${providerToken}`)
      .send({
        serviceType: "marketplace_proxy",
        slug: "signal-labs-recovery",
        apiNamespace: "signals-recovery",
        name: "Signal Labs Recovery",
        tagline: "Recovery safety checks",
        about: "Provider-authored signal endpoints.",
        categories: ["Research"],
        promptIntro: 'I want to use the "Signal Labs Recovery" service on Fast Marketplace.',
        setupInstructions: ["Use a funded Fast wallet.", "Call the marketplace proxy route."],
        websiteUrl: "https://provider.example.com",
        payoutWallet: providerWallet.address
      });

    expect(createdService.status).toBe(201);
    const serviceId = createdService.body.service.id as string;

    const createdEndpoint = await request(app)
      .post(`/provider/services/${serviceId}/endpoints`)
      .set("Authorization", `Bearer ${providerToken}`)
      .send({
        endpointType: "marketplace_proxy",
        operation: "quote",
        method: "POST",
        title: "Quote",
        description: "Return a single quote snapshot.",
        billingType: "fixed_x402",
        price: "$0.25",
        mode: "sync",
        requestSchemaJson: {
          type: "object",
          properties: {
            symbol: { type: "string", minLength: 1 }
          },
          required: ["symbol"],
          additionalProperties: false
        },
        responseSchemaJson: {
          type: "object",
          properties: {
            symbol: { type: "string" },
            price: { type: "number" }
          },
          required: ["symbol", "price"],
          additionalProperties: false
        },
        requestExample: {
          symbol: "FAST"
        },
        responseExample: {
          symbol: "FAST",
          price: 42.5
        },
        upstreamBaseUrl: "https://provider.example.com",
        upstreamPath: "/api/quote",
        upstreamAuthMode: "none"
      });

    expect(createdEndpoint.status).toBe(201);

    const verificationChallenge = await request(app)
      .post(`/provider/services/${serviceId}/verification-challenge`)
      .set("Authorization", `Bearer ${providerToken}`);

    expect(verificationChallenge.status).toBe(200);

    let upstreamExecutions = 0;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url === verificationChallenge.body.expectedUrl) {
        return new Response(verificationChallenge.body.token, { status: 200 });
      }

      if (url === "https://provider.example.com/api/quote") {
        upstreamExecutions += 1;
        return new Response(JSON.stringify({ symbol: "FAST", price: 42.5 }), {
          status: 200,
          headers: {
            "content-type": "application/json"
          }
        });
      }

      return new Response("not found", { status: 404 });
    });

    await request(app)
      .post(`/provider/services/${serviceId}/verify`)
      .set("Authorization", `Bearer ${providerToken}`);
    await request(app)
      .post(`/provider/services/${serviceId}/submit`)
      .set("Authorization", `Bearer ${providerToken}`);
    await request(app)
      .post(`/internal/provider-services/${serviceId}/publish`)
      .set("Authorization", "Bearer test-admin-token")
      .send({
        reviewerIdentity: "ops@test",
        settlementMode: "verified_escrow"
      });

    const first = await request(app)
      .post("/api/signals-recovery/quote")
      .set("X-PAYMENT", Buffer.from(JSON.stringify({ paid: true })).toString("base64"))
      .set("PAYMENT-IDENTIFIER", "payment_provider_sync_recovery_1")
      .send({ symbol: "FAST" });

    expect(first.status).toBe(500);
    expect(upstreamExecutions).toBe(1);

    const idempotencyByPaymentId = (store as unknown as {
      idempotencyByPaymentId: Map<string, {
        updatedAt: string;
      }>;
    }).idempotencyByPaymentId;
    const pending = idempotencyByPaymentId.get("payment_provider_sync_recovery_1");
    if (!pending) {
      throw new Error("Missing pending provider recovery record.");
    }
    idempotencyByPaymentId.set("payment_provider_sync_recovery_1", {
      ...pending,
      updatedAt: new Date(Date.now() - 20_000).toISOString()
    });

    const second = await request(app)
      .post("/api/signals-recovery/quote")
      .set("X-PAYMENT", Buffer.from(JSON.stringify({ paid: true })).toString("base64"))
      .set("PAYMENT-IDENTIFIER", "payment_provider_sync_recovery_1")
      .send({ symbol: "FAST" });

    expect(second.status).toBe(409);
    expect(second.body.error).toContain("reconciled automatically");
    expect(upstreamExecutions).toBe(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://provider.example.com/api/quote",
      expect.objectContaining({
        method: "POST"
      })
    );

    await runMarketplaceWorkerCycle({
      store,
      secretsKey: "test-secrets-key",
      refundService: {
        async issueRefund() {
          return { txHash: "0xmanualrecoveryrefund" };
        }
      }
    });

    const refunded = await request(app)
      .post("/api/signals-recovery/quote")
      .set("X-PAYMENT", Buffer.from(JSON.stringify({ paid: true })).toString("base64"))
      .set("PAYMENT-IDENTIFIER", "payment_provider_sync_recovery_1")
      .send({ symbol: "FAST" });

    expect(refunded.status).toBe(500);
    expect(refunded.body.error).toContain("not durably recorded");
    expect(refunded.body.refund.status).toBe("sent");
    expect(refunded.body.refund.txHash).toBe("0xmanualrecoveryrefund");
    expect(upstreamExecutions).toBe(1);
  });

  it("supports variable topups and prepaid-credit execution with signed provider identity headers", async () => {
    const providerWallet = await createTestWallet(PROVIDER_PRIVATE_KEY);
    const { app, buyer, store } = await createTestApp();
    const providerToken = await createSiteSession(app, providerWallet);

    await request(app)
      .post("/provider/me")
      .set("Authorization", `Bearer ${providerToken}`)
      .send({
        displayName: "Orders Inc",
        websiteUrl: "https://orders.example.com"
      });

    const createdService = await request(app)
      .post("/provider/services")
      .set("Authorization", `Bearer ${providerToken}`)
      .send({
        serviceType: "marketplace_proxy",
        slug: "orders-inc",
        apiNamespace: "orders",
        name: "Orders Inc",
        tagline: "Prepaid purchasing workflows",
        about: "Provider-authored prepaid purchasing endpoints.",
        categories: ["Commerce"],
        promptIntro: 'I want to use the "Orders Inc" service on Fast Marketplace.',
        setupInstructions: ["Fund a prepaid credit balance first."],
        websiteUrl: "https://orders.example.com",
        payoutWallet: providerWallet.address
      });

    expect(createdService.status).toBe(201);
    const serviceId = createdService.body.service.id as string;

    const runtimeKeyResponse = await request(app)
      .post(`/provider/services/${serviceId}/runtime-key`)
      .set("Authorization", `Bearer ${providerToken}`)
      .send({});

    expect(runtimeKeyResponse.status).toBe(201);
    const runtimeKey = runtimeKeyResponse.body.plaintextKey as string;

    const topupEndpoint = await request(app)
      .post(`/provider/services/${serviceId}/endpoints`)
      .set("Authorization", `Bearer ${providerToken}`)
      .send({
        endpointType: "marketplace_proxy",
        operation: "topup",
        method: "POST",
        title: "Top Up",
        description: "Add prepaid marketplace credit.",
        billingType: "topup_x402_variable",
        minAmount: "10",
        maxAmount: "100",
        mode: "sync",
        requestSchemaJson: {
          type: "object",
          properties: {
            amount: { type: "string" }
          },
          required: ["amount"],
          additionalProperties: false
        },
        responseSchemaJson: {
          type: "object",
          properties: {
            topupAmount: { type: "string" }
          },
          required: ["topupAmount"],
          additionalProperties: true
        },
        requestExample: {
          amount: "25"
        },
        responseExample: {
          topupAmount: "25"
        }
      });

    expect(topupEndpoint.status).toBe(201);

    const prepaidEndpoint = await request(app)
      .post(`/provider/services/${serviceId}/endpoints`)
      .set("Authorization", `Bearer ${providerToken}`)
      .send({
        endpointType: "marketplace_proxy",
        operation: "place-order",
        method: "POST",
        title: "Place Order",
        description: "Place an order against prepaid credit.",
        billingType: "prepaid_credit",
        mode: "sync",
        requestSchemaJson: {
          type: "object",
          properties: {
            item: { type: "string" }
          },
          required: ["item"],
          additionalProperties: false
        },
        responseSchemaJson: {
          type: "object",
          properties: {
            orderId: { type: "string" }
          },
          required: ["orderId"],
          additionalProperties: false
        },
        requestExample: {
          item: "notebook"
        },
        responseExample: {
          orderId: "ord_123"
        },
        upstreamBaseUrl: "https://orders.example.com",
        upstreamPath: "/api/place-order",
        upstreamAuthMode: "none"
      });

    expect(prepaidEndpoint.status).toBe(201);

    const verificationChallenge = await request(app)
      .post(`/provider/services/${serviceId}/verification-challenge`)
      .set("Authorization", `Bearer ${providerToken}`);

    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (fetchInput, init) => {
      const url = String(fetchInput);
      if (url === verificationChallenge.body.expectedUrl) {
        return new Response(verificationChallenge.body.token, { status: 200 });
      }

      if (url === "https://orders.example.com/api/place-order") {
        const headers = Object.fromEntries(new Headers(init?.headers).entries());
        const identity = verifyMarketplaceIdentityHeaders({
          headers,
          signingSecret: runtimeKey
        });
        if (!identity.buyerWallet) {
          throw new Error("Prepaid route execution must include a buyer wallet.");
        }

        const reserveResponse = await request(app)
          .post("/provider/runtime/credits/reserve")
          .set("Authorization", `Bearer ${runtimeKey}`)
          .send({
            buyerWallet: identity.buyerWallet,
            amount: "12.5",
            idempotencyKey: `reserve_${identity.requestId}`,
            providerReference: "amazon-order-123"
          });

        if (reserveResponse.status !== 200) {
          return new Response(JSON.stringify(reserveResponse.body), {
            status: reserveResponse.status,
            headers: {
              "content-type": "application/json"
            }
          });
        }

        const captureResponse = await request(app)
          .post(`/provider/runtime/credits/${reserveResponse.body.reservation.id}/capture`)
          .set("Authorization", `Bearer ${runtimeKey}`)
          .send({
            amount: "12.5"
          });

        if (captureResponse.status !== 200) {
          return new Response(JSON.stringify(captureResponse.body), {
            status: captureResponse.status,
            headers: {
              "content-type": "application/json"
            }
          });
        }

        return new Response(JSON.stringify({ orderId: "ord_123" }), {
          status: 200,
          headers: {
            "content-type": "application/json"
          }
        });
      }

      return new Response("not found", { status: 404 });
    });

    const verified = await request(app)
      .post(`/provider/services/${serviceId}/verify`)
      .set("Authorization", `Bearer ${providerToken}`);
    expect(verified.status).toBe(200);

    const submitted = await request(app)
      .post(`/provider/services/${serviceId}/submit`)
      .set("Authorization", `Bearer ${providerToken}`);
    expect(submitted.status).toBe(202);

    const published = await request(app)
      .post(`/internal/provider-services/${serviceId}/publish`)
      .set("Authorization", "Bearer test-admin-token")
      .send({
        reviewerIdentity: "ops@test",
        settlementMode: "verified_escrow"
      });
    expect(published.status).toBe(200);

    const preflightTopup = await request(app)
      .post("/api/orders/topup")
      .send({ amount: "25" });
    expect(preflightTopup.status).toBe(402);
    expect(preflightTopup.body.accepts[0].maxAmountRequired).toBe("25");

    const toppedUp = await request(app)
      .post("/api/orders/topup")
      .set("X-PAYMENT", Buffer.from(JSON.stringify({ paid: true })).toString("base64"))
      .set("PAYMENT-IDENTIFIER", "payment_orders_topup_1")
      .send({ amount: "25" });

    expect(toppedUp.status).toBe(200);
    expect(toppedUp.body.topupAmount).toBe("25");
    expect(toppedUp.body.account.availableAmountDecimal).toBe("25");

    const unauthorizedPrepaid = await request(app)
      .post("/api/orders/place-order")
      .send({ item: "notebook" });
    expect(unauthorizedPrepaid.status).toBe(401);

    const challenge = await request(app)
      .post("/auth/challenge")
      .send({
        wallet: buyer.address,
        resourceType: "api",
        resourceId: "orders.place-order.v1"
      });
    expect(challenge.status).toBe(200);

    const signed = await buyer.wallet.sign({ message: challenge.body.message });
    const apiSession = await request(app)
      .post("/auth/session")
      .send({
        wallet: buyer.address,
        resourceType: "api",
        resourceId: "orders.place-order.v1",
        nonce: challenge.body.nonce,
        expiresAt: challenge.body.expiresAt,
        signature: signed.signature
      });
    expect(apiSession.status).toBe(200);

    const prepaid = await request(app)
      .post("/api/orders/place-order")
      .set("Authorization", `Bearer ${apiSession.body.accessToken}`)
      .send({ item: "notebook" });

    expect(prepaid.status).toBe(200);
    expect(prepaid.body.orderId).toBe("ord_123");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://orders.example.com/api/place-order",
      expect.objectContaining({
        method: "POST"
      })
    );

    const toppedUpReplay = await request(app)
      .post("/api/orders/topup")
      .set("X-PAYMENT", Buffer.from(JSON.stringify({ paid: true })).toString("base64"))
      .set("PAYMENT-IDENTIFIER", "payment_orders_topup_1")
      .send({ amount: "25" });

    expect(toppedUpReplay.status).toBe(200);
    expect(toppedUpReplay.body).toEqual(toppedUp.body);

    const creditAccount = await store.getCreditAccount(serviceId, buyer.address, "fastUSDC");
    expect(creditAccount?.availableAmount).toBe("12500000");
    expect(creditAccount?.reservedAmount).toBe("0");

    const pendingPayouts = await store.listPendingProviderPayouts(10);
    expect(pendingPayouts).toHaveLength(1);
    expect(pendingPayouts[0]?.amount).toBe("25000000");
  });

  it("requires re-verification when the provider changes the service website host", async () => {
    const providerWallet = await createTestWallet(PROVIDER_PRIVATE_KEY);
    const { app } = await createTestApp();
    const providerToken = await createSiteSession(app, providerWallet);

    await request(app)
      .post("/provider/me")
      .set("Authorization", `Bearer ${providerToken}`)
      .send({
        displayName: "Signal Labs",
        websiteUrl: "https://provider.example.com"
      });

    const createdService = await request(app)
      .post("/provider/services")
      .set("Authorization", `Bearer ${providerToken}`)
      .send({
        serviceType: "marketplace_proxy",
        slug: "signal-labs-reverify",
        apiNamespace: "signals-reverify",
        name: "Signal Labs Reverify",
        tagline: "Short-form market signals",
        about: "Provider-authored signal endpoints.",
        categories: ["Research"],
        promptIntro: "Prompt intro",
        setupInstructions: ["Use a funded Fast wallet."],
        websiteUrl: "https://provider.example.com",
        payoutWallet: providerWallet.address
      });

    const serviceId = createdService.body.service.id as string;

    await request(app)
      .post(`/provider/services/${serviceId}/endpoints`)
      .set("Authorization", `Bearer ${providerToken}`)
      .send({
        endpointType: "marketplace_proxy",
        operation: "quote",
        method: "POST",
        title: "Quote",
        description: "Return a single quote snapshot.",
        billingType: "fixed_x402",
        price: "$0.25",
        mode: "sync",
        requestSchemaJson: {
          type: "object",
          properties: {
            symbol: { type: "string" }
          },
          required: ["symbol"],
          additionalProperties: false
        },
        responseSchemaJson: {
          type: "object",
          properties: {
            symbol: { type: "string" }
          },
          required: ["symbol"],
          additionalProperties: false
        },
        requestExample: { symbol: "FAST" },
        responseExample: { symbol: "FAST" },
        upstreamBaseUrl: "https://provider.example.com",
        upstreamPath: "/api/quote",
        upstreamAuthMode: "none"
      });

    const verificationChallenge = await request(app)
      .post(`/provider/services/${serviceId}/verification-challenge`)
      .set("Authorization", `Bearer ${providerToken}`);

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      if (String(input) === verificationChallenge.body.expectedUrl) {
        return new Response(verificationChallenge.body.token, { status: 200 });
      }

      return new Response("not found", { status: 404 });
    });

    const verified = await request(app)
      .post(`/provider/services/${serviceId}/verify`)
      .set("Authorization", `Bearer ${providerToken}`);

    expect(verified.status).toBe(200);

    const patched = await request(app)
      .patch(`/provider/services/${serviceId}`)
      .set("Authorization", `Bearer ${providerToken}`)
      .send({
        websiteUrl: "https://new-provider.example.com"
      });

    expect(patched.status).toBe(200);

    const submitted = await request(app)
      .post(`/provider/services/${serviceId}/submit`)
      .set("Authorization", `Bearer ${providerToken}`);

    expect(submitted.status).toBe(400);
    expect(submitted.body.error).toContain("Verify website ownership");
  });

  it("refunds rejected sync upstream calls and excludes them from accepted call analytics", async () => {
    const providerWallet = await createTestWallet(PROVIDER_PRIVATE_KEY);
    const { app, store } = await createTestApp();
    const providerToken = await createSiteSession(app, providerWallet);

    const profile = await request(app)
      .post("/provider/me")
      .set("Authorization", `Bearer ${providerToken}`)
      .send({
        displayName: "Signal Labs",
        websiteUrl: "https://provider.example.com"
      });

    const createdService = await request(app)
      .post("/provider/services")
      .set("Authorization", `Bearer ${providerToken}`)
      .send({
        serviceType: "marketplace_proxy",
        slug: "signal-labs-failure",
        apiNamespace: "signals-failure",
        name: "Signal Labs Failure",
        tagline: "Short-form market signals",
        about: "Provider-authored signal endpoints.",
        categories: ["Research"],
        promptIntro: "Prompt intro",
        setupInstructions: ["Use a funded Fast wallet."],
        websiteUrl: "https://provider.example.com",
        payoutWallet: providerWallet.address
      });

    const serviceId = createdService.body.service.id as string;

    await request(app)
      .post(`/provider/services/${serviceId}/endpoints`)
      .set("Authorization", `Bearer ${providerToken}`)
      .send({
        endpointType: "marketplace_proxy",
        operation: "quote",
        method: "POST",
        title: "Quote",
        description: "Return a single quote snapshot.",
        billingType: "fixed_x402",
        price: "$0.25",
        mode: "sync",
        requestSchemaJson: {
          type: "object",
          properties: {
            symbol: { type: "string" }
          },
          required: ["symbol"],
          additionalProperties: false
        },
        responseSchemaJson: {
          type: "object",
          properties: {
            symbol: { type: "string" }
          },
          required: ["symbol"],
          additionalProperties: false
        },
        requestExample: { symbol: "FAST" },
        responseExample: { symbol: "FAST" },
        upstreamBaseUrl: "https://provider.example.com",
        upstreamPath: "/api/quote",
        upstreamAuthMode: "none"
      });

    const verificationChallenge = await request(app)
      .post(`/provider/services/${serviceId}/verification-challenge`)
      .set("Authorization", `Bearer ${providerToken}`);

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url === verificationChallenge.body.expectedUrl) {
        return new Response(verificationChallenge.body.token, { status: 200 });
      }

      if (url === "https://provider.example.com/api/quote") {
        return new Response(JSON.stringify({ error: "provider unavailable" }), {
          status: 502,
          headers: {
            "content-type": "application/json"
          }
        });
      }

      return new Response("not found", { status: 404 });
    });

    await request(app)
      .post(`/provider/services/${serviceId}/verify`)
      .set("Authorization", `Bearer ${providerToken}`);
    await request(app)
      .post(`/provider/services/${serviceId}/submit`)
      .set("Authorization", `Bearer ${providerToken}`);
    await request(app)
      .post(`/internal/provider-services/${serviceId}/publish`)
      .set("Authorization", "Bearer test-admin-token")
      .send({
        reviewerIdentity: "ops@test",
        settlementMode: "verified_escrow"
      });

    const failed = await request(app)
      .post("/api/signals-failure/quote")
      .set("X-PAYMENT", Buffer.from(JSON.stringify({ paid: true })).toString("base64"))
      .set("PAYMENT-IDENTIFIER", "payment_provider_sync_failure_1")
      .send({ symbol: "FAST" });

    expect(failed.status).toBe(502);
    expect(failed.body.error).toContain("Payment was refunded");
    expect(failed.body.refund.status).toBe("sent");
    expect(failed.body.refund.txHash).toBe("0xrefund");

    const replay = await request(app)
      .post("/api/signals-failure/quote")
      .set("X-PAYMENT", Buffer.from(JSON.stringify({ paid: true })).toString("base64"))
      .set("PAYMENT-IDENTIFIER", "payment_provider_sync_failure_1")
      .send({ symbol: "FAST" });

    expect(replay.status).toBe(502);
    expect(replay.body).toEqual(failed.body);

    const record = await store.getIdempotencyByPaymentId("payment_provider_sync_failure_1");
    expect(record?.responseStatusCode).toBe(502);

    const analytics = await store.getServiceAnalytics(["signals-failure.quote.v1"]);
    expect(analytics.totalCalls).toBe(0);
    expect(analytics.revenueRaw).toBe("0");
  });

  it("prevents a different wallet from reading another provider draft", async () => {
    const providerWallet = await createTestWallet(PROVIDER_PRIVATE_KEY);
    const otherWallet = await createTestWallet(OTHER_PRIVATE_KEY);
    const { app } = await createTestApp();
    const providerToken = await createSiteSession(app, providerWallet);
    const otherToken = await createSiteSession(app, otherWallet);

    await request(app)
      .post("/provider/me")
      .set("Authorization", `Bearer ${providerToken}`)
      .send({
        displayName: "Signal Labs"
      });

    const createdService = await request(app)
      .post("/provider/services")
      .set("Authorization", `Bearer ${providerToken}`)
      .send({
        serviceType: "marketplace_proxy",
        slug: "private-signal-labs",
        apiNamespace: "private-signals",
        name: "Private Signal Labs",
        tagline: "Private draft",
        about: "Not for other wallets.",
        categories: ["Research"],
        promptIntro: "Private draft",
        setupInstructions: ["None"],
        payoutWallet: providerWallet.address
      });

    expect(createdService.status).toBe(201);

    const response = await request(app)
      .get(`/provider/services/${createdService.body.service.id}`)
      .set("Authorization", `Bearer ${otherToken}`);

    expect(response.status).toBe(404);
  });

  it("returns clean provider mutation errors for missing profiles and duplicate endpoint operations", async () => {
    const providerWallet = await createTestWallet(PROVIDER_PRIVATE_KEY);
    const { app } = await createTestApp();
    const providerToken = await createSiteSession(app, providerWallet);

    const missingProfile = await request(app)
      .post("/provider/services")
      .set("Authorization", `Bearer ${providerToken}`)
      .send({
        serviceType: "marketplace_proxy",
        slug: "signal-labs",
        apiNamespace: "signals",
        name: "Signal Labs",
        tagline: "Short-form market signals",
        about: "Provider-authored signal endpoints.",
        categories: ["Research"],
        promptIntro: "Prompt intro",
        setupInstructions: ["Use a funded Fast wallet."],
        payoutWallet: providerWallet.address
      });

    expect(missingProfile.status).toBe(404);
    expect(missingProfile.body.error).toContain("Provider account not found");

    await request(app)
      .post("/provider/me")
      .set("Authorization", `Bearer ${providerToken}`)
      .send({
        displayName: "Signal Labs",
        websiteUrl: "https://provider.example.com"
      });

    const createdService = await request(app)
      .post("/provider/services")
      .set("Authorization", `Bearer ${providerToken}`)
      .send({
        serviceType: "marketplace_proxy",
        slug: "signal-labs-2",
        apiNamespace: "signals-2",
        name: "Signal Labs 2",
        tagline: "Short-form market signals",
        about: "Provider-authored signal endpoints.",
        categories: ["Research"],
        promptIntro: "Prompt intro",
        setupInstructions: ["Use a funded Fast wallet."],
        websiteUrl: "https://provider.example.com",
        payoutWallet: providerWallet.address
      });

    expect(createdService.status).toBe(201);

    const firstEndpoint = await request(app)
      .post(`/provider/services/${createdService.body.service.id}/endpoints`)
      .set("Authorization", `Bearer ${providerToken}`)
      .send({
        endpointType: "marketplace_proxy",
        operation: "quote",
        method: "POST",
        title: "Quote",
        description: "Return a single quote snapshot.",
        billingType: "fixed_x402",
        price: "$0.25",
        mode: "sync",
        requestSchemaJson: {
          type: "object",
          properties: {
            symbol: { type: "string" }
          },
          required: ["symbol"],
          additionalProperties: false
        },
        responseSchemaJson: {
          type: "object",
          properties: {
            symbol: { type: "string" }
          },
          required: ["symbol"],
          additionalProperties: false
        },
        requestExample: { symbol: "FAST" },
        responseExample: { symbol: "FAST" },
        upstreamBaseUrl: "https://provider.example.com",
        upstreamPath: "/api/quote",
        upstreamAuthMode: "none"
      });

    expect(firstEndpoint.status).toBe(201);

    const duplicateEndpoint = await request(app)
      .post(`/provider/services/${createdService.body.service.id}/endpoints`)
      .set("Authorization", `Bearer ${providerToken}`)
      .send({
        endpointType: "marketplace_proxy",
        operation: "quote",
        method: "POST",
        title: "Quote duplicate",
        description: "Duplicate operation.",
        billingType: "fixed_x402",
        price: "$0.25",
        mode: "sync",
        requestSchemaJson: {
          type: "object",
          properties: {},
          additionalProperties: false
        },
        responseSchemaJson: {
          type: "object",
          properties: {},
          additionalProperties: false
        },
        requestExample: {},
        responseExample: {},
        upstreamBaseUrl: "https://provider.example.com",
        upstreamPath: "/api/quote",
        upstreamAuthMode: "none"
      });

    expect(duplicateEndpoint.status).toBe(409);
    expect(duplicateEndpoint.body.error).toContain("Operation already exists");
  });

  it("previews provider endpoint drafts from an OpenAPI document", async () => {
    const providerWallet = await createTestWallet(PROVIDER_PRIVATE_KEY);
    const { app } = await createTestApp();
    const providerToken = await createSiteSession(app, providerWallet);

    await request(app)
      .post("/provider/me")
      .set("Authorization", `Bearer ${providerToken}`)
      .send({
        displayName: "Signal Labs",
        websiteUrl: "https://provider.example.com"
      });

    const createdService = await request(app)
      .post("/provider/services")
      .set("Authorization", `Bearer ${providerToken}`)
      .send({
        serviceType: "marketplace_proxy",
        slug: "signal-import",
        apiNamespace: "signal-import",
        name: "Signal Import",
        tagline: "Short-form market signals",
        about: "Provider-authored signal endpoints.",
        categories: ["Research"],
        promptIntro: "Prompt intro",
        setupInstructions: ["Use a funded Fast wallet."],
        websiteUrl: "https://provider.example.com",
        payoutWallet: providerWallet.address
      });

    expect(createdService.status).toBe(201);

    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          openapi: "3.0.3",
          info: {
            title: "Provider API",
            version: "1.0.0"
          },
          servers: [
            {
              url: "https://api.provider.example.com"
            }
          ],
          paths: {
            "/search": {
              post: {
                operationId: "SearchSignals",
                summary: "Search signals",
                description: "Search provider signals.",
                requestBody: {
                  content: {
                    "application/json": {
                      schema: {
                        type: "object",
                        properties: {
                          query: { type: "string" }
                        },
                        required: ["query"],
                        additionalProperties: false
                      }
                    }
                  }
                },
                responses: {
                  "200": {
                    content: {
                      "application/json": {
                        schema: {
                          type: "object",
                          properties: {
                            items: {
                              type: "array",
                              items: { type: "string" }
                            }
                          },
                          required: ["items"],
                          additionalProperties: false
                        }
                      }
                    }
                  }
                }
              }
            },
            "/health": {
              get: {
                summary: "Health"
              }
            }
          }
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json"
          }
        }
      )
    );

    const response = await request(app)
      .post(`/provider/services/${createdService.body.service.id}/openapi/import`)
      .set("Authorization", `Bearer ${providerToken}`)
      .send({
        documentUrl: "https://docs.provider.example.com/openapi.json"
      });

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://docs.provider.example.com/openapi.json",
      expect.objectContaining({
        headers: {
          accept: "application/json"
        }
      })
    );
    expect(response.body.title).toBe("Provider API");
    expect(response.body.endpoints).toHaveLength(2);
    expect(response.body.endpoints[0]).toMatchObject({
      operation: "search-signals",
      method: "POST",
      title: "Search signals",
      upstreamBaseUrl: "https://api.provider.example.com",
      upstreamPath: "/search",
      upstreamAuthMode: "none"
    });
    expect(response.body.endpoints[1]).toMatchObject({
      operation: "health",
      method: "GET",
      title: "Health",
      upstreamBaseUrl: "https://api.provider.example.com",
      upstreamPath: "/health",
      upstreamAuthMode: "none"
    });
    expect(response.body.warnings).toEqual([]);
  });
});
