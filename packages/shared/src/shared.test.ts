import { FastProvider, FastWallet } from "@fastxyz/sdk";
import { describe, expect, it } from "vitest";

import {
  InMemoryMarketplaceStore,
  buildPriceRange,
  buildMarketplaceRoutes,
  buildServiceDetail,
  buildOpenApiDocument,
  buildPayoutSplit,
  createChallenge,
  hashNormalizedRequest,
  listServiceDefinitions,
  marketplaceRoutes,
  normalizeFastWalletAddress,
  normalizePaymentHeaders,
  resolveMarketplaceNetworkConfig,
  verifyWalletChallenge
} from "./index.js";

const TEST_PRIVATE_KEY = "11".repeat(32);

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
    publicKey: exported.publicKey
  };
}

describe("shared marketplace helpers", () => {
  it("normalizes payment headers across new and legacy names", () => {
    expect(
      normalizePaymentHeaders({
        "payment-signature": "new-header",
        "x-payment-identifier": "legacy-id"
      })
    ).toEqual({
      paymentId: "legacy-id",
      paymentPayload: "new-header"
    });

    expect(
      normalizePaymentHeaders({
        "x-payment": "legacy-header",
        "payment-identifier": "new-id"
      })
    ).toEqual({
      paymentId: "new-id",
      paymentPayload: "legacy-header"
    });
  });

  it("hashes normalized requests deterministically", () => {
    const route = marketplaceRoutes[0];
    const first = hashNormalizedRequest(route, {
      query: "alpha",
      nested: {
        b: 2,
        a: 1
      }
    });
    const second = hashNormalizedRequest(route, {
      nested: {
        a: 1,
        b: 2
      },
      query: "alpha"
    });

    expect(first).toBe(second);
  });

  it("normalizes a hex Fast payer into a canonical bech32 address", async () => {
    const testWallet = await createTestWallet();
    expect(normalizeFastWalletAddress(`0x${testWallet.publicKey}`)).toBe(testWallet.address);
  });

  it("verifies a wallet challenge signature", async () => {
    const testWallet = await createTestWallet();
    const challenge = createChallenge({
      wallet: testWallet.address,
      resourceType: "job",
      resourceId: "job_123"
    });
    const signed = await testWallet.wallet.sign({ message: challenge.message });

    await expect(
      verifyWalletChallenge({
        wallet: testWallet.address,
        signature: signed.signature,
        challenge
      })
    ).resolves.toBe(true);
  });

  it("builds route entries into the OpenAPI document", () => {
    const document = buildOpenApiDocument("http://localhost:3000");
    expect(document.paths["/api/mock/quick-insight"]).toBeDefined();
    expect(document.paths["/api/mock/async-report"]).toBeDefined();
    expect(document.paths["/catalog/services"]).toBeDefined();
  });

  it("builds testnet routes when the deployment targets testnet", () => {
    const routes = buildMarketplaceRoutes(
      resolveMarketplaceNetworkConfig({
        deploymentNetwork: "testnet"
      })
    );

    expect(routes[0]?.network).toBe("fast-testnet");
  });

  it("freezes payout split amounts from the quoted price", () => {
    const split = buildPayoutSplit({
      route: marketplaceRoutes[0],
      marketplaceWallet: "fast1marketplacetreasury000000000000000000000000000000000000",
      quotedPrice: "50000"
    });

    expect(split.providerBps).toBe(0);
    expect(split.marketplaceAmount).toBe("50000");
    expect(split.providerAmount).toBe("0");
  });

  it("builds service catalog summaries and prompts from the shared registry", () => {
    const service = listServiceDefinitions()[0];
    const detail = buildServiceDetail({
      service,
      analytics: {
        totalCalls: 12,
        revenueRaw: "420000",
        successRate30d: 66.666,
        volume30d: [{ date: "2026-03-18", amountRaw: "150000" }]
      },
      apiBaseUrl: "https://fastapi.8o.vc",
      webBaseUrl: "https://fast.8o.vc"
    });

    expect(buildPriceRange(marketplaceRoutes)).toBe("$0.05 fastUSDC - $0.15 fastUSDC");
    expect(detail.skillUrl).toBe("https://fast.8o.vc/skill.md");
    expect(detail.summary.endpointCount).toBe(2);
    expect(detail.summary.settlementToken).toBe("fastUSDC");
    expect(detail.useThisServicePrompt).toContain('I want to use the "Mock Research Signals" service');
    expect(detail.useThisServicePrompt).toContain("https://fastapi.8o.vc/api/mock/quick-insight");
    expect(detail.useThisServicePrompt).toContain("($0.05 fastUSDC)");
  });

  it("computes service analytics and suggestion queue state in the in-memory store", async () => {
    const store = new InMemoryMarketplaceStore();

    await store.saveSyncIdempotency({
      paymentId: "payment_sync_catalog_1",
      normalizedRequestHash: "hash_sync",
      buyerWallet: "fast1buyer00000000000000000000000000000000000000000000000000000000",
      routeId: "mock.quick-insight.v1",
      routeVersion: "v1",
      quotedPrice: "50000",
      payoutSplit: {
        currency: "fastUSDC",
        marketplaceWallet: "fast1market",
        marketplaceBps: 6000,
        marketplaceAmount: "30000",
        providerAccountId: "mock",
        providerWallet: null,
        providerBps: 4000,
        providerAmount: "20000"
      },
      paymentPayload: "payload",
      facilitatorResponse: { isValid: true },
      statusCode: 200,
      body: { ok: true }
    });

    await store.saveAsyncAcceptance({
      paymentId: "payment_async_catalog_1",
      normalizedRequestHash: "hash_async",
      buyerWallet: "fast1buyer00000000000000000000000000000000000000000000000000000000",
      route: marketplaceRoutes[1],
      quotedPrice: "150000",
      payoutSplit: {
        currency: "fastUSDC",
        marketplaceWallet: "fast1market",
        marketplaceBps: 7334,
        marketplaceAmount: "110000",
        providerAccountId: "mock",
        providerWallet: null,
        providerBps: 2666,
        providerAmount: "40000"
      },
      paymentPayload: "payload",
      facilitatorResponse: { isValid: true },
      jobToken: "job_catalog_1",
      providerJobId: "provider_catalog_1",
      requestBody: { topic: "catalog analytics" },
      responseBody: { jobToken: "job_catalog_1", status: "pending" },
      responseHeaders: {}
    });

    await store.completeJob("job_catalog_1", { report: "done" });

    const analytics = await store.getServiceAnalytics(["mock.quick-insight.v1", "mock.async-report.v1"]);
    expect(analytics.totalCalls).toBe(2);
    expect(analytics.revenueRaw).toBe("60000");
    expect(analytics.successRate30d).toBe(100);

    const created = await store.createSuggestion({
      type: "endpoint",
      serviceSlug: "mock-research-signals",
      title: "Add a historical trend endpoint",
      description: "Expose a historical trend snapshot for repeated market checks."
    });
    const updated = await store.updateSuggestion(created.id, {
      status: "reviewing",
      internalNotes: "Assign to provider after mock launch."
    });

    expect(updated?.status).toBe("reviewing");
    expect((await store.listSuggestions()).length).toBe(1);
  });
});
