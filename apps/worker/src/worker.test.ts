import { describe, expect, it } from "vitest";

import {
  InMemoryMarketplaceStore,
  PAYMENT_EXECUTION_RECOVERY_MS,
  buildMarketplaceRoutes,
  createDefaultProviderRegistry,
  resolveMarketplaceNetworkConfig,
  type ProviderRegistry
} from "@marketplace/shared";

import { runMarketplaceWorkerCycle } from "./worker.js";

function buildEscrowSplit(input: {
  paymentDestinationWallet?: string;
  providerAccountId: string;
  providerWallet: string | null;
  marketplaceAmount: string;
  providerAmount: string;
  marketplaceBps: number;
  providerBps: number;
}) {
  return {
    currency: "fastUSDC" as const,
    settlementMode: "verified_escrow" as const,
    paymentDestinationWallet:
      input.paymentDestinationWallet ?? "fast1marketplacetreasury000000000000000000000000000000000000",
    usesTreasurySettlement: true,
    marketplaceWallet: "fast1marketplacetreasury000000000000000000000000000000000000",
    marketplaceBps: input.marketplaceBps,
    marketplaceAmount: input.marketplaceAmount,
    providerAccountId: input.providerAccountId,
    providerWallet: input.providerWallet,
    providerBps: input.providerBps,
    providerAmount: input.providerAmount
  };
}

