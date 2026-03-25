import {
  MARKETPLACE_JOB_TOKEN_HEADER,
  PAYMENT_EXECUTION_RECOVERY_MS,
  computeTimeoutAt,
  buildMarketplaceIdentityHeaders,
  computeNextPollAt,
  createDefaultProviderRegistry,
  decryptProviderRuntimeKey,
  decryptSecret,
  isPrepaidCreditBilling,
  resolveAsyncJobFailure,
  type AsyncExecuteResult,
  type IdempotencyRecord,
  type JobRecord,
  type MarketplaceStore,
  type PollResult,
  type PayoutService,
  type ProviderAttemptRecord,
  type ProviderRegistry,
  type RefundRecord,
  type RefundService,
  type UpstreamAuthMode
} from "@marketplace/shared";

export interface MarketplaceWorkerOptions {
  store: MarketplaceStore;
  refundService: RefundService;
  payoutService?: PayoutService;
  providers?: ProviderRegistry;
  secretsKey: string;
  limit?: number;
}

export async function runMarketplaceWorkerCycle(options: MarketplaceWorkerOptions): Promise<void> {
  const providers = options.providers ?? createDefaultProviderRegistry();
  const now = new Date();
  const jobs = await options.store.listPendingJobs({
    limit: options.limit ?? 10,
    now: now.toISOString()
  });
  const nowMs = now.getTime();

  for (const job of jobs) {
    let currentJob = job;
    if (!currentJob.providerJobId) {
      const repairedJob = await recoverAcceptedAsyncPlaceholder(options.store, currentJob);
      if (!repairedJob) {
        if (isExpiredUnacceptedPlaceholder(currentJob, nowMs)) {
          await options.store.recordProviderAttempt({
            jobToken: currentJob.jobToken,
            routeId: currentJob.routeId,
            requestId: currentJob.requestId,
            phase: "poll",
            status: "failed",
            requestPayload: currentJob.requestBody,
            errorMessage: `Async job was never accepted upstream: ${currentJob.jobToken}`
          });
          await expireAsyncPrepaidReservation(options.store, currentJob);
          await resolveAsyncJobFailure({
            store: options.store,
            refundService: options.refundService,
            job: currentJob,
            error: `Async job was never accepted upstream for ${currentJob.routeId}.`
          });
          continue;
        }
        await backoffUnacceptedPlaceholder(options.store, currentJob);
        continue;
      }
      currentJob = repairedJob;
    }

    const route = currentJob.routeSnapshot;

    if (currentJob.timeoutAt && Date.parse(currentJob.timeoutAt) <= nowMs) {
      await options.store.recordProviderAttempt({
        jobToken: currentJob.jobToken,
        routeId: currentJob.routeId,
        requestId: currentJob.requestId,
        phase: "poll",
        status: "failed",
        requestPayload: {
          providerJobId: currentJob.providerJobId,
          providerState: currentJob.providerState
        },
        errorMessage: `Async job timed out: ${currentJob.jobToken}`
      });
      await expireAsyncPrepaidReservation(options.store, currentJob);
      await resolveAsyncJobFailure({
        store: options.store,
        refundService: options.refundService,
        job: currentJob,
        error: `Async job timed out for ${currentJob.routeId}.`
      });
      continue;
    }

    if (currentJob.nextPollAt && Date.parse(currentJob.nextPollAt) > nowMs) {
      continue;
    }

    if (route.asyncConfig?.strategy === "webhook") {
      continue;
    }

    let pollResult: PollResult;

    try {
      if (route.executorKind === "mock") {
        const provider = providers[route.provider];
        if (!provider) {
          await options.store.recordProviderAttempt({
            jobToken: currentJob.jobToken,
            routeId: currentJob.routeId,
            requestId: currentJob.requestId,
            phase: "poll",
            status: "failed",
            requestPayload: {
              providerJobId: currentJob.providerJobId,
              providerState: currentJob.providerState
            },
            errorMessage: `Missing provider adapter: ${route.provider}`
          });
          await expireAsyncPrepaidReservation(options.store, currentJob);
          await resolveAsyncJobFailure({
            store: options.store,
            refundService: options.refundService,
            job: currentJob,
            error: `Missing provider adapter: ${route.provider}`
          });
          continue;
        }

        pollResult = await provider.poll({ route, job: currentJob });
      } else if (route.executorKind === "http") {
        pollResult = await pollHttpRoute({
          job: currentJob,
          store: options.store,
          secretsKey: options.secretsKey
        });
      } else {
        await options.store.recordProviderAttempt({
          jobToken: currentJob.jobToken,
          routeId: currentJob.routeId,
          requestId: currentJob.requestId,
          phase: "poll",
          status: "failed",
          requestPayload: {
            providerJobId: currentJob.providerJobId,
            providerState: currentJob.providerState
          },
          errorMessage: `Unsupported async executor: ${route.executorKind}`
        });
        await expireAsyncPrepaidReservation(options.store, currentJob);
        await resolveAsyncJobFailure({
          store: options.store,
          refundService: options.refundService,
          job: currentJob,
          error: `Unsupported async executor: ${route.executorKind}`
        });
        continue;
      }
    } catch (error) {
      pollResult = {
        status: "failed",
        permanent: true,
        error: error instanceof Error ? error.message : `Async poll failed for ${currentJob.routeId}.`,
        providerState: currentJob.providerState ?? undefined
      };
    }

    await options.store.recordProviderAttempt({
      jobToken: currentJob.jobToken,
      routeId: currentJob.routeId,
      requestId: currentJob.requestId,
      phase: "poll",
      status: pollResult.status === "failed" ? "failed" : "succeeded",
      requestPayload: {
        providerJobId: currentJob.providerJobId,
        providerState: currentJob.providerState
      },
      responsePayload: pollResult,
      errorMessage: pollResult.status === "failed" ? pollResult.error : undefined
    });

    if (pollResult.status === "pending") {
      await options.store.updateJobPending({
        jobToken: currentJob.jobToken,
        providerState: pollResult.providerState ?? currentJob.providerState,
        nextPollAt: computeNextPollAt(pollResult.pollAfterMs)
      });
      continue;
    }

    if (pollResult.status === "completed") {
      await options.store.completeJob(currentJob.jobToken, pollResult.body);
      continue;
    }

    if (!pollResult.permanent) {
      await options.store.updateJobPending({
        jobToken: currentJob.jobToken,
        providerState: pollResult.providerState ?? currentJob.providerState,
        nextPollAt: computeNextPollAt()
      });
      continue;
    }

    await expireAsyncPrepaidReservation(options.store, currentJob);
    await resolveAsyncJobFailure({
      store: options.store,
      refundService: options.refundService,
      job: currentJob,
      error: pollResult.error
    });
  }

  await expireStaleCreditReservations({
    store: options.store,
    limit: options.limit ?? 10,
    now: now.toISOString()
  });

  await recoverStalePendingPayments({
    store: options.store,
    refundService: options.refundService,
    limit: options.limit ?? 10
  });

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

async function recoverAcceptedAsyncPlaceholder(
  store: MarketplaceStore,
  job: JobRecord,
  attempt?: ProviderAttemptRecord | null
): Promise<JobRecord | null> {
  const resolvedAttempt = attempt ?? await store.getLatestSuccessfulProviderExecuteAttempt(job.jobToken);
  const accepted = parseAcceptedAsyncExecuteAttempt(resolvedAttempt?.responsePayload);
  if (!accepted) {
    return null;
  }

  const acceptedAt = parseAttemptCreatedAt(resolvedAttempt?.createdAt);
  const nextPollAt = job.routeSnapshot.asyncConfig?.strategy === "poll"
    ? computeNextPollAt(accepted.pollAfterMs, acceptedAt)
    : null;

  return store.savePendingAsyncJob({
    jobToken: job.jobToken,
    paymentId: job.paymentId,
    buyerWallet: job.buyerWallet,
    route: job.routeSnapshot,
    quotedPrice: job.quotedPrice,
    payoutSplit: job.payoutSplit,
    serviceId: job.serviceId,
    requestId: job.requestId,
    providerJobId: accepted.providerJobId,
    requestBody: job.requestBody,
    providerState: accepted.providerState,
    nextPollAt,
    timeoutAt: computeTimeoutAt(job.routeSnapshot, acceptedAt)
  });
}

async function backoffUnacceptedPlaceholder(store: MarketplaceStore, job: JobRecord) {
  await store.updateJobPending({
    jobToken: job.jobToken,
    nextPollAt: computeNextPollAt()
  });
}

function isExpiredUnacceptedPlaceholder(job: JobRecord, nowMs: number): boolean {
  const createdAtMs = Date.parse(job.createdAt);
  return !Number.isNaN(createdAtMs) && createdAtMs <= nowMs - PAYMENT_EXECUTION_RECOVERY_MS;
}

function parseAttemptCreatedAt(createdAt: string | undefined): Date {
  const parsed = createdAt ? Date.parse(createdAt) : Number.NaN;
  return Number.isNaN(parsed) ? new Date() : new Date(parsed);
}

function parseAcceptedAsyncExecuteAttempt(payload: unknown): AsyncExecuteResult | null {
  if (!isJsonObject(payload) || payload.kind !== "async" || typeof payload.providerJobId !== "string") {
    return null;
  }

  return {
    kind: "async",
    providerJobId: payload.providerJobId,
    providerState: isJsonObject(payload.providerState) ? payload.providerState : undefined,
    pollAfterMs: typeof payload.pollAfterMs === "number" && Number.isFinite(payload.pollAfterMs)
      ? payload.pollAfterMs
      : undefined
  };
}

async function pollHttpRoute(input: {
  job: JobRecord;
  store: MarketplaceStore;
  secretsKey: string;
}): Promise<PollResult> {
  const route = input.job.routeSnapshot;
  if (!route.asyncConfig || route.asyncConfig.strategy !== "poll" || !route.asyncConfig.pollPath) {
    return {
      status: "failed",
      permanent: true,
      error: "HTTP async route is missing poll configuration.",
      providerState: input.job.providerState ?? undefined
    };
  }

  if (!route.upstreamBaseUrl || !route.upstreamAuthMode || !input.job.serviceId) {
    return {
      status: "failed",
      permanent: true,
      error: "HTTP async route is missing upstream or service configuration.",
      providerState: input.job.providerState ?? undefined
    };
  }

  const detail = await input.store.getAdminProviderService(input.job.serviceId);
  if (!detail) {
    return {
      status: "failed",
      permanent: true,
      error: `Provider service not found: ${input.job.serviceId}`,
      providerState: input.job.providerState ?? undefined
    };
  }

  const runtimeKeyRecord = await input.store.getProviderRuntimeKeyForOwner(input.job.serviceId, detail.account.ownerWallet);
  if (!runtimeKeyRecord) {
    return {
      status: "failed",
      permanent: true,
      error: "Provider runtime key is required for async HTTP polling.",
      providerState: input.job.providerState ?? undefined
    };
  }

  const headers: Record<string, string> = {
    "content-type": "application/json",
    [MARKETPLACE_JOB_TOKEN_HEADER]: input.job.jobToken,
    ...buildMarketplaceIdentityHeaders({
      buyerWallet: input.job.buyerWallet,
      serviceId: input.job.serviceId,
      requestId: input.job.requestId,
      paymentId: input.job.paymentId,
      signingSecret: decryptProviderRuntimeKey({
        ciphertext: runtimeKeyRecord.secretCiphertext,
        iv: runtimeKeyRecord.iv,
        authTag: runtimeKeyRecord.authTag,
        secret: input.secretsKey
      })
    })
  };

  if (route.upstreamAuthMode !== "none") {
    if (!route.upstreamSecretRef) {
      return {
        status: "failed",
        permanent: true,
        error: "HTTP async poll route is missing upstream secret.",
        providerState: input.job.providerState ?? undefined
      };
    }

    const secret = await input.store.getProviderSecret(route.upstreamSecretRef);
    if (!secret) {
      return {
        status: "failed",
        permanent: true,
        error: "Upstream secret not found.",
        providerState: input.job.providerState ?? undefined
      };
    }

    const decrypted = decryptSecret({
      ciphertext: secret.secretCiphertext,
      iv: secret.iv,
      authTag: secret.authTag,
      secret: input.secretsKey
    });
    applyUpstreamAuthHeaders(headers, route.upstreamAuthMode, decrypted, route.upstreamAuthHeaderName ?? null);
  }

  let response: globalThis.Response;
  try {
    response = await fetch(joinUrl(route.upstreamBaseUrl, route.asyncConfig.pollPath), {
      method: "POST",
      headers,
      body: JSON.stringify({
        providerJobId: input.job.providerJobId,
        providerState: input.job.providerState ?? null
      })
    });
  } catch (error) {
    return {
      status: "failed",
      permanent: false,
      error: error instanceof Error ? error.message : "Upstream poll failed.",
      providerState: input.job.providerState ?? undefined
    };
  }

  if (!response.ok) {
    return {
      status: "failed",
      permanent: response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429,
      error: `Upstream poll failed with status ${response.status}.`,
      providerState: input.job.providerState ?? undefined
    };
  }

  return parseHttpPollResponse(await safeResponseBody(response));
}

function parseHttpPollResponse(body: unknown): PollResult {
  if (!isJsonObject(body) || typeof body.status !== "string") {
    throw new Error("HTTP async poll response must be a JSON object with a status field.");
  }

  if (body.status === "pending") {
    return {
      status: "pending",
      providerState: isJsonObject(body.providerState) ? body.providerState : undefined,
      pollAfterMs: typeof body.pollAfterMs === "number" && Number.isFinite(body.pollAfterMs)
        ? body.pollAfterMs
        : undefined
    };
  }

  if (body.status === "completed") {
    return {
      status: "completed",
      body: body.result
    };
  }

  if (body.status === "failed" && typeof body.error === "string") {
    return {
      status: "failed",
      error: body.error,
      permanent: Boolean(body.permanent),
      providerState: isJsonObject(body.providerState) ? body.providerState : undefined
    };
  }

  throw new Error("HTTP async poll response did not match the marketplace protocol.");
}

async function expireAsyncPrepaidReservation(store: MarketplaceStore, job: {
  jobToken: string;
  serviceId: string | null;
  routeSnapshot: { billing: { type: string } };
}) {
  if (!job.serviceId || !isPrepaidCreditBilling(job.routeSnapshot)) {
    return;
  }

  const reservation = await store.getCreditReservationByJobToken(job.serviceId, job.jobToken);
  if (!reservation || reservation.status !== "reserved") {
    return;
  }

  await store.expireCreditReservation(reservation.id);
}

async function expireStaleCreditReservations(input: {
  store: MarketplaceStore;
  limit: number;
  now?: string;
}) {
  const reservations = await input.store.listExpiredCreditReservations(input.limit, input.now);
  for (const reservation of reservations) {
    await input.store.expireCreditReservation(reservation.id);
  }
}

function applyUpstreamAuthHeaders(
  headers: Record<string, string>,
  mode: UpstreamAuthMode,
  secret: string,
  headerName: string | null
) {
  if (mode === "bearer") {
    headers.authorization = `Bearer ${secret}`;
    return;
  }

  if (mode === "header") {
    if (!headerName) {
      throw new Error("Custom header auth requires upstreamAuthHeaderName.");
    }

    headers[headerName] = secret;
  }
}

async function safeResponseBody(response: globalThis.Response): Promise<unknown> {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return response.json();
  }

  return response.text();
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/$/, "")}${path.startsWith("/") ? path : `/${path}`}`;
}

function buildRecoveredAsyncJobResponse(job: JobRecord, now: Date = new Date()): {
  jobToken: string;
  status: "pending";
  pollAfterMs?: number;
} {
  const response: {
    jobToken: string;
    status: "pending";
    pollAfterMs?: number;
  } = {
    jobToken: job.jobToken,
    status: "pending"
  };

  if (job.status === "pending" && job.nextPollAt) {
    const nextPollAtMs = Date.parse(job.nextPollAt);
    if (!Number.isNaN(nextPollAtMs)) {
      response.pollAfterMs = Math.max(1_000, nextPollAtMs - now.getTime());
    }
  }

  return response;
}

function canRecoverPendingJobExecution(
  job: JobRecord,
  acceptedExecuteAttempt: ProviderAttemptRecord | null
): boolean {
  return job.status === "completed"
    || Boolean(job.providerJobId)
    || Boolean(parseAcceptedAsyncExecuteAttempt(acceptedExecuteAttempt?.responsePayload));
}

async function recoverStalePendingPayments(input: {
  store: MarketplaceStore;
  refundService: RefundService;
  limit: number;
}) {
  const staleBefore = new Date(Date.now() - PAYMENT_EXECUTION_RECOVERY_MS).toISOString();
  const pendingPayments = await input.store.listStalePendingPaymentExecutions(staleBefore, input.limit);

  for (const payment of pendingPayments) {
    if (payment.pendingRecoveryAction === "retry") {
      continue;
    }

    let job: JobRecord | null = null;
    let acceptedExecuteAttempt: ProviderAttemptRecord | null = null;
    let latestExecuteAttempt: ProviderAttemptRecord | null = null;
    if (payment.responseKind === "job" && payment.jobToken) {
      job = await input.store.getJob(payment.jobToken);
      latestExecuteAttempt = await input.store.getLatestProviderExecuteAttempt(payment.jobToken);
      if (job && !job.providerJobId) {
        acceptedExecuteAttempt = latestExecuteAttempt?.status === "succeeded"
          ? latestExecuteAttempt
          : await input.store.getLatestSuccessfulProviderExecuteAttempt(job.jobToken);
        const repairedJob = await recoverAcceptedAsyncPlaceholder(input.store, job, acceptedExecuteAttempt);
        if (repairedJob) {
          job = repairedJob;
        }
      }

      if (job && canRecoverPendingJobExecution(job, acceptedExecuteAttempt)) {
        await input.store.completePendingJobExecution({
          paymentId: payment.paymentId,
          jobToken: job.jobToken,
          responseBody: buildRecoveredAsyncJobResponse(job),
          responseHeaders: payment.responseHeaders
        });
        continue;
      }
    }

    if (job) {
      job = await fenceRefundedAsyncJob(input.store, payment.paymentId, job);
      if (canRecoverPendingJobExecution(job, acceptedExecuteAttempt)) {
        await input.store.completePendingJobExecution({
          paymentId: payment.paymentId,
          jobToken: job.jobToken,
          responseBody: buildRecoveredAsyncJobResponse(job),
          responseHeaders: payment.responseHeaders
        });
        continue;
      }
    }

    const refund = await input.store.createRefund({
      jobToken: payment.jobToken ?? undefined,
      paymentId: payment.paymentId,
      wallet: payment.buyerWallet,
      amount: payment.quotedPrice
    });

    if (refund.status === "sent" || refund.status === "failed") {
      await finalizeRecoveredRefundedPayment(input.store, payment, refund, latestExecuteAttempt);
      continue;
    }

    try {
      const receipt = await input.refundService.issueRefund({
        wallet: payment.buyerWallet,
        amount: payment.quotedPrice,
        reason: `Automatic recovery refund for unresolved paid request ${payment.paymentId}.`
      });
      const sentRefund = await input.store.markRefundSent(refund.id, receipt.txHash);
      await finalizeRecoveredRefundedPayment(input.store, payment, sentRefund, latestExecuteAttempt);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown refund failure.";
      const failedRefund = await input.store.markRefundFailed(refund.id, message);
      await finalizeRecoveredRefundedPayment(input.store, payment, failedRefund, latestExecuteAttempt);
    }
  }
}

async function fenceRefundedAsyncJob(
  store: MarketplaceStore,
  paymentId: string,
  job: JobRecord
) {
  return store.failJob(
    job.jobToken,
    `Automatic recovery refund started for unresolved paid request ${paymentId}.`
  );
}

async function finalizeRecoveredRefundedPayment(
  store: MarketplaceStore,
  payment: IdempotencyRecord,
  refund: RefundRecord,
  executeAttempt: ProviderAttemptRecord | null
) {
  const failure = buildRecoveredRefundFailureResponse(refund, executeAttempt);
  await store.saveSyncIdempotency({
    paymentId: payment.paymentId,
    normalizedRequestHash: payment.normalizedRequestHash,
    buyerWallet: payment.buyerWallet,
    routeId: payment.routeId,
    routeVersion: payment.routeVersion,
    quotedPrice: payment.quotedPrice,
    payoutSplit: payment.payoutSplit,
    paymentPayload: payment.paymentPayload,
    facilitatorResponse: payment.facilitatorResponse,
    statusCode: failure.statusCode,
    body: failure.body,
    headers: failure.headers,
    requestId: payment.requestId ?? undefined
  });
}

function buildRecoveredRefundFailureResponse(
  refund: RefundRecord,
  executeAttempt: ProviderAttemptRecord | null
): {
  statusCode: number;
  headers: Record<string, string>;
  body: Record<string, unknown>;
} {
  const hasFailedExecuteAttempt = executeAttempt?.status === "failed";
  const upstreamStatus = executeAttempt?.responseStatusCode ?? 500;
  const upstreamBody = executeAttempt?.responsePayload
    ?? (executeAttempt?.errorMessage ? { error: executeAttempt.errorMessage } : { error: "Upstream request failed." });

  if (!hasFailedExecuteAttempt) {
    if (refund.status === "sent") {
      return {
        statusCode: 500,
        headers: {
          "content-type": "application/json"
        },
        body: {
          error: "Request outcome was not durably recorded. Payment was refunded.",
          refund: {
            status: refund.status,
            txHash: refund.txHash
          }
        }
      };
    }

    return {
      statusCode: 500,
      headers: {
        "content-type": "application/json"
      },
      body: {
        error: "Request outcome was not durably recorded and the automatic refund did not complete.",
        refund: {
          status: refund.status,
          error: refund.errorMessage
        }
      }
    };
  }

  if (refund.status === "sent") {
    return {
      statusCode: upstreamStatus,
      headers: {
        "content-type": "application/json"
      },
      body: {
        error: "Upstream request failed. Payment was refunded.",
        upstreamStatus,
        upstreamBody,
        refund: {
          status: refund.status,
          txHash: refund.txHash
        }
      }
    };
  }

  return {
    statusCode: upstreamStatus,
    headers: {
      "content-type": "application/json"
    },
    body: {
      error: "Upstream request failed and the automatic refund did not complete.",
      upstreamStatus,
      upstreamBody,
      refund: {
        status: refund.status,
        error: refund.errorMessage
      }
    }
  };
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
