import type { Express } from "express";
import { FastProvider, FastWallet } from "@fastxyz/sdk";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";

import { InMemoryMarketplaceStore } from "@marketplace/shared";

import { createMarketplaceApi } from "./app.js";

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

async function createTestApp(input: { tavilyApiKey?: string | null } = {}) {
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
    refundService: {
      async issueRefund() {
        return { txHash: "0xrefund" };
      }
    },
    webBaseUrl: "https://fast.8o.vc",
    tavilyApiKey: input.tavilyApiKey === undefined ? "tvly-test-key" : (input.tavilyApiKey ?? undefined)
  });

  return {
    app,
    store,
    buyer
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("marketplace api", () => {
  it("returns catalog services and service details with generated prompts", async () => {
    const { app } = await createTestApp();

    const listResponse = await request(app).get("/catalog/services");
    expect(listResponse.status).toBe(200);
    expect(listResponse.body.services.some((service: { slug: string }) => service.slug === "mock-research-signals")).toBe(
      true
    );
    expect(listResponse.body.services.some((service: { slug: string }) => service.slug === "tavily-search")).toBe(true);

    const detailResponse = await request(app).get("/catalog/services/mock-research-signals");
    expect(detailResponse.status).toBe(200);
    expect(detailResponse.body.summary.endpointCount).toBe(2);
    expect(detailResponse.body.skillUrl).toBe("https://fast.8o.vc/skill.md");
    expect(detailResponse.body.useThisServicePrompt).toContain("https://fast.8o.vc/skill.md");
  });

  it("executes the seeded Tavily marketplace route", async () => {
    const { app, store } = await createTestApp();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          query: "fast payments",
          answer: "Fast payments are designed for agent-native settlement.",
          results: [
            {
              title: "Fast payments overview",
              url: "https://fast.8o.vc/blog/payments",
              content: "Overview of Fast-native payment rails.",
              score: 0.88
            }
          ],
          response_time: 0.92,
          usage: {
            credits: 1
          },
          request_id: "tavily-request-1"
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
      .post("/api/tavily/search")
      .set("X-PAYMENT", Buffer.from(JSON.stringify({ paid: true })).toString("base64"))
      .set("PAYMENT-IDENTIFIER", "payment_tavily_sync_1")
      .send({
        query: "fast payments",
        topic: "general",
        search_depth: "basic",
        max_results: 3,
        include_answer: "basic",
        country: "united states",
        auto_parameters: false,
        exact_match: true,
        include_usage: true,
        safe_search: false
      });

    expect(response.status).toBe(200);
    expect(response.body.query).toBe("fast payments");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.tavily.com/search",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          authorization: "Bearer tvly-test-key",
          "content-type": "application/json"
        }),
        body: JSON.stringify({
          query: "fast payments",
          topic: "general",
          search_depth: "basic",
          max_results: 3,
          include_answer: "basic",
          country: "united states",
          auto_parameters: false,
          exact_match: true,
          include_usage: true,
          safe_search: false
        })
      })
    );

    const record = await store.getIdempotencyByPaymentId("payment_tavily_sync_1");
    expect(record?.routeId).toBe("tavily.search.v1");
    expect(record?.payoutSplit.providerAccountId).toBe("provider_marketplace");
    expect(record?.payoutSplit.marketplaceAmount).toBe("50000");
    expect(record?.payoutSplit.providerAmount).toBe("0");
  });

  it("hides the Tavily catalog entry and route when Tavily credentials are not configured", async () => {
    const { app } = await createTestApp({ tavilyApiKey: null });

    const listResponse = await request(app).get("/catalog/services");
    expect(listResponse.status).toBe(200);
    expect(listResponse.body.services.some((service: { slug: string }) => service.slug === "tavily-search")).toBe(false);

    const detailResponse = await request(app).get("/catalog/services/tavily-search");
    expect(detailResponse.status).toBe(404);

    const openApi = await request(app).get("/openapi.json");
    expect(openApi.status).toBe(200);
    expect(openApi.body.paths["/api/tavily/search"]).toBeUndefined();

    const routeResponse = await request(app)
      .post("/api/tavily/search")
      .set("X-PAYMENT", Buffer.from(JSON.stringify({ paid: true })).toString("base64"))
      .set("PAYMENT-IDENTIFIER", "payment_tavily_hidden_1")
      .send({
        query: "fast payments"
      });

    expect(routeResponse.status).toBe(404);
  });

  it("rejects invalid Tavily parameter combinations before payment verification", async () => {
    const { app } = await createTestApp();

    const response = await request(app)
      .post("/api/tavily/search")
      .send({
        query: "fast payments",
        topic: "news",
        country: "united states"
      });

    expect(response.status).toBe(400);
    expect(response.body.error).toContain("Request body failed schema validation");
  });

  it("rejects invalid Tavily country values before payment verification", async () => {
    const { app } = await createTestApp();

    const response = await request(app)
      .post("/api/tavily/search")
      .send({
        query: "fast payments",
        country: "us"
      });

    expect(response.status).toBe(400);
    expect(response.body.error).toContain("Request body failed schema validation");
  });

  it("accepts Tavily country filters without an explicit topic and reaches payment gating", async () => {
    const { app } = await createTestApp();

    const response = await request(app)
      .post("/api/tavily/search")
      .send({
        query: "fast payments",
        country: "united states"
      });

    expect(response.status).toBe(402);
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

  it("lets providers list and claim request intake from their wallet session", async () => {
    const providerWallet = await createTestWallet(PROVIDER_PRIVATE_KEY);
    const otherWallet = await createTestWallet(OTHER_PRIVATE_KEY);
    const { app } = await createTestApp();
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
    const { app } = await createTestApp();

    const response = await request(app)
      .post("/api/mock/quick-insight")
      .send({ query: "alpha" });

    expect(response.status).toBe(402);
    expect(response.headers["payment-required"]).toBeDefined();
    expect(response.body.accepts[0].network).toBe("fast-mainnet");
  });

  it("allows browser CORS requests from the configured web origin", async () => {
    const { app } = await createTestApp();

    const response = await request(app)
      .options("/api/mock/quick-insight")
      .set("Origin", "https://fast.8o.vc")
      .set("Access-Control-Request-Method", "POST")
      .set("Access-Control-Request-Headers", "content-type,payment-identifier,payment-signature");

    expect(response.status).toBe(204);
    expect(response.headers["access-control-allow-origin"]).toBe("https://fast.8o.vc");
    expect(response.headers["access-control-allow-headers"]).toContain("PAYMENT-IDENTIFIER");
    expect(response.headers["access-control-expose-headers"]).toContain("PAYMENT-REQUIRED");
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
    expect(record?.payoutSplit.providerAccountId).toBe("provider_marketplace");
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
    expect(job?.payoutSplit.providerAccountId).toBe("provider_marketplace");
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
      refundService: {
        async issueRefund() {
          return { txHash: "0xrefund" };
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

  it("supports provider onboarding, review publish, and paid execution for a self-serve service", async () => {
    const providerWallet = await createTestWallet(PROVIDER_PRIVATE_KEY);
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

    const createdEndpoint = await request(app)
      .post(`/provider/services/${serviceId}/endpoints`)
      .set("Authorization", `Bearer ${providerToken}`)
      .send({
        operation: "quote",
        title: "Quote",
        description: "Return a single quote snapshot.",
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
        reviewerIdentity: "ops@test"
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
        method: "POST"
      })
    );

    const record = await store.getIdempotencyByPaymentId("payment_provider_sync_1");
    expect(record?.routeId).toBe("signals.quote.v1");
    expect(record?.payoutSplit.providerAccountId).toBe(providerAccountId);
    expect(record?.payoutSplit.providerAmount).toBe("250000");
    expect(record?.payoutSplit.marketplaceAmount).toBe("0");
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
        operation: "quote",
        title: "Quote",
        description: "Return a single quote snapshot.",
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
        operation: "quote",
        title: "Quote",
        description: "Return a single quote snapshot.",
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
        reviewerIdentity: "ops@test"
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
        operation: "quote",
        title: "Quote",
        description: "Return a single quote snapshot.",
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
        operation: "quote",
        title: "Quote duplicate",
        description: "Duplicate operation.",
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
});