describe("marketplace worker", () => {
  it("refunds a permanently failed async job", async () => {
    const networkConfig = resolveMarketplaceNetworkConfig({
      deploymentNetwork: "testnet"
    });
    const store = new InMemoryMarketplaceStore(networkConfig);
    const registry = createDefaultProviderRegistry();
    const asyncRoute = buildMarketplaceRoutes(networkConfig).find((route) => route.routeId === "mock.async-report.v1");

    const buyerWallet = "fast1x0g58phuf0pf32e9uvp3mv6hak4z37ytpqyfzjzhfsehua9kmegqwzv0td";

    await store.saveAsyncAcceptance({
      paymentId: "worker_payment_1",
      normalizedRequestHash: "hash",
      buyerWallet,
      route: asyncRoute!,
      quotedPrice: "150000",
      payoutSplit: buildEscrowSplit({
        providerAccountId: "mock",
        providerWallet: null,
        marketplaceBps: 10000,
        marketplaceAmount: "150000",
        providerBps: 0,
        providerAmount: "0"
      }),
      paymentPayload: "payload",
      facilitatorResponse: { isValid: true },
      jobToken: "job_worker_1",
      requestId: "request_worker_1",
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
      secretsKey: "test-secrets-key",
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

  it("does not refund failed async free jobs", async () => {
    const networkConfig = resolveMarketplaceNetworkConfig({
      deploymentNetwork: "testnet"
    });
    const store = new InMemoryMarketplaceStore(networkConfig);
    const registry = createDefaultProviderRegistry();
    const asyncRoute = buildMarketplaceRoutes(networkConfig).find((route) => route.routeId === "mock.async-report.v1");

    if (!asyncRoute) {
      throw new Error("Missing async seeded route.");
    }

    const buyerWallet = "fast1x0g58phuf0pf32e9uvp3mv6hak4z37ytpqyfzjzhfsehua9kmegqwzv0td";
    let refundCalls = 0;

    await store.saveAsyncAcceptance({
      paymentId: "worker_payment_free_1",
      normalizedRequestHash: "hash-free",
      buyerWallet,
      route: {
        ...asyncRoute,
        billing: { type: "free" },
        price: "Free"
      },
      quotedPrice: "0",
      payoutSplit: buildEscrowSplit({
        providerAccountId: "mock",
        providerWallet: null,
        marketplaceBps: 10000,
        marketplaceAmount: "0",
        providerBps: 0,
        providerAmount: "0"
      }),
      paymentPayload: "payload",
      facilitatorResponse: { auth: "wallet_session" },
      jobToken: "job_worker_free_1",
      requestId: "request_worker_free_1",
      providerJobId: "provider_worker_free_1",
      requestBody: { topic: "failing free report" },
      providerState: {
        topic: "failing free report",
        shouldFail: true,
        readyAt: Date.now() - 10
      },
      responseBody: {
        jobToken: "job_worker_free_1",
        status: "pending"
      },
      responseHeaders: {}
    });

    await runMarketplaceWorkerCycle({
      store,
      providers: registry,
      secretsKey: "test-secrets-key",
      refundService: {
        async issueRefund() {
          refundCalls += 1;
          return { txHash: "0xrefund" };
        }
      }
    });

    const job = await store.getJob("job_worker_free_1");
    const refund = await store.getRefundByJobToken("job_worker_free_1");

    expect(job?.status).toBe("failed");
    expect(job?.refundStatus).toBe("not_required");
    expect(refund).toBeNull();
    expect(refundCalls).toBe(0);
  });

  it("expires linked async prepaid reservations on timeout without a treasury refund", async () => {
    const networkConfig = resolveMarketplaceNetworkConfig({
      deploymentNetwork: "testnet"
    });
    const store = new InMemoryMarketplaceStore(networkConfig);
    const asyncRoute = buildMarketplaceRoutes(networkConfig).find((route) => route.routeId === "mock.async-report.v1");

    if (!asyncRoute) {
      throw new Error("Missing async seeded route.");
    }

    const serviceId = "service_prepaid_async_1";
    const buyerWallet = "fast1buyerprepaid000000000000000000000000000000000000000000000000";
    let refundCalls = 0;

    await store.createCreditTopup({
      serviceId,
      buyerWallet,
      currency: "fastUSDC",
      amount: "500000",
      paymentId: "topup_payment_1"
    });

    await store.reserveCredit({
      serviceId,
      buyerWallet,
      currency: "fastUSDC",
      amount: "125000",
      idempotencyKey: "reserve_request_1",
      jobToken: "job_worker_prepaid_1",
      providerReference: "order-123",
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    });

    await store.saveAsyncAcceptance({
      paymentId: "worker_payment_prepaid_1",
      normalizedRequestHash: "hash-prepaid",
      buyerWallet,
      route: {
        ...asyncRoute,
        billing: { type: "prepaid_credit" },
        price: "Prepaid credit"
      },
      quotedPrice: "0",
      payoutSplit: buildEscrowSplit({
        providerAccountId: "mock",
        providerWallet: null,
        marketplaceBps: 10000,
        marketplaceAmount: "0",
        providerBps: 0,
        providerAmount: "0"
      }),
      paymentPayload: "payload",
      facilitatorResponse: { auth: "wallet_session" },
      jobToken: "job_worker_prepaid_1",
      serviceId,
      requestId: "request_worker_prepaid_1",
      providerJobId: "provider_worker_prepaid_1",
      requestBody: { topic: "prepaid report" },
      providerState: {
        topic: "prepaid report",
        readyAt: Date.now() + 60_000
      },
      timeoutAt: new Date(Date.now() - 1_000).toISOString(),
      responseBody: {
        jobToken: "job_worker_prepaid_1",
        status: "pending"
      },
      responseHeaders: {}
    });

    await runMarketplaceWorkerCycle({
      store,
      secretsKey: "test-secrets-key",
      refundService: {
        async issueRefund() {
          refundCalls += 1;
          return { txHash: "0xrefund" };
        }
      }
    });

    const account = await store.getCreditAccount(serviceId, buyerWallet, "fastUSDC");
    const reservation = await store.getCreditReservationByJobToken(serviceId, "job_worker_prepaid_1");
    const job = await store.getJob("job_worker_prepaid_1");
    const refund = await store.getRefundByJobToken("job_worker_prepaid_1");

    expect(job?.status).toBe("failed");
    expect(job?.refundStatus).toBe("not_required");
    expect(refund).toBeNull();
    expect(refundCalls).toBe(0);
    expect(account?.availableAmount).toBe("500000");
    expect(account?.reservedAmount).toBe("0");
    expect(reservation?.status).toBe("expired");
  });

  it("creates and settles grouped provider payouts for completed async jobs", async () => {
    const networkConfig = resolveMarketplaceNetworkConfig({
      deploymentNetwork: "testnet"
    });
    const store = new InMemoryMarketplaceStore(networkConfig);
    const registry = createDefaultProviderRegistry();
    const asyncRoute = buildMarketplaceRoutes(networkConfig).find((route) => route.routeId === "mock.async-report.v1");

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
      payoutSplit: buildEscrowSplit({
        providerAccountId: "provider_1",
        providerWallet,
        marketplaceBps: 0,
        marketplaceAmount: "0",
        providerBps: 10_000,
        providerAmount: "200000"
      }),
      paymentPayload: "payload",
      facilitatorResponse: { isValid: true },
      jobToken: "job_worker_2",
      requestId: "request_worker_2",
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
      secretsKey: "test-secrets-key",
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
      payoutSplit: buildEscrowSplit({
        providerAccountId: "provider_1",
        providerWallet,
        marketplaceBps: 0,
        marketplaceAmount: "0",
        providerBps: 10_000,
        providerAmount: "200000"
      }),
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
      payoutSplit: buildEscrowSplit({
        providerAccountId: "provider_1",
        providerWallet,
        marketplaceBps: 0,
        marketplaceAmount: "0",
        providerBps: 10_000,
        providerAmount: "300000"
      }),
      paymentPayload: "payload-2",
      facilitatorResponse: { isValid: true },
      statusCode: 200,
      body: { ok: true },
      providerPayoutSourceKind: "credit_topup"
    });

    const payouts: Array<{ wallet: string; amount: string }> = [];

    await runMarketplaceWorkerCycle({
      store,
      secretsKey: "test-secrets-key",
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

  it("refunds stale pending payments using the stored recovery action", async () => {
    const store = new InMemoryMarketplaceStore();
    const buyerWallet = "fast1buyer00000000000000000000000000000000000000000000000000000000";

    await store.claimPaymentExecution({
      paymentId: "stale_payment_refund_1",
      normalizedRequestHash: "refund-hash-1",
      buyerWallet,
      routeId: "mock.quick-insight.v1",
      routeVersion: "v1",
      pendingRecoveryAction: "refund",
      quotedPrice: "125000",
      payoutSplit: buildEscrowSplit({
        providerAccountId: "mock",
        providerWallet: null,
        marketplaceBps: 10_000,
        marketplaceAmount: "125000",
        providerBps: 0,
        providerAmount: "0"
      }),
      paymentPayload: "payload-refund-1",
      facilitatorResponse: { isValid: true },
      responseKind: "sync",
      requestId: "request-refund-1",
      responseHeaders: {}
    });

    const idempotencyByPaymentId = (store as unknown as {
      idempotencyByPaymentId: Map<string, {
        updatedAt: string;
      }>;
    }).idempotencyByPaymentId;
    const pending = idempotencyByPaymentId.get("stale_payment_refund_1");
    if (!pending) {
      throw new Error("Missing pending payment record.");
    }

    idempotencyByPaymentId.set("stale_payment_refund_1", {
      ...pending,
      updatedAt: new Date(Date.now() - PAYMENT_EXECUTION_RECOVERY_MS - 1_000).toISOString()
    });

    const refunds: Array<{ wallet: string; amount: string }> = [];

    await runMarketplaceWorkerCycle({
      store,
      secretsKey: "test-secrets-key",
      refundService: {
        async issueRefund({ wallet, amount }) {
          refunds.push({ wallet, amount });
          return { txHash: "0xstale-refund" };
        }
      }
    });

    expect(refunds).toEqual([{ wallet: buyerWallet, amount: "125000" }]);
    expect((await store.getRefundByPaymentId("stale_payment_refund_1"))?.txHash).toBe("0xstale-refund");
  });

  it("processes due poll jobs even when older webhook and deferred jobs are pending", async () => {
    const networkConfig = resolveMarketplaceNetworkConfig({
      deploymentNetwork: "testnet"
    });
    const store = new InMemoryMarketplaceStore(networkConfig);
    const registry = createDefaultProviderRegistry();
    const asyncRoute = buildMarketplaceRoutes(networkConfig).find((route) => route.routeId === "mock.async-report.v1");

    if (!asyncRoute) {
      throw new Error("Missing async seeded route.");
    }

    await store.saveAsyncAcceptance({
      paymentId: "worker_payment_webhook_1",
      normalizedRequestHash: "hash-webhook",
      buyerWallet: "fast1buyerwebhook0000000000000000000000000000000000000000000000",
      route: {
        ...asyncRoute,
        asyncConfig: {
          strategy: "webhook",
          timeoutMs: 60_000,
          pollPath: null
        }
      },
      quotedPrice: "0",
      payoutSplit: buildEscrowSplit({
        providerAccountId: "mock",
        providerWallet: null,
        marketplaceBps: 10000,
        marketplaceAmount: "0",
        providerBps: 0,
        providerAmount: "0"
      }),
      paymentPayload: "payload-webhook",
      facilitatorResponse: { auth: "wallet_session" },
      jobToken: "job_worker_webhook_1",
      requestId: "request_worker_webhook_1",
      providerJobId: "provider_worker_webhook_1",
      requestBody: { topic: "webhook report" },
      providerState: {
        topic: "webhook report",
        readyAt: Date.now() + 60_000
      },
      nextPollAt: new Date(Date.now() - 5_000).toISOString(),
      timeoutAt: new Date(Date.now() + 60_000).toISOString(),
      responseBody: {
        jobToken: "job_worker_webhook_1",
        status: "pending"
      },
      responseHeaders: {}
    });

    await store.saveAsyncAcceptance({
      paymentId: "worker_payment_deferred_1",
      normalizedRequestHash: "hash-deferred",
      buyerWallet: "fast1buyerdeferred00000000000000000000000000000000000000000000",
      route: asyncRoute,
      quotedPrice: "0",
      payoutSplit: buildEscrowSplit({
        providerAccountId: "mock",
        providerWallet: null,
        marketplaceBps: 10000,
        marketplaceAmount: "0",
        providerBps: 0,
        providerAmount: "0"
      }),
      paymentPayload: "payload-deferred",
      facilitatorResponse: { auth: "wallet_session" },
      jobToken: "job_worker_deferred_1",
      requestId: "request_worker_deferred_1",
      providerJobId: "provider_worker_deferred_1",
      requestBody: { topic: "deferred report" },
      providerState: {
        topic: "deferred report",
        readyAt: Date.now() + 60_000
      },
      nextPollAt: new Date(Date.now() + 60_000).toISOString(),
      timeoutAt: new Date(Date.now() + 120_000).toISOString(),
      responseBody: {
        jobToken: "job_worker_deferred_1",
        status: "pending"
      },
      responseHeaders: {}
    });

    await store.saveAsyncAcceptance({
      paymentId: "worker_payment_due_1",
      normalizedRequestHash: "hash-due",
      buyerWallet: "fast1buyerdue000000000000000000000000000000000000000000000000",
      route: asyncRoute,
      quotedPrice: "0",
      payoutSplit: buildEscrowSplit({
        providerAccountId: "mock",
        providerWallet: null,
        marketplaceBps: 10000,
        marketplaceAmount: "0",
        providerBps: 0,
        providerAmount: "0"
      }),
      paymentPayload: "payload-due",
      facilitatorResponse: { auth: "wallet_session" },
      jobToken: "job_worker_due_1",
      requestId: "request_worker_due_1",
      providerJobId: "provider_worker_due_1",
      requestBody: { topic: "due report" },
      providerState: {
        topic: "due report",
        readyAt: Date.now() - 10
      },
      nextPollAt: new Date(Date.now() - 5_000).toISOString(),
      timeoutAt: new Date(Date.now() + 60_000).toISOString(),
      responseBody: {
        jobToken: "job_worker_due_1",
        status: "pending"
      },
      responseHeaders: {}
    });

    await runMarketplaceWorkerCycle({
      store,
      providers: registry,
      secretsKey: "test-secrets-key",
      limit: 1,
      refundService: {
        async issueRefund() {
          return { txHash: "0xrefund" };
        }
      }
    });

    expect((await store.getJob("job_worker_webhook_1"))?.status).toBe("pending");
    expect((await store.getJob("job_worker_deferred_1"))?.status).toBe("pending");
    expect((await store.getJob("job_worker_due_1"))?.status).toBe("completed");
  });

  it("continues processing later jobs when a provider poll throws", async () => {
    const networkConfig = resolveMarketplaceNetworkConfig({
      deploymentNetwork: "testnet"
    });
    const store = new InMemoryMarketplaceStore(networkConfig);
    const asyncRoute = buildMarketplaceRoutes(networkConfig).find((route) => route.routeId === "mock.async-report.v1");

    if (!asyncRoute) {
      throw new Error("Missing async seeded route.");
    }

    const registry = {
      mock: {
        async execute() {
          throw new Error("execute should not be called in worker tests");
        },
        async poll({ job }) {
          if (job.jobToken === "job_worker_throw_1") {
            throw new Error("Malformed provider poll response.");
          }

          return {
            status: "completed" as const,
            body: {
              provider: "mock",
              operation: "async-report",
              topic: "completed report"
            }
          };
        }
      }
    } satisfies ProviderRegistry;

    await store.saveAsyncAcceptance({
      paymentId: "worker_payment_throw_1",
      normalizedRequestHash: "hash-throw-1",
      buyerWallet: "fast1buyerthrow10000000000000000000000000000000000000000000000",
      route: {
        ...asyncRoute,
        billing: { type: "free" },
        price: "Free"
      },
      quotedPrice: "0",
      payoutSplit: buildEscrowSplit({
        providerAccountId: "mock",
        providerWallet: null,
        marketplaceBps: 10000,
        marketplaceAmount: "0",
        providerBps: 0,
        providerAmount: "0"
      }),
      paymentPayload: "payload-throw-1",
      facilitatorResponse: { auth: "wallet_session" },
      jobToken: "job_worker_throw_1",
      requestId: "request_worker_throw_1",
      providerJobId: "provider_worker_throw_1",
      requestBody: { topic: "throwing report" },
      providerState: {
        topic: "throwing report",
        readyAt: Date.now() - 10
      },
      nextPollAt: new Date(Date.now() - 1_000).toISOString(),
      timeoutAt: new Date(Date.now() + 60_000).toISOString(),
      responseBody: {
        jobToken: "job_worker_throw_1",
        status: "pending"
      },
      responseHeaders: {}
    });

    await store.saveAsyncAcceptance({
      paymentId: "worker_payment_throw_2",
      normalizedRequestHash: "hash-throw-2",
      buyerWallet: "fast1buyerthrow20000000000000000000000000000000000000000000000",
      route: {
        ...asyncRoute,
        billing: { type: "free" },
        price: "Free"
      },
      quotedPrice: "0",
      payoutSplit: buildEscrowSplit({
        providerAccountId: "mock",
        providerWallet: null,
        marketplaceBps: 10000,
        marketplaceAmount: "0",
        providerBps: 0,
        providerAmount: "0"
      }),
      paymentPayload: "payload-throw-2",
      facilitatorResponse: { auth: "wallet_session" },
      jobToken: "job_worker_throw_2",
      requestId: "request_worker_throw_2",
      providerJobId: "provider_worker_throw_2",
      requestBody: { topic: "completed report" },
      providerState: {
        topic: "completed report",
        readyAt: Date.now() - 10
      },
      nextPollAt: new Date(Date.now() - 1_000).toISOString(),
      timeoutAt: new Date(Date.now() + 60_000).toISOString(),
      responseBody: {
        jobToken: "job_worker_throw_2",
        status: "pending"
      },
      responseHeaders: {}
    });

    await runMarketplaceWorkerCycle({
      store,
      providers: registry,
      secretsKey: "test-secrets-key",
      refundService: {
        async issueRefund() {
          return { txHash: "0xrefund" };
        }
      }
    });

    expect((await store.getJob("job_worker_throw_1"))?.status).toBe("failed");
    expect((await store.getJob("job_worker_throw_1"))?.errorMessage).toBe("Malformed provider poll response.");
    expect((await store.getJob("job_worker_throw_2"))?.status).toBe("completed");
  });
});
