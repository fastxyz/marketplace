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

  it("finalizes already-refunded stale payments so they do not starve later recovery work", async () => {
    const store = new InMemoryMarketplaceStore();
    const buyerWallet = "fast1buyerstalequeue000000000000000000000000000000000000000000000000";

    await store.claimPaymentExecution({
      paymentId: "stale_payment_already_refunded_1",
      normalizedRequestHash: "stale-queue-hash-1",
      buyerWallet,
      routeId: "mock.quick-insight.v1",
      routeVersion: "v1",
      pendingRecoveryAction: "refund",
      quotedPrice: "125000",
      payoutSplit: buildEscrowSplit({
        providerAccountId: "mock",
        providerWallet: null,
        marketplaceBps: 10000,
        marketplaceAmount: "125000",
        providerBps: 0,
        providerAmount: "0"
      }),
      paymentPayload: "payload-stale-queue-1",
      facilitatorResponse: { isValid: true },
      responseKind: "sync",
      requestId: "request-stale-queue-1",
      responseHeaders: {}
    });

    const existingRefund = await store.createRefund({
      paymentId: "stale_payment_already_refunded_1",
      wallet: buyerWallet,
      amount: "125000"
    });
    await store.markRefundSent(existingRefund.id, "0xexisting-refund");

    await store.claimPaymentExecution({
      paymentId: "stale_payment_waiting_behind_refund_1",
      normalizedRequestHash: "stale-queue-hash-2",
      buyerWallet,
      routeId: "mock.quick-insight.v1",
      routeVersion: "v1",
      pendingRecoveryAction: "refund",
      quotedPrice: "125000",
      payoutSplit: buildEscrowSplit({
        providerAccountId: "mock",
        providerWallet: null,
        marketplaceBps: 10000,
        marketplaceAmount: "125000",
        providerBps: 0,
        providerAmount: "0"
      }),
      paymentPayload: "payload-stale-queue-2",
      facilitatorResponse: { isValid: true },
      responseKind: "sync",
      requestId: "request-stale-queue-2",
      responseHeaders: {}
    });

    const idempotencyByPaymentId = (store as unknown as {
      idempotencyByPaymentId: Map<string, {
        updatedAt: string;
      }>;
    }).idempotencyByPaymentId;

    for (const [paymentId, offsetMs] of [
      ["stale_payment_already_refunded_1", 2_000],
      ["stale_payment_waiting_behind_refund_1", 1_000]
    ] as const) {
      const pending = idempotencyByPaymentId.get(paymentId);
      if (!pending) {
        throw new Error(`Missing stale payment record: ${paymentId}`);
      }

      idempotencyByPaymentId.set(paymentId, {
        ...pending,
        updatedAt: new Date(Date.now() - PAYMENT_EXECUTION_RECOVERY_MS - offsetMs).toISOString()
      });
    }

    const refunds: Array<{ wallet: string; amount: string }> = [];

    await runMarketplaceWorkerCycle({
      store,
      secretsKey: "test-secrets-key",
      limit: 1,
      refundService: {
        async issueRefund({ wallet, amount }) {
          refunds.push({ wallet, amount });
          return { txHash: "0xnew-refund" };
        }
      }
    });

    expect((await store.getIdempotencyByPaymentId("stale_payment_already_refunded_1"))?.executionStatus).toBe("completed");
    expect(refunds).toEqual([]);

    await runMarketplaceWorkerCycle({
      store,
      secretsKey: "test-secrets-key",
      limit: 1,
      refundService: {
        async issueRefund({ wallet, amount }) {
          refunds.push({ wallet, amount });
          return { txHash: "0xnew-refund" };
        }
      }
    });

    expect((await store.getRefundByPaymentId("stale_payment_waiting_behind_refund_1"))?.txHash).toBe("0xnew-refund");
    expect(refunds).toEqual([{ wallet: buyerWallet, amount: "125000" }]);
  });

  it("recovers stale accepted async poll payments from placeholder jobs without issuing a refund", async () => {
    const networkConfig = resolveMarketplaceNetworkConfig({
      deploymentNetwork: "testnet"
    });
    const store = new InMemoryMarketplaceStore(networkConfig);
    const asyncRoute = buildMarketplaceRoutes(networkConfig).find((route) => route.routeId === "mock.async-report.v1");

    if (!asyncRoute) {
      throw new Error("Missing async seeded route.");
    }

    const buyerWallet = "fast1buyerrecover000000000000000000000000000000000000000000000";

    await store.claimPaymentExecution({
      paymentId: "stale_payment_async_recovery_1",
      normalizedRequestHash: "stale-async-hash-1",
      buyerWallet,
      routeId: asyncRoute.routeId,
      routeVersion: asyncRoute.version,
      pendingRecoveryAction: "refund",
      quotedPrice: "150000",
      payoutSplit: buildEscrowSplit({
        providerAccountId: "mock",
        providerWallet: null,
        marketplaceBps: 10000,
        marketplaceAmount: "150000",
        providerBps: 0,
        providerAmount: "0"
      }),
      paymentPayload: "payload-stale-async-1",
      facilitatorResponse: { isValid: true },
      responseKind: "job",
      requestId: "request-stale-async-1",
      jobToken: "job_stale_async_recovery_1",
      responseBody: { status: "processing" },
      responseHeaders: {}
    });

    await store.savePendingAsyncJob({
      jobToken: "job_stale_async_recovery_1",
      paymentId: "stale_payment_async_recovery_1",
      buyerWallet,
      route: {
        ...asyncRoute,
        executorKind: "http",
        asyncConfig: {
          strategy: "poll",
          timeoutMs: 60_000,
          pollPath: "/api/poll"
        }
      },
      quotedPrice: "150000",
      payoutSplit: buildEscrowSplit({
        providerAccountId: "mock",
        providerWallet: null,
        marketplaceBps: 10000,
        marketplaceAmount: "150000",
        providerBps: 0,
        providerAmount: "0"
      }),
      serviceId: "service_stale_async_recovery_1",
      requestId: "request-stale-async-1",
      requestBody: { topic: "recovery" },
      nextPollAt: null,
      timeoutAt: null
    });

    await store.recordProviderAttempt({
      jobToken: "job_stale_async_recovery_1",
      routeId: asyncRoute.routeId,
      requestId: "request-stale-async-1",
      phase: "execute",
      status: "succeeded",
      requestPayload: { topic: "recovery" },
      responsePayload: {
        kind: "async",
        providerJobId: "provider_stale_async_recovery_1",
        pollAfterMs: 5_000,
        providerState: {
          topic: "recovery",
          readyAt: Date.now() + 60_000
        }
      }
    });

    const idempotencyByPaymentId = (store as unknown as {
      idempotencyByPaymentId: Map<string, {
        updatedAt: string;
      }>;
    }).idempotencyByPaymentId;
    const pending = idempotencyByPaymentId.get("stale_payment_async_recovery_1");
    if (!pending) {
      throw new Error("Missing pending async payment record.");
    }

    idempotencyByPaymentId.set("stale_payment_async_recovery_1", {
      ...pending,
      updatedAt: new Date(Date.now() - PAYMENT_EXECUTION_RECOVERY_MS - 1_000).toISOString()
    });

    let refundCalls = 0;

    await runMarketplaceWorkerCycle({
      store,
      secretsKey: "test-secrets-key",
      refundService: {
        async issueRefund() {
          refundCalls += 1;
          return { txHash: "0xunexpected-refund" };
        }
      }
    });

    const payment = await store.getIdempotencyByPaymentId("stale_payment_async_recovery_1");
    const refund = await store.getRefundByPaymentId("stale_payment_async_recovery_1");
    const job = await store.getJob("job_stale_async_recovery_1");

    expect(refundCalls).toBe(0);
    expect(refund).toBeNull();
    expect(job?.providerJobId).toBe("provider_stale_async_recovery_1");
    expect(job?.providerState).toEqual({
      topic: "recovery",
      readyAt: expect.any(Number)
    });
    expect(payment?.executionStatus).toBe("completed");
    expect(payment?.responseKind).toBe("job");
    expect(payment?.jobToken).toBe("job_stale_async_recovery_1");
    expect(payment?.responseBody).toEqual(expect.objectContaining({
      jobToken: "job_stale_async_recovery_1",
      status: "pending"
    }));
  });

  it("refunds stale pre-accept async failures instead of replaying them as accepted jobs", async () => {
    const networkConfig = resolveMarketplaceNetworkConfig({
      deploymentNetwork: "testnet"
    });
    const store = new InMemoryMarketplaceStore(networkConfig);
    const asyncRoute = buildMarketplaceRoutes(networkConfig).find((route) => route.routeId === "mock.async-report.v1");

    if (!asyncRoute) {
      throw new Error("Missing async seeded route.");
    }

    const buyerWallet = "fast1buyerpreacceptfailure000000000000000000000000000000000000000";
    const paymentId = "stale_payment_preaccept_failure_1";
    const jobToken = "job_stale_preaccept_failure_1";

    await store.claimPaymentExecution({
      paymentId,
      normalizedRequestHash: "stale-preaccept-failure-hash-1",
      buyerWallet,
      routeId: asyncRoute.routeId,
      routeVersion: asyncRoute.version,
      pendingRecoveryAction: "refund",
      quotedPrice: "150000",
      payoutSplit: buildEscrowSplit({
        providerAccountId: "mock",
        providerWallet: "fast1providerrefund000000000000000000000000000000000000000000",
        marketplaceBps: 5000,
        marketplaceAmount: "75000",
        providerBps: 5000,
        providerAmount: "75000"
      }),
      paymentPayload: "payload-preaccept-failure-1",
      facilitatorResponse: { isValid: true },
      responseKind: "job",
      requestId: "request-preaccept-failure-1",
      jobToken,
      responseBody: { status: "processing" },
      responseHeaders: {}
    });

    await store.savePendingAsyncJob({
      jobToken,
      paymentId,
      buyerWallet,
      route: {
        ...asyncRoute,
        executorKind: "http",
        asyncConfig: {
          strategy: "poll",
          timeoutMs: 60_000,
          pollPath: "/api/poll"
        }
      },
      quotedPrice: "150000",
      payoutSplit: buildEscrowSplit({
        providerAccountId: "mock",
        providerWallet: "fast1providerrefund000000000000000000000000000000000000000000",
        marketplaceBps: 5000,
        marketplaceAmount: "75000",
        providerBps: 5000,
        providerAmount: "75000"
      }),
      serviceId: "service_preaccept_failure_1",
      requestId: "request-preaccept-failure-1",
      requestBody: { topic: "pre-accept failure" },
      nextPollAt: null,
      timeoutAt: null
    });

    await store.failJob(jobToken, "Async route failed before acceptance.");
    await store.recordProviderAttempt({
      jobToken,
      routeId: asyncRoute.routeId,
      requestId: "request-preaccept-failure-1",
      responseStatusCode: 502,
      phase: "execute",
      status: "failed",
      requestPayload: { topic: "pre-accept failure" },
      responsePayload: {
        error: "upstream rejected",
        details: "provider rejected request"
      },
      errorMessage: "Async route failed with status 502 before acceptance."
    });

    const idempotencyByPaymentId = (store as unknown as {
      idempotencyByPaymentId: Map<string, {
        updatedAt: string;
      }>;
    }).idempotencyByPaymentId;
    const pending = idempotencyByPaymentId.get(paymentId);
    if (!pending) {
      throw new Error("Missing pending pre-accept payment record.");
    }

    idempotencyByPaymentId.set(paymentId, {
      ...pending,
      updatedAt: new Date(Date.now() - PAYMENT_EXECUTION_RECOVERY_MS - 1_000).toISOString()
    });

    let refundCalls = 0;

    await runMarketplaceWorkerCycle({
      store,
      secretsKey: "test-secrets-key",
      refundService: {
        async issueRefund() {
          refundCalls += 1;
          return { txHash: "0xpreaccept-refund" };
        }
      }
    });

    const payment = await store.getIdempotencyByPaymentId(paymentId);
    const refund = await store.getRefundByJobToken(jobToken);
    const job = await store.getJob(jobToken);

    expect(refundCalls).toBe(1);
    expect(payment?.executionStatus).toBe("completed");
    expect(payment?.responseKind).toBe("sync");
    expect(payment?.responseStatusCode).toBe(502);
    expect(payment?.responseBody).toEqual({
      error: "Upstream request failed. Payment was refunded.",
      upstreamStatus: 502,
      upstreamBody: {
        error: "upstream rejected",
        details: "provider rejected request"
      },
      refund: {
        status: "sent",
        txHash: "0xpreaccept-refund"
      }
    });
    expect(refund?.status).toBe("sent");
    expect(job?.status).toBe("failed");
    expect(job?.providerJobId).toBeNull();

    await runMarketplaceWorkerCycle({
      store,
      secretsKey: "test-secrets-key",
      refundService: {
        async issueRefund() {
          refundCalls += 1;
          return { txHash: "0xunexpected-second-refund" };
        }
      }
    });

    expect(refundCalls).toBe(1);
    expect((await store.getIdempotencyByPaymentId(paymentId))?.executionStatus).toBe("completed");
  });

  it("does not refund a stale async payment when the job completes during refund fencing", async () => {
    class CompletionDuringFenceStore extends InMemoryMarketplaceStore {
      override async failJob(jobToken: string, error: string) {
        await super.completeJob(jobToken, { ok: true, source: "late-completion" });
        return super.failJob(jobToken, error);
      }
    }

    const networkConfig = resolveMarketplaceNetworkConfig({
      deploymentNetwork: "testnet"
    });
    const store = new CompletionDuringFenceStore(networkConfig);
    const asyncRoute = buildMarketplaceRoutes(networkConfig).find((route) => route.routeId === "mock.async-report.v1");

    if (!asyncRoute) {
      throw new Error("Missing async seeded route.");
    }

    const paymentId = "stale_payment_race_completion_1";
    const jobToken = "job_stale_race_completion_1";
    const buyerWallet = "fast1buyerracecomplete00000000000000000000000000000000000000000";

    await store.claimPaymentExecution({
      paymentId,
      normalizedRequestHash: "stale-race-completion-hash-1",
      buyerWallet,
      routeId: asyncRoute.routeId,
      routeVersion: asyncRoute.version,
      pendingRecoveryAction: "refund",
      quotedPrice: "150000",
      payoutSplit: buildEscrowSplit({
        providerAccountId: "mock",
        providerWallet: "fast1providerracecomplete000000000000000000000000000000000000",
        marketplaceBps: 5000,
        marketplaceAmount: "75000",
        providerBps: 5000,
        providerAmount: "75000"
      }),
      paymentPayload: "payload-race-completion-1",
      facilitatorResponse: { isValid: true },
      responseKind: "job",
      requestId: "request-race-completion-1",
      jobToken,
      responseBody: { status: "processing" },
      responseHeaders: {}
    });

    await store.savePendingAsyncJob({
      jobToken,
      paymentId,
      buyerWallet,
      route: {
        ...asyncRoute,
        executorKind: "http",
        asyncConfig: {
          strategy: "poll",
          timeoutMs: 60_000,
          pollPath: "/api/poll"
        }
      },
      quotedPrice: "150000",
      payoutSplit: buildEscrowSplit({
        providerAccountId: "mock",
        providerWallet: "fast1providerracecomplete000000000000000000000000000000000000",
        marketplaceBps: 5000,
        marketplaceAmount: "75000",
        providerBps: 5000,
        providerAmount: "75000"
      }),
      serviceId: "service_race_completion_1",
      requestId: "request-race-completion-1",
      requestBody: { topic: "late completion" },
      nextPollAt: null,
      timeoutAt: null
    });

    const idempotencyByPaymentId = (store as unknown as {
      idempotencyByPaymentId: Map<string, { updatedAt: string }>;
    }).idempotencyByPaymentId;
    const pending = idempotencyByPaymentId.get(paymentId);
    if (!pending) {
      throw new Error("Missing pending payment record.");
    }

    idempotencyByPaymentId.set(paymentId, {
      ...pending,
      updatedAt: new Date(Date.now() - PAYMENT_EXECUTION_RECOVERY_MS - 1_000).toISOString()
    });

    let refundCalls = 0;
    await runMarketplaceWorkerCycle({
      store,
      secretsKey: "test-secrets-key",
      refundService: {
        async issueRefund() {
          refundCalls += 1;
          return { txHash: "0xunexpected-race-refund" };
        }
      }
    });

    const payment = await store.getIdempotencyByPaymentId(paymentId);
    const refund = await store.getRefundByPaymentId(paymentId);
    const job = await store.getJob(jobToken);

    expect(refundCalls).toBe(0);
    expect(refund).toBeNull();
    expect(job?.status).toBe("completed");
    expect(payment?.executionStatus).toBe("completed");
    expect(payment?.responseKind).toBe("job");
  });

  it("attaches stale-payment refunds to async jobs and excludes refunded jobs from payout recovery", async () => {
    const networkConfig = resolveMarketplaceNetworkConfig({
      deploymentNetwork: "testnet"
    });
    const store = new InMemoryMarketplaceStore(networkConfig);
    const asyncRoute = buildMarketplaceRoutes(networkConfig).find((route) => route.routeId === "mock.async-report.v1");

    if (!asyncRoute) {
      throw new Error("Missing async seeded route.");
    }

    const buyerWallet = "fast1buyerrefundfence0000000000000000000000000000000000000000000";
    const paymentId = "stale_payment_refund_fence_1";
    const jobToken = "job_stale_refund_fence_1";

    await store.claimPaymentExecution({
      paymentId,
      normalizedRequestHash: "stale-refund-fence-hash-1",
      buyerWallet,
      routeId: asyncRoute.routeId,
      routeVersion: asyncRoute.version,
      pendingRecoveryAction: "refund",
      quotedPrice: "150000",
      payoutSplit: buildEscrowSplit({
        providerAccountId: "mock",
        providerWallet: "fast1providerfence00000000000000000000000000000000000000000000",
        marketplaceBps: 5000,
        marketplaceAmount: "75000",
        providerBps: 5000,
        providerAmount: "75000"
      }),
      paymentPayload: "payload-refund-fence-1",
      facilitatorResponse: { isValid: true },
      responseKind: "job",
      requestId: "request-refund-fence-1",
      jobToken,
      responseBody: { status: "processing" },
      responseHeaders: {}
    });

    await store.savePendingAsyncJob({
      jobToken,
      paymentId,
      buyerWallet,
      route: {
        ...asyncRoute,
        executorKind: "http",
        asyncConfig: {
          strategy: "webhook",
          timeoutMs: 60_000,
          pollPath: null
        }
      },
      quotedPrice: "150000",
      payoutSplit: buildEscrowSplit({
        providerAccountId: "mock",
        providerWallet: "fast1providerfence00000000000000000000000000000000000000000000",
        marketplaceBps: 5000,
        marketplaceAmount: "75000",
        providerBps: 5000,
        providerAmount: "75000"
      }),
      serviceId: "service_refund_fence_1",
      requestId: "request-refund-fence-1",
      requestBody: { topic: "refund fence" },
      nextPollAt: new Date(Date.now() + 60_000).toISOString(),
      timeoutAt: null
    });

    const existingRefund = await store.createRefund({
      paymentId,
      wallet: buyerWallet,
      amount: "150000"
    });
    await store.markRefundSent(existingRefund.id, "0xexisting-refund");

    const idempotencyByPaymentId = (store as unknown as {
      idempotencyByPaymentId: Map<string, {
        updatedAt: string;
      }>;
    }).idempotencyByPaymentId;
    const pending = idempotencyByPaymentId.get(paymentId);
    if (!pending) {
      throw new Error("Missing pending refund-fence payment record.");
    }

    idempotencyByPaymentId.set(paymentId, {
      ...pending,
      updatedAt: new Date(Date.now() - PAYMENT_EXECUTION_RECOVERY_MS - 1_000).toISOString()
    });

    let refundCalls = 0;

    await runMarketplaceWorkerCycle({
      store,
      secretsKey: "test-secrets-key",
      refundService: {
        async issueRefund() {
          refundCalls += 1;
          return { txHash: "0xunexpected-refund" };
        }
      }
    });

    const attachedRefund = await store.getRefundByJobToken(jobToken);
    const failedJob = await store.getJob(jobToken);

    expect(refundCalls).toBe(0);
    expect(attachedRefund?.id).toBe(existingRefund.id);
    expect(attachedRefund?.status).toBe("sent");
    expect(failedJob?.status).toBe("failed");
    expect(failedJob?.refundStatus).toBe("sent");

    await store.completeJob(jobToken, { late: true });

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

    expect(payouts).toEqual([]);
  });

  it("refunds stale webhook placeholders when the provider never accepted the job", async () => {
    const networkConfig = resolveMarketplaceNetworkConfig({
      deploymentNetwork: "testnet"
    });
    const store = new InMemoryMarketplaceStore(networkConfig);
    const asyncRoute = buildMarketplaceRoutes(networkConfig).find((route) => route.routeId === "mock.async-report.v1");

    if (!asyncRoute) {
      throw new Error("Missing async seeded route.");
    }

    const buyerWallet = "fast1buyerwebhookstale000000000000000000000000000000000000000000";

    await store.claimPaymentExecution({
      paymentId: "stale_payment_webhook_placeholder_1",
      normalizedRequestHash: "stale-webhook-placeholder-hash-1",
      buyerWallet,
      routeId: asyncRoute.routeId,
      routeVersion: asyncRoute.version,
      pendingRecoveryAction: "refund",
      quotedPrice: "150000",
      payoutSplit: buildEscrowSplit({
        providerAccountId: "mock",
        providerWallet: null,
        marketplaceBps: 10000,
        marketplaceAmount: "150000",
        providerBps: 0,
        providerAmount: "0"
      }),
      paymentPayload: "payload-stale-webhook-placeholder-1",
      facilitatorResponse: { isValid: true },
      responseKind: "job",
      requestId: "request-stale-webhook-placeholder-1",
      jobToken: "job_stale_webhook_placeholder_1",
      responseBody: { status: "processing" },
      responseHeaders: {}
    });

    await store.savePendingAsyncJob({
      jobToken: "job_stale_webhook_placeholder_1",
      paymentId: "stale_payment_webhook_placeholder_1",
      buyerWallet,
      route: {
        ...asyncRoute,
        executorKind: "http",
        asyncConfig: {
          strategy: "webhook",
          timeoutMs: 60_000,
          pollPath: null
        }
      },
      quotedPrice: "150000",
      payoutSplit: buildEscrowSplit({
        providerAccountId: "mock",
        providerWallet: null,
        marketplaceBps: 10000,
        marketplaceAmount: "150000",
        providerBps: 0,
        providerAmount: "0"
      }),
      serviceId: "service_stale_webhook_placeholder_1",
      requestId: "request-stale-webhook-placeholder-1",
      requestBody: { topic: "never accepted" },
      nextPollAt: new Date(Date.now() + 60_000).toISOString(),
      timeoutAt: null
    });

    const idempotencyByPaymentId = (store as unknown as {
      idempotencyByPaymentId: Map<string, {
        updatedAt: string;
      }>;
    }).idempotencyByPaymentId;
    const pending = idempotencyByPaymentId.get("stale_payment_webhook_placeholder_1");
    if (!pending) {
      throw new Error("Missing stale webhook payment record.");
    }

    idempotencyByPaymentId.set("stale_payment_webhook_placeholder_1", {
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
          return { txHash: "0xstale-webhook-refund" };
        }
      }
    });

    expect(refunds).toEqual([{ wallet: buyerWallet, amount: "150000" }]);
    expect((await store.getRefundByPaymentId("stale_payment_webhook_placeholder_1"))?.txHash).toBe("0xstale-webhook-refund");
  });

  it("times out and refunds accepted webhook placeholders whose acceptance metadata must be repaired", async () => {
    const networkConfig = resolveMarketplaceNetworkConfig({
      deploymentNetwork: "testnet"
    });
    const store = new InMemoryMarketplaceStore(networkConfig);
    const asyncRoute = buildMarketplaceRoutes(networkConfig).find((route) => route.routeId === "mock.async-report.v1");

    if (!asyncRoute) {
      throw new Error("Missing async seeded route.");
    }

    const buyerWallet = "fast1buyerwebhookrepair0000000000000000000000000000000000000000";

    await store.savePendingAsyncJob({
      jobToken: "job_webhook_accept_repair_1",
      paymentId: "payment_webhook_accept_repair_1",
      buyerWallet,
      route: {
        ...asyncRoute,
        executorKind: "http",
        asyncConfig: {
          strategy: "webhook",
          timeoutMs: 1_000,
          pollPath: null
        }
      },
      quotedPrice: "150000",
      payoutSplit: buildEscrowSplit({
        providerAccountId: "mock",
        providerWallet: null,
        marketplaceBps: 10000,
        marketplaceAmount: "150000",
        providerBps: 0,
        providerAmount: "0"
      }),
      serviceId: "service_webhook_accept_repair_1",
      requestId: "request_webhook_accept_repair_1",
      requestBody: { topic: "webhook acceptance repair" },
      nextPollAt: new Date(Date.now() - 1_000).toISOString(),
      timeoutAt: null
    });

    await store.recordProviderAttempt({
      jobToken: "job_webhook_accept_repair_1",
      routeId: asyncRoute.routeId,
      requestId: "request_webhook_accept_repair_1",
      phase: "execute",
      status: "succeeded",
      requestPayload: { topic: "webhook acceptance repair" },
      responsePayload: {
        kind: "async",
        providerJobId: "provider_webhook_accept_repair_1",
        providerState: {
          topic: "webhook acceptance repair"
        }
      }
    });

    const attempts = (store as unknown as {
      attempts: Array<{ createdAt: string }>;
    }).attempts;
    attempts[0]!.createdAt = new Date(Date.now() - 10_000).toISOString();

    const refunds: Array<{ wallet: string; amount: string }> = [];

    await runMarketplaceWorkerCycle({
      store,
      secretsKey: "test-secrets-key",
      refundService: {
        async issueRefund({ wallet, amount }) {
          refunds.push({ wallet, amount });
          return { txHash: "0xwebhook-accept-repair-refund" };
        }
      }
    });

    const job = await store.getJob("job_webhook_accept_repair_1");
    const refund = await store.getRefundByPaymentId("payment_webhook_accept_repair_1");

    expect(job?.providerJobId).toBe("provider_webhook_accept_repair_1");
    expect(job?.status).toBe("failed");
    expect(refunds).toEqual([{ wallet: buyerWallet, amount: "150000" }]);
    expect(refund?.txHash).toBe("0xwebhook-accept-repair-refund");
  });

  it("does not process pre-accept async placeholder jobs before a provider job id is stored", async () => {
    const networkConfig = resolveMarketplaceNetworkConfig({
      deploymentNetwork: "testnet"
    });
    const store = new InMemoryMarketplaceStore(networkConfig);
    const asyncRoute = buildMarketplaceRoutes(networkConfig).find((route) => route.routeId === "mock.async-report.v1");

    if (!asyncRoute) {
      throw new Error("Missing async seeded route.");
    }

    await store.savePendingAsyncJob({
      jobToken: "job_preaccept_placeholder_1",
      buyerWallet: "fast1buyerplaceholder000000000000000000000000000000000000000000",
      route: {
        ...asyncRoute,
        executorKind: "http",
        upstreamBaseUrl: "https://provider.example.com",
        upstreamPath: "/api/run",
        upstreamAuthMode: "none",
        asyncConfig: {
          strategy: "poll",
          timeoutMs: 60_000,
          pollPath: "/api/poll"
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
      serviceId: "service_preaccept_placeholder_1",
      requestId: "request_preaccept_placeholder_1",
      requestBody: { topic: "placeholder" },
      nextPollAt: new Date(Date.now() - 1_000).toISOString(),
      timeoutAt: null
    });

    let refundCalls = 0;

    await runMarketplaceWorkerCycle({
      store,
      secretsKey: "test-secrets-key",
      refundService: {
        async issueRefund() {
          refundCalls += 1;
          return { txHash: "0xunexpected-refund" };
        }
      }
    });

    const job = await store.getJob("job_preaccept_placeholder_1");
    expect(job?.status).toBe("pending");
    expect(job?.providerJobId).toBeNull();
    expect(job?.nextPollAt).not.toBeNull();
    expect(refundCalls).toBe(0);
  });

  it("fails stale wallet-session async placeholders that never reach acceptance", async () => {
    const networkConfig = resolveMarketplaceNetworkConfig({
      deploymentNetwork: "testnet"
    });
    const store = new InMemoryMarketplaceStore(networkConfig);
    const asyncRoute = buildMarketplaceRoutes(networkConfig).find((route) => route.routeId === "mock.async-report.v1");

    if (!asyncRoute) {
      throw new Error("Missing async seeded route.");
    }

    await store.savePendingAsyncJob({
      jobToken: "job_wallet_placeholder_stale_1",
      paymentId: "wallet_access_stale_1",
      buyerWallet: "fast1buyerwalletstale000000000000000000000000000000000000000000",
      route: {
        ...asyncRoute,
        billing: { type: "free" },
        price: "Free",
        executorKind: "http",
        asyncConfig: {
          strategy: "poll",
          timeoutMs: 60_000,
          pollPath: "/api/poll"
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
      serviceId: "service_wallet_placeholder_stale_1",
      requestId: "request_wallet_placeholder_stale_1",
      requestBody: { topic: "wallet placeholder" },
      nextPollAt: new Date(Date.now() - 1_000).toISOString(),
      timeoutAt: null
    });

    const jobsByToken = (store as unknown as {
      jobsByToken: Map<string, { createdAt: string; updatedAt: string }>;
    }).jobsByToken;
    const existing = jobsByToken.get("job_wallet_placeholder_stale_1");
    if (!existing) {
      throw new Error("Missing wallet placeholder job.");
    }
    jobsByToken.set("job_wallet_placeholder_stale_1", {
      ...existing,
      createdAt: new Date(Date.now() - PAYMENT_EXECUTION_RECOVERY_MS - 1_000).toISOString(),
      updatedAt: new Date(Date.now() - PAYMENT_EXECUTION_RECOVERY_MS - 1_000).toISOString()
    });

    let refundCalls = 0;
    await runMarketplaceWorkerCycle({
      store,
      secretsKey: "test-secrets-key",
      refundService: {
        async issueRefund() {
          refundCalls += 1;
          return { txHash: "0xwallet-placeholder-refund" };
        }
      }
    });

    const job = await store.getJob("job_wallet_placeholder_stale_1");
    expect(job?.status).toBe("failed");
    expect(job?.errorMessage).toContain("never accepted upstream");
    expect(refundCalls).toBe(0);
    expect(await store.getRefundByJobToken("job_wallet_placeholder_stale_1")).toBeNull();
  });

  it("prioritizes accepted due poll jobs ahead of older pre-accept placeholders", async () => {
    const networkConfig = resolveMarketplaceNetworkConfig({
      deploymentNetwork: "testnet"
    });
    const store = new InMemoryMarketplaceStore(networkConfig);
    const registry = createDefaultProviderRegistry();
    const asyncRoute = buildMarketplaceRoutes(networkConfig).find((route) => route.routeId === "mock.async-report.v1");

    if (!asyncRoute) {
      throw new Error("Missing async seeded route.");
    }

    await store.savePendingAsyncJob({
      jobToken: "job_preaccept_priority_1",
      buyerWallet: "fast1buyerpriority0000000000000000000000000000000000000000000",
      route: {
        ...asyncRoute,
        executorKind: "http",
        upstreamBaseUrl: "https://provider.example.com",
        upstreamPath: "/api/run",
        upstreamAuthMode: "none",
        asyncConfig: {
          strategy: "poll",
          timeoutMs: 60_000,
          pollPath: "/api/poll"
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
      serviceId: "service_preaccept_priority_1",
      requestId: "request_preaccept_priority_1",
      requestBody: { topic: "placeholder" },
      nextPollAt: new Date(Date.now() - 1_000).toISOString(),
      timeoutAt: null
    });

    await store.saveAsyncAcceptance({
      paymentId: "worker_payment_priority_due_1",
      normalizedRequestHash: "hash-priority-due",
      buyerWallet: "fast1buyerduepriority00000000000000000000000000000000000000000",
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
      paymentPayload: "payload-priority-due",
      facilitatorResponse: { auth: "wallet_session" },
      jobToken: "job_priority_due_1",
      requestId: "request_priority_due_1",
      providerJobId: "provider_priority_due_1",
      requestBody: { topic: "due report" },
      providerState: {
        topic: "due report",
        readyAt: Date.now() - 10
      },
      nextPollAt: new Date(Date.now() - 5_000).toISOString(),
      timeoutAt: new Date(Date.now() + 60_000).toISOString(),
      responseBody: {
        jobToken: "job_priority_due_1",
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

    expect((await store.getJob("job_priority_due_1"))?.status).toBe("completed");
    expect((await store.getJob("job_preaccept_priority_1"))?.status).toBe("pending");
    expect((await store.getJob("job_preaccept_priority_1"))?.providerJobId).toBeNull();
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
