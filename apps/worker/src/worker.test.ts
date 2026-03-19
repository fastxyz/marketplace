import { describe, expect, it } from "vitest";

import { InMemoryMarketplaceStore, createDefaultProviderRegistry, marketplaceRoutes } from "@marketplace/shared";

import { runMarketplaceWorkerCycle } from "./worker.js";

describe("marketplace worker", () => {
  it("refunds a permanently failed async job", async () => {
    const store = new InMemoryMarketplaceStore();
    const registry = createDefaultProviderRegistry();
    const asyncRoute = marketplaceRoutes.find((route) => route.routeId === "mock.async-report.v1");

    const buyerWallet = "fast1x0g58phuf0pf32e9uvp3mv6hak4z37ytpqyfzjzhfsehua9kmegqwzv0td";

    await store.saveAsyncAcceptance({
      paymentId: "worker_payment_1",
      normalizedRequestHash: "hash",
      buyerWallet,
      route: asyncRoute!,
      quotedPrice: "150000",
      payoutSplit: {
        currency: "fastUSDC",
        marketplaceWallet: "fast1marketplacetreasury000000000000000000000000000000000000",
        marketplaceBps: 10000,
        marketplaceAmount: "150000",
        providerAccountId: "mock",
        providerWallet: null,
        providerBps: 0,
        providerAmount: "0"
      },
      paymentPayload: "payload",
      facilitatorResponse: { isValid: true },
      jobToken: "job_worker_1",
      providerJobId: "provider_worker_1",
      requestBody: { topic: "failing report" },
      providerState: {
        topic: "failing report",
        shouldFail: true,
        readyAt: Date.now() - 10
      },
      responseBody: {
        jobToken: "job_worker_1",
        status: "pending"
      },
      responseHeaders: {}
    });

    await runMarketplaceWorkerCycle({
      store,
      providers: registry,
      refundService: {
        async issueRefund() {
          return { txHash: "0xrefund" };
        }
      }
    });

    const job = await store.getJob("job_worker_1");
    const refund = await store.getRefundByJobToken("job_worker_1");

    expect(job?.status).toBe("failed");
    expect(job?.refundStatus).toBe("sent");
    expect(refund?.txHash).toBe("0xrefund");
  });

  it("creates and settles grouped provider payouts for completed async jobs", async () => {
    const store = new InMemoryMarketplaceStore();
    const registry = createDefaultProviderRegistry();
    const asyncRoute = marketplaceRoutes.find((route) => route.routeId === "mock.async-report.v1");

    if (!asyncRoute) {
      throw new Error("Missing async seeded route.");
    }

    const providerWallet = "fast1provider000000000000000000000000000000000000000000000000000000";

    await store.saveAsyncAcceptance({
      paymentId: "worker_payment_2",
      normalizedRequestHash: "hash-2",
      buyerWallet: "fast1buyer00000000000000000000000000000000000000000000000000000000",
      route: {
        ...asyncRoute,
        payout: {
          providerAccountId: "provider_1",
          providerWallet,
          providerBps: 10_000
        }
      },
      quotedPrice: "200000",
      payoutSplit: {
        currency: "fastUSDC",
        marketplaceWallet: "fast1marketplacetreasury000000000000000000000000000000000000",
        marketplaceBps: 0,
        marketplaceAmount: "0",
        providerAccountId: "provider_1",
        providerWallet,
        providerBps: 10_000,
        providerAmount: "200000"
      },
      paymentPayload: "payload",
      facilitatorResponse: { isValid: true },
      jobToken: "job_worker_2",
      providerJobId: "provider_worker_2",
      requestBody: { topic: "completed report" },
      providerState: {
        topic: "completed report",
        readyAt: Date.now() - 10
      },
      responseBody: {
        jobToken: "job_worker_2",
        status: "pending"
      },
      responseHeaders: {}
    });

    await store.createProviderPayout({
      sourceKind: "route_charge",
      sourceId: "sync_payment_1",
      providerAccountId: "provider_1",
      providerWallet,
      currency: "fastUSDC",
      amount: "300000"
    });

    const payouts: Array<{ wallet: string; amount: string }> = [];

    await runMarketplaceWorkerCycle({
      store,
      providers: registry,
      refundService: {
        async issueRefund() {
          return { txHash: "0xrefund" };
        }
      },
      payoutService: {
        async issuePayout({ wallet, amount }) {
          payouts.push({ wallet, amount });
          return { txHash: "0xpayout" };
        }
      }
    });

    const job = await store.getJob("job_worker_2");
    const pendingPayouts = await store.listPendingProviderPayouts(10);

    expect(job?.status).toBe("completed");
    expect(payouts).toEqual([{ wallet: providerWallet, amount: "500000" }]);
    expect(pendingPayouts).toHaveLength(0);
  });

  it("backfills and settles missing sync provider payouts", async () => {
    const store = new InMemoryMarketplaceStore();
    const providerWallet = "fast1provider000000000000000000000000000000000000000000000000000000";

    await store.saveSyncIdempotency({
      paymentId: "sync_payment_missing_1",
      normalizedRequestHash: "sync-hash-1",
      buyerWallet: "fast1buyer00000000000000000000000000000000000000000000000000000000",
      routeId: "orders.quote.v1",
      routeVersion: "v1",
      quotedPrice: "200000",
      payoutSplit: {
        currency: "fastUSDC",
        marketplaceWallet: "fast1marketplacetreasury000000000000000000000000000000000000",
        marketplaceBps: 0,
        marketplaceAmount: "0",
        providerAccountId: "provider_1",
        providerWallet,
        providerBps: 10_000,
        providerAmount: "200000"
      },
      paymentPayload: "payload-1",
      facilitatorResponse: { isValid: true },
      statusCode: 200,
      body: { ok: true },
      providerPayoutSourceKind: "route_charge"
    });

    await store.saveSyncIdempotency({
      paymentId: "sync_payment_missing_2",
      normalizedRequestHash: "sync-hash-2",
      buyerWallet: "fast1buyer00000000000000000000000000000000000000000000000000000000",
      routeId: "orders.topup.v1",
      routeVersion: "v1",
      quotedPrice: "300000",
      payoutSplit: {
        currency: "fastUSDC",
        marketplaceWallet: "fast1marketplacetreasury000000000000000000000000000000000000",
        marketplaceBps: 0,
        marketplaceAmount: "0",
        providerAccountId: "provider_1",
        providerWallet,
        providerBps: 10_000,
        providerAmount: "300000"
      },
      paymentPayload: "payload-2",
      facilitatorResponse: { isValid: true },
      statusCode: 200,
      body: { ok: true },
      providerPayoutSourceKind: "credit_topup"
    });

    const payouts: Array<{ wallet: string; amount: string }> = [];

    await runMarketplaceWorkerCycle({
      store,
      refundService: {
        async issueRefund() {
          return { txHash: "0xrefund" };
        }
      },
      payoutService: {
        async issuePayout({ wallet, amount }) {
          payouts.push({ wallet, amount });
          return { txHash: "0xpayout" };
        }
      }
    });

    expect(payouts).toEqual([{ wallet: providerWallet, amount: "500000" }]);
    expect(await store.listPendingProviderPayouts(10)).toHaveLength(0);
  });
});
