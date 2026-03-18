import { FastProvider, FastWallet } from "@fastxyz/sdk";
import request from "supertest";
import { describe, expect, it } from "vitest";

import { InMemoryMarketplaceStore } from "@marketplace/shared";

import { createMarketplaceApi } from "./app.js";

const TEST_PRIVATE_KEY = "22".repeat(32);

async function createTestWallet() {
  const provider = new FastProvider({
    network: "mainnet",
    networks: {
      mainnet: {
        rpc: "https://api.fast.xyz/proxy",
        explorer: "https://explorer.fast.xyz"
      }
    }
  });
  const wallet = await FastWallet.fromPrivateKey(TEST_PRIVATE_KEY, provider);
  const exported = await wallet.exportKeys();
  return {
    wallet,
    address: wallet.address,
    payerHex: `0x${exported.publicKey}`
  };
}

async function createTestApp() {
  const buyer = await createTestWallet();
  const store = new InMemoryMarketplaceStore();
  const app = createMarketplaceApi({
    store,
    payTo: buyer.address,
    sessionSecret: "test-session-secret",
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
    webBaseUrl: "https://fast.8o.vc"
  });

  return {
    app,
    store,
    buyer
  };
}

describe("marketplace api", () => {
  it("returns catalog services and service details with generated prompts", async () => {
    const { app } = await createTestApp();

    const listResponse = await request(app).get("/catalog/services");
    expect(listResponse.status).toBe(200);
    expect(listResponse.body.services).toHaveLength(1);
    expect(listResponse.body.services[0].slug).toBe("mock-research-signals");

    const detailResponse = await request(app).get("/catalog/services/mock-research-signals");
    expect(detailResponse.status).toBe(200);
    expect(detailResponse.body.summary.endpointCount).toBe(2);
    expect(detailResponse.body.skillUrl).toBe("https://fast.8o.vc/skill.md");
    expect(detailResponse.body.useThisServicePrompt).toContain("https://fast.8o.vc/skill.md");
  });

  it("accepts public suggestions and requires an admin token for internal review", async () => {
    const { app } = await createTestApp();

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

  it("returns 402 and payment requirements for unpaid routes", async () => {
    const { app } = await createTestApp();

    const response = await request(app)
      .post("/api/mock/quick-insight")
      .send({ query: "alpha" });

    expect(response.status).toBe(402);
    expect(response.headers["payment-required"]).toBeDefined();
    expect(response.body.accepts[0].network).toBe("fast-mainnet");
  });

  it("accepts legacy X-PAYMENT on a sync route", async () => {
    const { app, store } = await createTestApp();

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
    expect(record?.payoutSplit.providerAccountId).toBe("mock");
  });

  it("replays the same sync response for the same payment id and request", async () => {
    const { app } = await createTestApp();

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

  it("creates an async job and lets the paying wallet poll it for free", async () => {
    const { app, buyer, store } = await createTestApp();

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
    expect(job?.payoutSplit.providerAccountId).toBe("mock");
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
    expect(challenge.body.resourceId).toBe("https://fast.8o.vc");

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
    expect(session.body.resourceId).toBe("https://fast.8o.vc");
    expect(session.body.accessToken).toBeDefined();
  });

  it("rejects a payment proof if the facilitator verifies the wrong Fast network", async () => {
    const buyer = await createTestWallet();
    const app = createMarketplaceApi({
      store: new InMemoryMarketplaceStore(),
      payTo: buyer.address,
      sessionSecret: "test-session-secret",
      adminToken: "test-admin-token",
      facilitatorClient: {
        async verify() {
          return {
            isValid: true,
            payer: buyer.payerHex,
            network: "fast-testnet"
          };
        }
      },
      webBaseUrl: "https://fast.8o.vc"
    });

    const response = await request(app)
      .post("/api/mock/quick-insight")
      .set("X-PAYMENT", Buffer.from(JSON.stringify({ paid: true })).toString("base64"))
      .set("PAYMENT-IDENTIFIER", "payment_wrong_network_1")
      .send({ query: "alpha" });

    expect(response.status).toBe(402);
    expect(response.body.error).toContain("Expected fast-mainnet");
  });
});
