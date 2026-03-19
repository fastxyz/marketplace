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
});
