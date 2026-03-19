import {
  createDefaultProviderRegistry,
  type MarketplaceStore,
  type PayoutService,
  type ProviderRegistry,
  type RefundService
} from "@marketplace/shared";

export interface MarketplaceWorkerOptions {
  store: MarketplaceStore;
  refundService: RefundService;
  payoutService?: PayoutService;
  providers?: ProviderRegistry;
  limit?: number;
}

export async function runMarketplaceWorkerCycle(options: MarketplaceWorkerOptions): Promise<void> {
  const providers = options.providers ?? createDefaultProviderRegistry();
  const jobs = await options.store.listPendingJobs(options.limit ?? 10);

  for (const job of jobs) {
    const route = job.routeSnapshot;

    if (route.executorKind !== "mock") {
      await options.store.failJob(job.jobToken, `Unsupported async executor: ${route.executorKind}`);
      continue;
    }

    const provider = providers[route.provider];
    if (!provider) {
      await options.store.failJob(job.jobToken, `Missing provider adapter: ${route.provider}`);
      continue;
    }

    const pollResult = await provider.poll({ route, job });
    await options.store.recordProviderAttempt({
      jobToken: job.jobToken,
      phase: "poll",
      status: pollResult.status === "failed" ? "failed" : "succeeded",
      requestPayload: {
        providerJobId: job.providerJobId,
        state: job.providerState
      },
      responsePayload: pollResult,
      errorMessage: pollResult.status === "failed" ? pollResult.error : undefined
    });

    if (pollResult.status === "pending") {
      await options.store.updateJobPending(job.jobToken, pollResult.state);
      continue;
    }

    if (pollResult.status === "completed") {
      await options.store.completeJob(job.jobToken, pollResult.body);
      continue;
    }

    if (!pollResult.permanent) {
      await options.store.updateJobPending(job.jobToken, pollResult.state);
      continue;
    }

    await options.store.failJob(job.jobToken, pollResult.error);
    const refund = await options.store.createRefund({
      jobToken: job.jobToken,
      paymentId: job.paymentId,
      wallet: job.buyerWallet,
      amount: job.quotedPrice
    });

    try {
      const receipt = await options.refundService.issueRefund({
        wallet: job.buyerWallet,
        amount: job.quotedPrice,
        reason: pollResult.error
      });

      await options.store.recordProviderAttempt({
        jobToken: job.jobToken,
        phase: "refund",
        status: "succeeded",
        requestPayload: {
          wallet: job.buyerWallet,
          amount: job.quotedPrice
        },
        responsePayload: receipt
      });
      await options.store.markRefundSent(refund.id, receipt.txHash);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown refund failure.";
      await options.store.recordProviderAttempt({
        jobToken: job.jobToken,
        phase: "refund",
        status: "failed",
        requestPayload: {
          wallet: job.buyerWallet,
          amount: job.quotedPrice
        },
        errorMessage: message
      });
      await options.store.markRefundFailed(refund.id, message);
    }
  }

  await backfillProviderPayouts({
    store: options.store,
    limit: options.limit ?? 10
  });

  if (options.payoutService) {
    await settleProviderPayouts({
      store: options.store,
      payoutService: options.payoutService,
      limit: options.limit ?? 10
    });
  }
}

async function backfillProviderPayouts(input: {
  store: MarketplaceStore;
  limit: number;
}) {
  const recoverable = await input.store.listRecoverableProviderPayouts(input.limit);

  for (const payout of recoverable) {
    try {
      await input.store.createProviderPayout(payout);
    } catch (error) {
      console.error(`Failed to backfill provider payout for ${payout.sourceKind}:${payout.sourceId}`, error);
    }
  }
}

async function settleProviderPayouts(input: {
  store: MarketplaceStore;
  payoutService: PayoutService;
  limit: number;
}) {
  const pending = await input.store.listPendingProviderPayouts(input.limit);
  const groups = new Map<string, typeof pending>();

  for (const payout of pending) {
    const key = `${payout.providerWallet}:${payout.currency}`;
    const current = groups.get(key) ?? [];
    current.push(payout);
    groups.set(key, current);
  }

  for (const payouts of groups.values()) {
    const payoutIds = payouts.map((payout) => payout.id);
    const amount = payouts.reduce((total, payout) => total + BigInt(payout.amount), 0n).toString();

    try {
      const receipt = await input.payoutService.issuePayout({
        wallet: payouts[0]!.providerWallet,
        amount,
        reason: `Marketplace provider payout batch (${payoutIds.length} records).`
      });
      await input.store.markProviderPayoutsSent(payoutIds, receipt.txHash);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown payout failure.";
      await input.store.markProviderPayoutSendFailure(payoutIds, message);
    }
  }
}
