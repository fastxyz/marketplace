import { randomUUID } from "node:crypto";

import { Pool } from "pg";

import { rawToDecimalString } from "./amounts.js";
import { createDraftRouteBilling, normalizeRouteBilling } from "./billing.js";
import { PAYMENT_EXECUTION_RECOVERY_MS } from "./constants.js";
import { getDefaultMarketplaceNetworkConfig, type MarketplaceNetworkConfig } from "./network.js";
import { hashProviderRuntimeKey } from "./provider-runtime.js";
import { usesMarketplaceTreasurySettlement } from "./settlement.js";
import {
  MARKETPLACE_PROVIDER_ACCOUNT_SEED,
  SEEDED_PROVIDER_SERVICE_IDS,
  buildSeededProviderServices,
  buildSeededProviderEndpointDrafts,
  buildSeededPublishedEndpointVersions,
  buildSeededPublishedServiceVersions
} from "./seed.js";
import type {
  AccessGrantRecord,
  AsyncRouteStrategy,
  BuyerActivityItem,
  BuyerActivityItemStatus,
  BuyerActivityRange,
  BuyerActivityResponse,
  ClaimPaymentExecutionInput,
  ClaimPaymentExecutionResult,
  CompleteCreditTopupChargeInput,
  CreditAccountRecord,
  CreditLedgerEntryRecord,
  CreditReservationRecord,
  CreateProviderEndpointDraftInput,
  CreateProviderServiceInput,
  CreateSuggestionInput,
  ExternalProviderEndpointDraftRecord,
  IdempotencyRecord,
  JobRecord,
  MarketplaceRoute,
  MarketplaceStore,
  MarketplaceProviderEndpointDraftRecord,
  ProviderAccountRecord,
  ProviderAttemptRecord,
  ProviderEndpointDraftRecord,
  ProviderPayoutInput,
  ProviderPayoutRecord,
  ProviderReviewRecord,
  ProviderRuntimeKeyRecord,
  ProviderSecretRecord,
  ProviderServiceDetailRecord,
  ProviderServiceRecord,
  ProviderServiceStatus,
  ProviderServiceType,
  ProviderVerificationRecord,
  ProviderVerificationStatus,
  PublishedExternalEndpointVersionRecord,
  PublishedEndpointVersionRecord,
  PublishedServiceEndpointVersionRecord,
  PublishedServiceVersionRecord,
  ResourceType,
  RefundRecord,
  RouteAsyncConfig,
  RouteMode,
  SaveAsyncAcceptanceInput,
  SavePendingAsyncJobInput,
  SaveSyncIdempotencyInput,
  ServiceAnalytics,
  SettlementMode,
  SuggestionRecord,
  SuggestionStatus,
  UpdateProviderEndpointDraftInput,
  UpdateProviderServiceInput,
  UpdateSuggestionInput,
  UpsertProviderAccountInput
} from "./types.js";

function timestamp(): string {
  return new Date().toISOString();
}

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, "\"\"")}"`;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isOlderThanRecoveryWindow(updatedAt: string): boolean {
  const updatedAtMs = Date.parse(updatedAt);
  return !Number.isNaN(updatedAtMs) && updatedAtMs <= Date.now() - PAYMENT_EXECUTION_RECOVERY_MS;
}

function isPendingJobTimedOut(job: Pick<JobRecord, "timeoutAt">, nowMs: number): boolean {
  if (!job.timeoutAt) {
    return false;
  }

  const timeoutMs = Date.parse(job.timeoutAt);
  return !Number.isNaN(timeoutMs) && timeoutMs <= nowMs;
}

function isPendingJobActionable(
  job: Pick<JobRecord, "status" | "nextPollAt" | "timeoutAt" | "routeSnapshot" | "providerJobId">,
  nowMs: number
): boolean {
  if (job.status !== "pending") {
    return false;
  }

  if (isPendingJobTimedOut(job, nowMs)) {
    return true;
  }

  if (!job.providerJobId) {
    if (!job.nextPollAt) {
      return true;
    }

    const nextPollMs = Date.parse(job.nextPollAt);
    return Number.isNaN(nextPollMs) || nextPollMs <= nowMs;
  }

  if (job.routeSnapshot.asyncConfig?.strategy === "webhook") {
    return false;
  }

  if (!job.nextPollAt) {
    return true;
  }

  const nextPollMs = Date.parse(job.nextPollAt);
  return Number.isNaN(nextPollMs) || nextPollMs <= nowMs;
}

function resolveRouteServiceId(route: MarketplaceRoute, serviceId?: string | null): string | null {
  return serviceId ?? ("serviceId" in route ? (route.serviceId as string) : null);
}

function buildPendingAsyncJobRecord(
  input: SavePendingAsyncJobInput,
  existing: JobRecord | null,
  now: string
): JobRecord {
  const nextStatus = existing?.status ?? "pending";
  return {
    jobToken: input.jobToken,
    paymentId: input.paymentId === undefined
      ? (existing?.paymentId ?? null)
      : input.paymentId,
    routeId: input.route.routeId,
    serviceId: existing?.serviceId ?? resolveRouteServiceId(input.route, input.serviceId),
    provider: input.route.provider,
    operation: input.route.operation,
    buyerWallet: input.buyerWallet,
    quotedPrice: input.quotedPrice,
    payoutSplit: clone(input.payoutSplit),
    requestId: existing?.requestId ?? input.requestId,
    providerJobId: input.providerJobId === undefined
      ? (existing?.providerJobId ?? null)
      : input.providerJobId,
    requestBody: clone(input.requestBody),
    routeSnapshot: clone(input.route),
    providerState: input.providerState === undefined
      ? clone(existing?.providerState ?? null)
      : clone(input.providerState),
    nextPollAt: nextStatus === "pending"
      ? (input.nextPollAt === undefined
        ? (existing?.nextPollAt ?? null)
        : input.nextPollAt)
      : (existing?.nextPollAt ?? null),
    timeoutAt: nextStatus === "pending"
      ? (input.timeoutAt === undefined
        ? (existing?.timeoutAt ?? null)
        : input.timeoutAt)
      : (existing?.timeoutAt ?? input.timeoutAt ?? null),
    status: nextStatus,
    resultBody: clone(existing?.resultBody ?? null),
    errorMessage: existing?.errorMessage ?? null,
    refundStatus: existing?.refundStatus ?? "not_required",
    refundId: existing?.refundId ?? null,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now
  };
}

function buildAcceptedAsyncJobRecord(
  input: SaveAsyncAcceptanceInput,
  existing: JobRecord | null,
  now: string
): JobRecord {
  const nextStatus = existing?.status ?? "pending";
  return {
    jobToken: existing?.jobToken ?? input.jobToken,
    paymentId: existing?.paymentId ?? input.paymentId,
    routeId: input.route.routeId,
    serviceId: existing?.serviceId ?? resolveRouteServiceId(input.route, input.serviceId),
    provider: input.route.provider,
    operation: input.route.operation,
    buyerWallet: input.buyerWallet,
    quotedPrice: input.quotedPrice,
    payoutSplit: clone(input.payoutSplit),
    requestId: existing?.requestId ?? input.requestId,
    providerJobId: existing?.providerJobId ?? input.providerJobId,
    requestBody: clone(existing?.requestBody ?? input.requestBody),
    routeSnapshot: clone(input.route),
    providerState: clone(existing?.providerState ?? input.providerState ?? null),
    nextPollAt: nextStatus === "pending"
      ? (input.nextPollAt ?? null)
      : (existing?.nextPollAt ?? null),
    timeoutAt: nextStatus === "pending"
      ? (input.timeoutAt ?? null)
      : (existing?.timeoutAt ?? input.timeoutAt ?? null),
    status: nextStatus,
    resultBody: clone(existing?.resultBody ?? null),
    errorMessage: existing?.errorMessage ?? null,
    refundStatus: existing?.refundStatus ?? "not_required",
    refundId: existing?.refundId ?? null,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now
  };
}

function normalizeAsyncConfig(value: unknown): RouteAsyncConfig | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const candidate = value as Record<string, unknown>;
  const strategy = candidate.strategy;
  const timeoutMs = candidate.timeoutMs;

  if ((strategy !== "poll" && strategy !== "webhook") || typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs)) {
    return null;
  }

  return {
    strategy,
    timeoutMs,
    pollPath: typeof candidate.pollPath === "string"
      ? candidate.pollPath
      : candidate.pollPath === null
      ? null
      : undefined
  };
}

function buildRouteAsyncConfig(input: {
  mode: RouteMode;
  asyncStrategy?: AsyncRouteStrategy | null;
  asyncTimeoutMs?: number | null;
  pollPath?: string | null;
}, existing?: RouteAsyncConfig | null): RouteAsyncConfig | null {
  if (input.mode !== "async") {
    return null;
  }

  const strategy = input.asyncStrategy ?? existing?.strategy ?? null;
  const timeoutMs = input.asyncTimeoutMs ?? existing?.timeoutMs ?? null;
  const pollPath = input.pollPath === undefined ? (existing?.pollPath ?? null) : input.pollPath;

  if (!strategy || typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs)) {
    throw new Error("Async endpoints require asyncStrategy and asyncTimeoutMs.");
  }

  if (strategy === "poll") {
    if (!pollPath) {
      throw new Error("Poll-based async endpoints require pollPath.");
    }

    return {
      strategy,
      timeoutMs,
      pollPath
    };
  }

  return {
    strategy,
    timeoutMs,
    pollPath: null
  };
}

function buildRouteId(apiNamespace: string, operation: string): string {
  return `${apiNamespace}.${operation}.v1`;
}

function isMarketplaceServiceType(serviceType: ProviderServiceType): serviceType is "marketplace_proxy" {
  return serviceType === "marketplace_proxy";
}

function isMarketplaceService(service: Pick<ProviderServiceRecord, "serviceType">): service is ProviderServiceRecord & {
  serviceType: "marketplace_proxy";
} {
  return isMarketplaceServiceType(service.serviceType);
}

function isMarketplaceEndpointDraft(
  endpoint: ProviderEndpointDraftRecord
): endpoint is MarketplaceProviderEndpointDraftRecord {
  return endpoint.endpointType === "marketplace_proxy";
}

function isExternalEndpointDraft(
  endpoint: ProviderEndpointDraftRecord
): endpoint is ExternalProviderEndpointDraftRecord {
  return endpoint.endpointType === "external_registry";
}

function isMarketplacePublishedEndpoint(
  endpoint: PublishedServiceEndpointVersionRecord
): endpoint is PublishedEndpointVersionRecord {
  return endpoint.endpointType === "marketplace_proxy";
}

function isExternalPublishedEndpoint(
  endpoint: PublishedServiceEndpointVersionRecord
): endpoint is PublishedExternalEndpointVersionRecord {
  return endpoint.endpointType === "external_registry";
}

function sortByUpdatedDesc<T extends { updatedAt: string }>(records: T[]): T[] {
  return [...records].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

function latestByCreatedAt<T extends { createdAt: string }>(records: T[]): T | null {
  return (
    [...records].sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0] ?? null
  );
}

function chooseCanonicalFreeAttempt(attempts: ProviderAttemptRecord[]): ProviderAttemptRecord {
  let best = attempts[0];
  if (!best) {
    throw new Error("Expected at least one free execution attempt.");
  }

  const isResolved = (attempt: ProviderAttemptRecord) => attempt.status !== "pending" && attempt.responseStatusCode !== null;

  for (const attempt of attempts.slice(1)) {
    const bestResolved = isResolved(best);
    const nextResolved = isResolved(attempt);
    if (bestResolved !== nextResolved) {
      if (nextResolved) {
        best = attempt;
      }
      continue;
    }

    if (attempt.createdAt !== best.createdAt) {
      if (attempt.createdAt > best.createdAt) {
        best = attempt;
      }
      continue;
    }

    if (best.status === "pending" && attempt.status !== "pending") {
      best = attempt;
      continue;
    }

    if ((best.responseStatusCode ?? -1) !== (attempt.responseStatusCode ?? -1) && attempt.responseStatusCode !== null) {
      best = attempt;
      continue;
    }

    if (attempt.id > best.id) {
      best = attempt;
    }
  }

  return best;
}

function isSameOrSubdomain(input: { rootHost: string; candidateHost: string }): boolean {
  const root = input.rootHost.toLowerCase();
  const candidate = input.candidateHost.toLowerCase();

  return candidate === root || candidate.endsWith(`.${root}`);
}

function isPostgresUniqueViolation(error: unknown): boolean {
  return (error as { code?: string }).code === "23505";
}

function mapPublishedServiceToDefinition(service: PublishedServiceVersionRecord): PublishedServiceVersionRecord {
  return clone(service);
}

function isSuggestionProviderVisible(status: SuggestionStatus): boolean {
  return status !== "rejected" && status !== "shipped";
}

function buildProviderServiceDetail(input: {
  service: ProviderServiceRecord;
  account: ProviderAccountRecord;
  endpoints: ProviderEndpointDraftRecord[];
  verification: ProviderVerificationRecord | null;
  latestReview: ProviderReviewRecord | null;
  latestPublishedVersionId: string | null;
}): ProviderServiceDetailRecord {
  return {
    service: clone(input.service),
    account: clone(input.account),
    endpoints: sortByUpdatedDesc(input.endpoints).map((endpoint) => clone(endpoint)),
    verification: clone(input.verification),
    latestReview: clone(input.latestReview),
    latestPublishedVersionId: input.latestPublishedVersionId
  };
}

function mapPublishedServiceVersionToProviderService(version: PublishedServiceVersionRecord): ProviderServiceRecord {
  return {
    id: version.serviceId,
    providerAccountId: version.providerAccountId,
    serviceType: version.serviceType,
    settlementMode: version.settlementMode,
    slug: version.slug,
    apiNamespace: version.apiNamespace,
    name: version.name,
    tagline: version.tagline,
    about: version.about,
    categories: clone(version.categories),
    promptIntro: version.promptIntro,
    setupInstructions: clone(version.setupInstructions),
    websiteUrl: version.websiteUrl,
    payoutWallet: version.payoutWallet,
    featured: version.featured,
    status: version.status,
    createdAt: version.createdAt,
    updatedAt: version.updatedAt
  };
}

function mapPublishedEndpointVersionToProviderDraft(
  endpoint: PublishedEndpointVersionRecord
): MarketplaceProviderEndpointDraftRecord {
  return {
    endpointType: "marketplace_proxy",
    id: endpoint.endpointDraftId ?? endpoint.endpointVersionId,
    serviceId: endpoint.serviceId,
    routeId: endpoint.routeId,
    operation: endpoint.operation,
    method: endpoint.method,
    title: endpoint.title,
    description: endpoint.description,
    price: endpoint.price,
    billing: clone(endpoint.billing),
    mode: endpoint.mode,
    asyncConfig: clone(endpoint.asyncConfig ?? null),
    requestSchemaJson: clone(endpoint.requestSchemaJson),
    responseSchemaJson: clone(endpoint.responseSchemaJson),
    requestExample: clone(endpoint.requestExample),
    responseExample: clone(endpoint.responseExample),
    usageNotes: endpoint.usageNotes ?? null,
    executorKind: endpoint.executorKind,
    upstreamBaseUrl: endpoint.upstreamBaseUrl ?? null,
    upstreamPath: endpoint.upstreamPath ?? null,
    upstreamAuthMode: endpoint.upstreamAuthMode ?? null,
    upstreamAuthHeaderName: endpoint.upstreamAuthHeaderName ?? null,
    upstreamSecretRef: endpoint.upstreamSecretRef ?? null,
    hasUpstreamSecret: Boolean(endpoint.upstreamSecretRef),
    payout: clone(endpoint.payout),
    createdAt: endpoint.createdAt,
    updatedAt: endpoint.updatedAt
  };
}

function mapPublishedExternalEndpointVersionToProviderDraft(
  endpoint: PublishedExternalEndpointVersionRecord
): ExternalProviderEndpointDraftRecord {
  return {
    endpointType: "external_registry",
    id: endpoint.endpointDraftId ?? endpoint.endpointVersionId,
    serviceId: endpoint.serviceId,
    routeId: null,
    operation: null,
    title: endpoint.title,
    description: endpoint.description,
    price: null,
    billing: null,
    mode: null,
    requestSchemaJson: null,
    responseSchemaJson: null,
    method: endpoint.method,
    publicUrl: endpoint.publicUrl,
    docsUrl: endpoint.docsUrl,
    authNotes: endpoint.authNotes ?? null,
    requestExample: clone(endpoint.requestExample),
    responseExample: clone(endpoint.responseExample),
    usageNotes: endpoint.usageNotes ?? null,
    executorKind: null,
    upstreamBaseUrl: null,
    upstreamPath: null,
    upstreamAuthMode: null,
    upstreamAuthHeaderName: null,
    upstreamSecretRef: null,
    hasUpstreamSecret: false,
    payout: null,
    createdAt: endpoint.createdAt,
    updatedAt: endpoint.updatedAt
  };
}

function buildSubmittedProviderServiceDetail(input: {
  version: PublishedServiceVersionRecord;
  account: ProviderAccountRecord;
  endpoints: PublishedServiceEndpointVersionRecord[];
  verification: ProviderVerificationRecord | null;
  latestReview: ProviderReviewRecord | null;
  latestPublishedVersionId: string | null;
}): ProviderServiceDetailRecord {
  return buildProviderServiceDetail({
    service: mapPublishedServiceVersionToProviderService(input.version),
    account: input.account,
    endpoints: input.endpoints.map((endpoint) =>
      isMarketplacePublishedEndpoint(endpoint)
        ? mapPublishedEndpointVersionToProviderDraft(endpoint)
        : mapPublishedExternalEndpointVersionToProviderDraft(endpoint)
    ),
    verification: input.verification,
    latestReview: input.latestReview,
    latestPublishedVersionId: input.latestPublishedVersionId
  });
}

function computeServiceAnalytics(input: {
  routeIds: string[];
  idempotencyRecords: IdempotencyRecord[];
  jobs: JobRecord[];
  providerAttempts: ProviderAttemptRecord[];
}): ServiceAnalytics {
  const routeIds = new Set(input.routeIds);
  const acceptedCalls = input.idempotencyRecords.filter((record) => {
    if (!routeIds.has(record.routeId) || record.executionStatus !== "completed") {
      return false;
    }

    if (record.responseKind === "job") {
      return true;
    }

    return record.responseStatusCode >= 200 && record.responseStatusCode < 400;
  });
  const jobs = input.jobs.filter((job) => routeIds.has(job.routeId));
  const freeExecuteAttempts = input.providerAttempts.filter((attempt) => {
    if (!routeIds.has(attempt.routeId) || attempt.jobToken || attempt.phase !== "execute") {
      return false;
    }
    return true;
  });
  const freeAttemptsByRequestId = new Map<string, ProviderAttemptRecord[]>();
  for (const attempt of freeExecuteAttempts) {
    const key = attempt.requestId ?? attempt.id;
    const existing = freeAttemptsByRequestId.get(key);
    if (existing) {
      existing.push(attempt);
    } else {
      freeAttemptsByRequestId.set(key, [attempt]);
    }
  }
  const latestFreeAttempts = Array.from(freeAttemptsByRequestId.values()).map(chooseCanonicalFreeAttempt);
  const resolvedFreeAttempts = latestFreeAttempts.filter((attempt) => {
    return attempt.status !== "pending" && attempt.responseStatusCode !== null;
  });
  const windowStart = new Date(Date.now() - 29 * 24 * 60 * 60 * 1000);
  const volumeMap = new Map<string, bigint>();

  for (let offset = 29; offset >= 0; offset -= 1) {
    const date = new Date(Date.now() - offset * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    volumeMap.set(date, 0n);
  }

  let resolvedCalls30d = 0;
  let successfulCalls30d = 0;
  let revenueRaw = 0n;

  for (const record of acceptedCalls) {
    const createdAt = new Date(record.createdAt);
    if (createdAt >= windowStart) {
      const dateKey = createdAt.toISOString().slice(0, 10);
      volumeMap.set(dateKey, (volumeMap.get(dateKey) ?? 0n) + BigInt(record.quotedPrice));
    }

    if (record.responseKind === "sync") {
      const wasSuccessful = record.responseStatusCode >= 200 && record.responseStatusCode < 400;
      if (wasSuccessful) {
        revenueRaw += BigInt(record.payoutSplit.providerAmount);
      }

      if (createdAt >= windowStart) {
        resolvedCalls30d += 1;
        if (wasSuccessful) {
          successfulCalls30d += 1;
        }
      }
    }
  }

  for (const job of jobs) {
    const createdAt = new Date(job.createdAt);
    if (job.status === "completed") {
      revenueRaw += BigInt(job.payoutSplit.providerAmount);
    }

    if (createdAt < windowStart || job.status === "pending") {
      continue;
    }

    resolvedCalls30d += 1;
    if (job.status === "completed") {
      successfulCalls30d += 1;
    }
  }

  for (const attempt of resolvedFreeAttempts) {
    const createdAt = new Date(attempt.createdAt);
    if (createdAt < windowStart) {
      continue;
    }

    resolvedCalls30d += 1;
    if (
      attempt.status === "succeeded"
      && attempt.responseStatusCode !== null
      && attempt.responseStatusCode >= 200
      && attempt.responseStatusCode < 400
    ) {
      successfulCalls30d += 1;
    }
  }

  return {
    totalCalls: acceptedCalls.length + latestFreeAttempts.length,
    revenueRaw: revenueRaw.toString(),
    successRate30d: resolvedCalls30d === 0 ? 0 : (successfulCalls30d / resolvedCalls30d) * 100,
    volume30d: Array.from(volumeMap.entries()).map(([date, amountRaw]) => ({
      date,
      amountRaw: amountRaw.toString()
    }))
  };
}

function creditAccountKey(serviceId: string, buyerWallet: string, currency: string): string {
  return `${serviceId}:${buyerWallet}:${currency}`;
}

function creditReservationKey(serviceId: string, idempotencyKey: string): string {
  return `${serviceId}:${idempotencyKey}`;
}

function creditReservationJobTokenKey(serviceId: string, jobToken: string): string {
  return `${serviceId}:${jobToken}`;
}

function creditTopupKey(serviceId: string, paymentId: string): string {
  return `${serviceId}:${paymentId}`;
}

function buildPendingPaymentExecutionRecord(input: ClaimPaymentExecutionInput, now: string): IdempotencyRecord {
  return {
    paymentId: input.paymentId,
    normalizedRequestHash: input.normalizedRequestHash,
    buyerWallet: input.buyerWallet,
    routeId: input.routeId,
    routeVersion: input.routeVersion,
    pendingRecoveryAction: input.pendingRecoveryAction,
    quotedPrice: input.quotedPrice,
    payoutSplit: clone(input.payoutSplit),
    paymentPayload: input.paymentPayload,
    facilitatorResponse: clone(input.facilitatorResponse),
    responseKind: input.responseKind,
    responseStatusCode: 202,
    responseBody: clone(input.responseBody ?? { status: "processing" }),
    responseHeaders: clone(input.responseHeaders ?? {}),
    providerPayoutSourceKind: null,
    executionStatus: "pending",
    requestId: input.requestId,
    jobToken: input.jobToken,
    createdAt: now,
    updatedAt: now
  };
}

function buildStoredTopupResponseBody(input: {
  routeId: string;
  serviceId: string;
  buyerWallet: string;
  quotedPrice: string;
  account: CreditAccountRecord;
  entry: CreditLedgerEntryRecord;
}) {
  return {
    routeId: input.routeId,
    serviceId: input.serviceId,
    wallet: input.buyerWallet,
    topupAmount: rawToDecimalString(input.quotedPrice, 6),
    account: {
      ...clone(input.account),
      availableAmountDecimal: rawToDecimalString(input.account.availableAmount, 6),
      reservedAmountDecimal: rawToDecimalString(input.account.reservedAmount, 6)
    },
    entry: {
      ...clone(input.entry),
      amountDecimal: rawToDecimalString(input.entry.amount, 6)
    }
  };
}

function normalizeSettlementMode(
  mode: SettlementMode | null | undefined,
  fallback: SettlementMode = "verified_escrow"
): SettlementMode {
  return mode === "verified_escrow" ? mode : fallback;
}

function settlementModeForNewProviderService(): SettlementMode {
  return "verified_escrow";
}

function normalizePersistedPayoutSplit(
  split: IdempotencyRecord["payoutSplit"] | JobRecord["payoutSplit"]
): IdempotencyRecord["payoutSplit"] {
  const settlementMode = normalizeSettlementMode(
    (split as { settlementMode?: SettlementMode | null }).settlementMode,
    "verified_escrow"
  );
  const legacyMarketplaceWallet = (split as { marketplaceWallet?: string | null }).marketplaceWallet ?? "";
  const paymentDestinationWallet =
    (split as { paymentDestinationWallet?: string | null }).paymentDestinationWallet
    ?? legacyMarketplaceWallet;

  return {
    ...split,
    settlementMode,
    paymentDestinationWallet,
    usesTreasurySettlement:
      (split as { usesTreasurySettlement?: boolean | null }).usesTreasurySettlement
      ?? usesMarketplaceTreasurySettlement(settlementMode)
  };
}

function buildRouteLookupKey(routeId: string, routeVersion: string): string {
  return `${routeId}:${routeVersion}`;
}

function buildRouteRef(provider: string, operation: string): string {
  return `${provider}.${operation}`;
}

function rangeStart(range: BuyerActivityRange): number | null {
  if (range === "all") {
    return null;
  }

  const days = range === "7d" ? 7 : range === "30d" ? 30 : 90;
  return Date.now() - ((days - 1) * 24 * 60 * 60 * 1000);
}

function buyerActivityStatus(input: {
  record: Pick<IdempotencyRecord, "responseKind" | "responseStatusCode">;
  job: Pick<JobRecord, "status"> | null;
  refund: Pick<RefundRecord, "status"> | null;
}): BuyerActivityItemStatus {
  if (input.refund?.status === "sent") {
    return "refunded";
  }

  if (input.refund && input.refund.status !== "failed") {
    return "refund_pending";
  }

  if (input.record.responseKind === "sync") {
    return input.record.responseStatusCode >= 200 && input.record.responseStatusCode < 400
      ? "succeeded"
      : "failed";
  }

  if (input.job?.status === "failed") {
    return "failed";
  }

  return "succeeded";
}

function summarizeBuyerActivity(wallet: string, items: BuyerActivityItem[]): BuyerActivityResponse {
  const totals = items.reduce(
    (accumulator, item) => {
      accumulator.totalSpend += Number(item.amount);
      if (item.refund?.status === "sent") {
        accumulator.totalRefunded += Number(item.refund.amount);
      }
      accumulator.serviceSlugs.add(item.service.slug);
      return accumulator;
    },
    {
      totalSpend: 0,
      totalRefunded: 0,
      serviceSlugs: new Set<string>()
    }
  );

  return {
    wallet,
    summary: {
      totalSpend: totals.totalSpend.toFixed(2),
      totalRefunded: totals.totalRefunded.toFixed(2),
      netSpend: (totals.totalSpend - totals.totalRefunded).toFixed(2),
      paidCallCount: items.length,
      serviceCount: totals.serviceSlugs.size
    },
    items
  };
}

export class InMemoryMarketplaceStore implements MarketplaceStore {
  private readonly idempotencyByPaymentId = new Map<string, IdempotencyRecord>();
  private readonly jobsByToken = new Map<string, JobRecord>();
  private readonly accessGrants = new Map<string, AccessGrantRecord>();
  private readonly refundsById = new Map<string, RefundRecord>();
  private readonly refundsByJobToken = new Map<string, RefundRecord>();
  private readonly refundsByPaymentId = new Map<string, RefundRecord>();
  private readonly providerPayoutsById = new Map<string, ProviderPayoutRecord>();
  private readonly creditAccountsById = new Map<string, CreditAccountRecord>();
  private readonly creditAccountIdByKey = new Map<string, string>();
  private readonly creditEntriesById = new Map<string, CreditLedgerEntryRecord>();
  private readonly creditTopupEntryIdByPaymentKey = new Map<string, string>();
  private readonly creditReservationsById = new Map<string, CreditReservationRecord>();
  private readonly creditReservationIdByIdempotencyKey = new Map<string, string>();
  private readonly creditReservationIdByJobToken = new Map<string, string>();
  private readonly providerRuntimeKeysByServiceId = new Map<string, ProviderRuntimeKeyRecord>();
  private readonly suggestionsById = new Map<string, SuggestionRecord>();
  private readonly attempts: ProviderAttemptRecord[] = [];

  private readonly providerAccountsById = new Map<string, ProviderAccountRecord>();
  private readonly providerAccountIdByWallet = new Map<string, string>();
  private readonly providerServicesById = new Map<string, ProviderServiceRecord>();
  private readonly endpointDraftsById = new Map<string, MarketplaceProviderEndpointDraftRecord>();
  private readonly externalEndpointDraftsById = new Map<string, ExternalProviderEndpointDraftRecord>();
  private readonly verificationByService = new Map<string, ProviderVerificationRecord[]>();
  private readonly reviewsByService = new Map<string, ProviderReviewRecord[]>();
  private readonly providerSecretsById = new Map<string, ProviderSecretRecord>();
  private readonly publishedServicesByVersionId = new Map<string, PublishedServiceVersionRecord>();
  private readonly publishedEndpointsByVersionId = new Map<string, PublishedEndpointVersionRecord>();
  private readonly publishedExternalEndpointsByVersionId = new Map<string, PublishedExternalEndpointVersionRecord>();
  private readonly latestSubmittedVersionByServiceId = new Map<string, string>();
  private readonly latestPublishedVersionByServiceId = new Map<string, string>();
  private readonly networkConfig: MarketplaceNetworkConfig;

  constructor(networkConfig: MarketplaceNetworkConfig = getDefaultMarketplaceNetworkConfig()) {
    this.networkConfig = networkConfig;
    this.seedDefaults();
  }

  async ensureSchema(): Promise<void> {
    this.seedDefaults();
  }

  private seedDefaults() {
    const network = this.networkConfig;
    const account = clone(MARKETPLACE_PROVIDER_ACCOUNT_SEED);
    const services = buildSeededProviderServices(network).map((service) => clone(service));
    const draftEndpoints = buildSeededProviderEndpointDrafts(network).map((endpoint) => clone(endpoint));
    const publishedServices = buildSeededPublishedServiceVersions(network).map((service) => clone(service));
    const publishedEndpoints = buildSeededPublishedEndpointVersions(network).map((endpoint) => clone(endpoint));
    const publishedServiceVersionByServiceId = new Map(
      publishedServices.map((service) => [service.serviceId, service.versionId])
    );

    this.providerAccountsById.set(account.id, account);
    this.providerAccountIdByWallet.set(account.ownerWallet, account.id);
    for (const service of services) {
      this.providerServicesById.set(service.id, service);
    }
    for (const endpoint of draftEndpoints) {
      if (isMarketplaceEndpointDraft(endpoint)) {
        this.endpointDraftsById.set(endpoint.id, endpoint);
      }
    }
    for (const publishedService of publishedServices) {
      this.publishedServicesByVersionId.set(publishedService.versionId, publishedService);
    }
    for (const endpoint of publishedEndpoints) {
      this.publishedEndpointsByVersionId.set(endpoint.endpointVersionId, endpoint);
    }
    for (const service of services) {
      const versionId = publishedServiceVersionByServiceId.get(service.id);
      if (!versionId) {
        continue;
      }

      this.latestSubmittedVersionByServiceId.set(service.id, versionId);
      this.latestPublishedVersionByServiceId.set(service.id, versionId);
    }
  }

  async getIdempotencyByPaymentId(paymentId: string): Promise<IdempotencyRecord | null> {
    return clone(this.idempotencyByPaymentId.get(paymentId) ?? null);
  }

  async claimPaymentExecution(input: ClaimPaymentExecutionInput): Promise<ClaimPaymentExecutionResult> {
    const existing = this.idempotencyByPaymentId.get(input.paymentId);
    if (existing) {
      return {
        record: clone(existing),
        created: false
      };
    }

    const record = buildPendingPaymentExecutionRecord(input, timestamp());
    this.idempotencyByPaymentId.set(record.paymentId, record);

    return {
      record: clone(record),
      created: true
    };
  }

  async touchPendingPaymentExecution(paymentId: string): Promise<IdempotencyRecord | null> {
    const existing = this.idempotencyByPaymentId.get(paymentId);
    if (!existing || existing.executionStatus !== "pending") {
      return clone(existing ?? null);
    }

    const updated: IdempotencyRecord = {
      ...existing,
      updatedAt: timestamp()
    };
    this.idempotencyByPaymentId.set(paymentId, updated);
    return clone(updated);
  }

  async completePendingJobExecution(input: {
    paymentId: string;
    jobToken: string;
    responseBody: unknown;
    responseHeaders?: Record<string, string>;
  }): Promise<IdempotencyRecord | null> {
    const existing = this.idempotencyByPaymentId.get(input.paymentId);
    if (!existing) {
      return null;
    }

    if (existing.executionStatus === "completed") {
      return clone(existing);
    }

    const updated: IdempotencyRecord = {
      ...existing,
      responseKind: "job",
      responseStatusCode: 202,
      responseBody: clone(input.responseBody),
      responseHeaders: clone(input.responseHeaders ?? existing.responseHeaders),
      executionStatus: "completed",
      jobToken: existing.jobToken ?? input.jobToken,
      updatedAt: timestamp()
    };
    this.idempotencyByPaymentId.set(input.paymentId, updated);
    return clone(updated);
  }

  async listStalePendingPaymentExecutions(updatedBefore: string, limit: number): Promise<IdempotencyRecord[]> {
    const cutoff = Date.parse(updatedBefore);
    if (Number.isNaN(cutoff) || limit <= 0) {
      return [];
    }

    return Array.from(this.idempotencyByPaymentId.values())
      .filter((record) => {
        if (record.executionStatus !== "pending") {
          return false;
        }

        const updatedAt = Date.parse(record.updatedAt);
        return !Number.isNaN(updatedAt) && updatedAt <= cutoff;
      })
      .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt))
      .slice(0, limit)
      .map((record) => clone(record));
  }

  async saveSyncIdempotency(input: SaveSyncIdempotencyInput): Promise<IdempotencyRecord> {
    const now = timestamp();
    const existing = this.idempotencyByPaymentId.get(input.paymentId);
    const record: IdempotencyRecord = {
      paymentId: input.paymentId,
      normalizedRequestHash: input.normalizedRequestHash,
      buyerWallet: input.buyerWallet,
      routeId: input.routeId,
      routeVersion: input.routeVersion,
      pendingRecoveryAction: existing?.pendingRecoveryAction ?? "retry",
      quotedPrice: input.quotedPrice,
      payoutSplit: clone(input.payoutSplit),
      paymentPayload: input.paymentPayload,
      facilitatorResponse: clone(input.facilitatorResponse),
      responseKind: "sync",
      responseStatusCode: input.statusCode,
      responseBody: clone(input.body),
      responseHeaders: clone(input.headers ?? {}),
      providerPayoutSourceKind: input.providerPayoutSourceKind ?? null,
      executionStatus: "completed",
      requestId: input.requestId ?? existing?.requestId ?? null,
      jobToken: existing?.jobToken,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    };

    this.idempotencyByPaymentId.set(record.paymentId, record);
    return clone(record);
  }

  async saveAsyncAcceptance(input: SaveAsyncAcceptanceInput): Promise<{ idempotency: IdempotencyRecord; job: JobRecord }> {
    const now = timestamp();
    const existing = this.idempotencyByPaymentId.get(input.paymentId);

    const idempotency: IdempotencyRecord = {
      paymentId: input.paymentId,
      normalizedRequestHash: input.normalizedRequestHash,
      buyerWallet: input.buyerWallet,
      routeId: input.route.routeId,
      routeVersion: input.route.version,
      pendingRecoveryAction: existing?.pendingRecoveryAction ?? "retry",
      quotedPrice: input.quotedPrice,
      payoutSplit: clone(input.payoutSplit),
      paymentPayload: input.paymentPayload,
      facilitatorResponse: clone(input.facilitatorResponse),
      responseKind: "job",
      responseStatusCode: 202,
      responseBody: clone(input.responseBody),
      responseHeaders: clone(input.responseHeaders ?? {}),
      providerPayoutSourceKind: null,
      executionStatus: "completed",
      requestId: input.requestId ?? existing?.requestId ?? null,
      jobToken: existing?.jobToken ?? input.jobToken,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    };

    const existingJob = this.jobsByToken.get(idempotency.jobToken ?? input.jobToken) ?? null;
    const job = buildAcceptedAsyncJobRecord({
      ...input,
      jobToken: idempotency.jobToken ?? input.jobToken
    }, existingJob, now);

    this.idempotencyByPaymentId.set(idempotency.paymentId, idempotency);
    this.jobsByToken.set(job.jobToken, job);
    await this.createAccessGrant({
      resourceType: "job",
      resourceId: job.jobToken,
      wallet: input.buyerWallet,
      paymentId: input.paymentId,
      metadata: {
        routeId: input.route.routeId
      }
    });

    return {
      idempotency: clone(idempotency),
      job: clone(job)
    };
  }

  async savePendingAsyncJob(input: SavePendingAsyncJobInput): Promise<JobRecord> {
    const now = timestamp();
    const existing = this.jobsByToken.get(input.jobToken) ?? null;
    const job = buildPendingAsyncJobRecord(input, existing, now);
    this.jobsByToken.set(job.jobToken, job);
    return clone(job);
  }

  async getJob(jobToken: string): Promise<JobRecord | null> {
    return clone(this.jobsByToken.get(jobToken) ?? null);
  }

  async listPendingJobs(input: { limit: number; now?: string }): Promise<JobRecord[]> {
    if (input.limit <= 0) {
      return [];
    }

    const nowMs = Date.parse(input.now ?? timestamp());
    return clone(
      Array.from(this.jobsByToken.values())
        .filter((job) => isPendingJobActionable(job, nowMs))
        .sort((left, right) => {
          const leftTimedOut = isPendingJobTimedOut(left, nowMs);
          const rightTimedOut = isPendingJobTimedOut(right, nowMs);
          if (leftTimedOut !== rightTimedOut) {
            return leftTimedOut ? -1 : 1;
          }

          const leftAccepted = Boolean(left.providerJobId);
          const rightAccepted = Boolean(right.providerJobId);
          if (leftAccepted !== rightAccepted) {
            return leftAccepted ? -1 : 1;
          }

          return Date.parse(left.createdAt) - Date.parse(right.createdAt);
        })
        .slice(0, input.limit)
    );
  }

  async updateJobPending(input: {
    jobToken: string;
    providerState?: Record<string, unknown> | null;
    nextPollAt?: string | null;
  }): Promise<JobRecord> {
    const existing = this.jobsByToken.get(input.jobToken);
    if (!existing) {
      throw new Error(`Job not found: ${input.jobToken}`);
    }

    const updated: JobRecord = {
      ...existing,
      providerState: input.providerState === undefined ? clone(existing.providerState) : clone(input.providerState),
      nextPollAt: input.nextPollAt === undefined ? existing.nextPollAt : input.nextPollAt,
      updatedAt: timestamp()
    };

    this.jobsByToken.set(input.jobToken, updated);
    return clone(updated);
  }

  async completeJob(jobToken: string, body: unknown): Promise<JobRecord> {
    const existing = this.jobsByToken.get(jobToken);
    if (!existing) {
      throw new Error(`Job not found: ${jobToken}`);
    }

    if (existing.status !== "pending") {
      return clone(existing);
    }

    const updated: JobRecord = {
      ...existing,
      status: "completed",
      resultBody: clone(body),
      errorMessage: null,
      nextPollAt: null,
      updatedAt: timestamp()
    };

    this.jobsByToken.set(jobToken, updated);
    return clone(updated);
  }

  async failJob(jobToken: string, error: string): Promise<JobRecord> {
    const existing = this.jobsByToken.get(jobToken);
    if (!existing) {
      throw new Error(`Job not found: ${jobToken}`);
    }

    if (existing.status !== "pending") {
      return clone(existing);
    }

    const updated: JobRecord = {
      ...existing,
      status: "failed",
      errorMessage: error,
      nextPollAt: null,
      updatedAt: timestamp()
    };

    this.jobsByToken.set(jobToken, updated);
    return clone(updated);
  }

  async createAccessGrant(input: {
    resourceType: ResourceType;
    resourceId: string;
    wallet: string;
    paymentId: string;
    metadata?: Record<string, unknown>;
  }): Promise<AccessGrantRecord> {
    const key = `${input.resourceType}:${input.resourceId}:${input.wallet}`;
    const existing = this.accessGrants.get(key);
    if (existing) {
      return clone(existing);
    }

    const record: AccessGrantRecord = {
      id: randomUUID(),
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      wallet: input.wallet,
      paymentId: input.paymentId,
      metadata: clone(input.metadata ?? {}),
      createdAt: timestamp()
    };

    this.accessGrants.set(key, record);
    return clone(record);
  }

  async getAccessGrant(resourceType: ResourceType, resourceId: string, wallet: string): Promise<AccessGrantRecord | null> {
    return clone(this.accessGrants.get(`${resourceType}:${resourceId}:${wallet}`) ?? null);
  }

  async recordProviderAttempt(input: {
    jobToken?: string | null;
    paymentId?: string | null;
    routeId: string;
    requestId?: string | null;
    responseStatusCode?: number | null;
    phase: "execute" | "poll" | "callback" | "refund";
    status: "pending" | "succeeded" | "failed";
    requestPayload?: unknown;
    responsePayload?: unknown;
    errorMessage?: string;
  }): Promise<ProviderAttemptRecord> {
    const record: ProviderAttemptRecord = {
      id: randomUUID(),
      jobToken: input.jobToken ?? null,
      paymentId: input.paymentId ?? null,
      routeId: input.routeId,
      requestId: input.requestId ?? null,
      responseStatusCode: input.responseStatusCode ?? null,
      phase: input.phase,
      status: input.status,
      requestPayload: clone(input.requestPayload ?? null),
      responsePayload: clone(input.responsePayload ?? null),
      errorMessage: input.errorMessage ?? null,
      createdAt: timestamp()
    };

    this.attempts.push(record);
    return clone(record);
  }

  async getLatestSuccessfulProviderExecuteAttempt(jobToken: string): Promise<ProviderAttemptRecord | null> {
    return clone(
      [...this.attempts]
        .filter((attempt) =>
          attempt.jobToken === jobToken
          && attempt.phase === "execute"
          && attempt.status === "succeeded"
        )
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0]
        ?? null
    );
  }

  async getLatestSuccessfulProviderExecuteAttemptByPaymentId(paymentId: string): Promise<ProviderAttemptRecord | null> {
    return clone(
      [...this.attempts]
        .filter((attempt) =>
          attempt.paymentId === paymentId
          && attempt.phase === "execute"
          && attempt.status === "succeeded"
        )
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0]
        ?? null
    );
  }

  async getLatestProviderExecuteAttempt(jobToken: string): Promise<ProviderAttemptRecord | null> {
    return clone(
      [...this.attempts]
        .filter((attempt) =>
          attempt.jobToken === jobToken
          && attempt.phase === "execute"
        )
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0]
        ?? null
    );
  }

  async createRefund(input: {
    jobToken?: string | null;
    paymentId: string;
    wallet: string;
    amount: string;
  }): Promise<RefundRecord> {
    const existing = this.refundsByPaymentId.get(input.paymentId)
      ?? (input.jobToken ? this.refundsByJobToken.get(input.jobToken) : undefined);
    if (existing) {
      if (input.jobToken && existing.jobToken && existing.jobToken !== input.jobToken) {
        throw new Error("Refund paymentId and jobToken reference different jobs.");
      }

      if (input.jobToken && !existing.jobToken) {
        const updated: RefundRecord = {
          ...existing,
          jobToken: input.jobToken,
          updatedAt: timestamp()
        };
        this.refundsById.set(updated.id, updated);
        this.refundsByPaymentId.set(updated.paymentId, updated);
        this.refundsByJobToken.set(input.jobToken, updated);

        const job = this.jobsByToken.get(input.jobToken);
        if (job) {
          this.jobsByToken.set(input.jobToken, {
            ...job,
            refundStatus: updated.status,
            refundId: updated.id,
            updatedAt: timestamp()
          });
        }

        return clone(updated);
      }

      return clone(existing);
    }

    const record: RefundRecord = {
      id: randomUUID(),
      jobToken: input.jobToken ?? null,
      paymentId: input.paymentId,
      wallet: input.wallet,
      amount: input.amount,
      status: "pending",
      txHash: null,
      errorMessage: null,
      createdAt: timestamp(),
      updatedAt: timestamp()
    };

    this.refundsById.set(record.id, record);
    this.refundsByPaymentId.set(record.paymentId, record);

    if (record.jobToken) {
      this.refundsByJobToken.set(record.jobToken, record);

      const job = this.jobsByToken.get(record.jobToken);
      if (job) {
        this.jobsByToken.set(record.jobToken, {
          ...job,
          refundStatus: "pending",
          refundId: record.id,
          updatedAt: timestamp()
        });
      }
    }

    return clone(record);
  }

  async claimRefundForSend(refundId: string): Promise<RefundRecord | null> {
    const existing = this.refundsById.get(refundId);
    if (
      !existing
      || (
        existing.status !== "pending"
        && !(existing.status === "sending" && isOlderThanRecoveryWindow(existing.updatedAt))
      )
    ) {
      return null;
    }

    const updated: RefundRecord = {
      ...existing,
      status: "sending",
      errorMessage: null,
      updatedAt: timestamp()
    };

    this.refundsById.set(refundId, updated);
    this.refundsByPaymentId.set(updated.paymentId, updated);

    if (updated.jobToken) {
      this.refundsByJobToken.set(updated.jobToken, updated);

      const job = this.jobsByToken.get(updated.jobToken);
      if (job) {
        this.jobsByToken.set(updated.jobToken, {
          ...job,
          refundStatus: "sending",
          refundId,
          updatedAt: timestamp()
        });
      }
    }

    return clone(updated);
  }

  async markRefundSent(refundId: string, txHash: string): Promise<RefundRecord> {
    const existing = this.refundsById.get(refundId);
    if (!existing) {
      throw new Error(`Refund not found: ${refundId}`);
    }

    const updated: RefundRecord = {
      ...existing,
      status: "sent",
      txHash,
      errorMessage: null,
      updatedAt: timestamp()
    };

    this.refundsById.set(refundId, updated);
    this.refundsByPaymentId.set(updated.paymentId, updated);

    if (updated.jobToken) {
      this.refundsByJobToken.set(updated.jobToken, updated);

      const job = this.jobsByToken.get(updated.jobToken);
      if (job) {
        this.jobsByToken.set(updated.jobToken, {
          ...job,
          refundStatus: "sent",
          refundId,
          updatedAt: timestamp()
        });
      }
    }

    return clone(updated);
  }

  async markRefundFailed(refundId: string, errorMessage: string): Promise<RefundRecord> {
    const existing = this.refundsById.get(refundId);
    if (!existing) {
      throw new Error(`Refund not found: ${refundId}`);
    }

    const updated: RefundRecord = {
      ...existing,
      status: "failed",
      errorMessage,
      updatedAt: timestamp()
    };

    this.refundsById.set(refundId, updated);
    this.refundsByPaymentId.set(updated.paymentId, updated);

    if (updated.jobToken) {
      this.refundsByJobToken.set(updated.jobToken, updated);

      const job = this.jobsByToken.get(updated.jobToken);
      if (job) {
        this.jobsByToken.set(updated.jobToken, {
          ...job,
          refundStatus: "failed",
          refundId,
          updatedAt: timestamp()
        });
      }
    }

    return clone(updated);
  }

  async getRefundByJobToken(jobToken: string): Promise<RefundRecord | null> {
    return clone(this.refundsByJobToken.get(jobToken) ?? null);
  }

  async getRefundByPaymentId(paymentId: string): Promise<RefundRecord | null> {
    return clone(this.refundsByPaymentId.get(paymentId) ?? null);
  }

  async createProviderPayout(input: ProviderPayoutInput): Promise<ProviderPayoutRecord> {
    const existing = Array.from(this.providerPayoutsById.values()).find(
      (record) => record.sourceKind === input.sourceKind && record.sourceId === input.sourceId
    );
    if (existing) {
      return clone(existing);
    }

    const record: ProviderPayoutRecord = {
      id: randomUUID(),
      sourceKind: input.sourceKind,
      sourceId: input.sourceId,
      providerAccountId: input.providerAccountId,
      providerWallet: input.providerWallet,
      currency: input.currency,
      amount: input.amount,
      status: "pending",
      txHash: null,
      sentAt: null,
      attemptCount: 0,
      lastError: null,
      createdAt: timestamp(),
      updatedAt: timestamp()
    };
    this.providerPayoutsById.set(record.id, record);
    return clone(record);
  }

  async listRecoverableProviderPayouts(limit: number): Promise<ProviderPayoutInput[]> {
    const recoverable: ProviderPayoutInput[] = [];
    const existingKeys = new Set(
      Array.from(this.providerPayoutsById.values()).map((record) => `${record.sourceKind}:${record.sourceId}`)
    );
    const syncRecords = Array.from(this.idempotencyByPaymentId.values()).sort((left, right) =>
      left.createdAt.localeCompare(right.createdAt)
    );

    const addCandidate = (candidate: ProviderPayoutInput) => {
      const key = `${candidate.sourceKind}:${candidate.sourceId}`;
      if (existingKeys.has(key)) {
        return;
      }

      existingKeys.add(key);
      recoverable.push(clone(candidate));
    };

    for (const record of syncRecords) {
      if (recoverable.length >= limit) {
        return recoverable;
      }

      if (
        record.executionStatus !== "completed"
        || record.responseKind !== "sync"
        || record.responseStatusCode < 200
        || record.responseStatusCode >= 400
        || !record.providerPayoutSourceKind
        || !record.payoutSplit.usesTreasurySettlement
        || !record.payoutSplit.providerWallet
        || BigInt(record.payoutSplit.providerAmount) <= 0n
      ) {
        continue;
      }

      addCandidate({
        sourceKind: record.providerPayoutSourceKind,
        sourceId: record.paymentId,
        providerAccountId: record.payoutSplit.providerAccountId,
        providerWallet: record.payoutSplit.providerWallet,
        currency: record.payoutSplit.currency,
        amount: record.payoutSplit.providerAmount
      });
    }

    const completedJobs = Array.from(this.jobsByToken.values()).sort((left, right) =>
      left.createdAt.localeCompare(right.createdAt)
    );
    for (const job of completedJobs) {
      if (recoverable.length >= limit) {
        break;
      }

      if (
        job.status !== "completed"
        || job.refundStatus !== "not_required"
        || !job.payoutSplit.usesTreasurySettlement
        || !job.payoutSplit.providerWallet
        || BigInt(job.payoutSplit.providerAmount) <= 0n
      ) {
        continue;
      }

      addCandidate({
        sourceKind: "route_charge",
        sourceId: job.jobToken,
        providerAccountId: job.payoutSplit.providerAccountId,
        providerWallet: job.payoutSplit.providerWallet,
        currency: job.payoutSplit.currency,
        amount: job.payoutSplit.providerAmount
      });
    }

    return recoverable;
  }

  async listPendingProviderPayouts(limit: number): Promise<ProviderPayoutRecord[]> {
    return Array.from(this.providerPayoutsById.values())
      .filter((record) => record.status === "pending")
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .slice(0, limit)
      .map((record) => clone(record));
  }

  async claimPendingProviderPayouts(limit: number): Promise<ProviderPayoutRecord[]> {
    const claimed: ProviderPayoutRecord[] = [];
    for (const payout of Array.from(this.providerPayoutsById.values())
      .filter((record) => record.status === "pending" || (record.status === "sending" && isOlderThanRecoveryWindow(record.updatedAt)))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .slice(0, limit)) {
      const next: ProviderPayoutRecord = {
        ...payout,
        status: "sending",
        lastError: null,
        updatedAt: timestamp()
      };
      this.providerPayoutsById.set(next.id, next);
      claimed.push(clone(next));
    }
    return claimed;
  }

  async markProviderPayoutSendFailure(payoutIds: string[], errorMessage: string): Promise<void> {
    for (const payoutId of payoutIds) {
      const existing = this.providerPayoutsById.get(payoutId);
      if (!existing) {
        continue;
      }

      this.providerPayoutsById.set(payoutId, {
        ...existing,
        status: "pending",
        attemptCount: existing.attemptCount + 1,
        lastError: errorMessage,
        updatedAt: timestamp()
      });
    }
  }

  async markProviderPayoutsSent(payoutIds: string[], txHash: string): Promise<ProviderPayoutRecord[]> {
    const updated: ProviderPayoutRecord[] = [];
    for (const payoutId of payoutIds) {
      const existing = this.providerPayoutsById.get(payoutId);
      if (!existing) {
        continue;
      }

      const next: ProviderPayoutRecord = {
        ...existing,
        status: "sent",
        txHash,
        sentAt: timestamp(),
        attemptCount: existing.attemptCount + 1,
        lastError: null,
        updatedAt: timestamp()
      };
      this.providerPayoutsById.set(payoutId, next);
      updated.push(clone(next));
    }
    return updated;
  }

  async completeCreditTopupCharge(
    input: CompleteCreditTopupChargeInput
  ): Promise<{ idempotency: IdempotencyRecord; account: CreditAccountRecord; entry: CreditLedgerEntryRecord }> {
    const now = timestamp();
    const existingIdempotency = this.idempotencyByPaymentId.get(input.paymentId);
    const topupLookupKey = creditTopupKey(input.serviceId, input.paymentId);
    const existingEntryId = this.creditTopupEntryIdByPaymentKey.get(topupLookupKey);

    let account: CreditAccountRecord;
    let entry: CreditLedgerEntryRecord;

    if (existingEntryId) {
      const existingEntry = this.creditEntriesById.get(existingEntryId);
      if (!existingEntry) {
        throw new Error(`Credit top-up entry not found: ${topupLookupKey}`);
      }
      const existingAccount = this.creditAccountsById.get(existingEntry.accountId);
      if (!existingAccount) {
        throw new Error(`Credit account not found: ${existingEntry.accountId}`);
      }
      entry = clone(existingEntry);
      account = clone(existingAccount);
    } else {
      const accountLookupKey = creditAccountKey(input.serviceId, input.buyerWallet, input.payoutSplit.currency);
      const existingAccountId = this.creditAccountIdByKey.get(accountLookupKey);
      const existingAccount = existingAccountId ? this.creditAccountsById.get(existingAccountId) ?? null : null;
      account = existingAccount
        ? {
            ...clone(existingAccount),
            availableAmount: (BigInt(existingAccount.availableAmount) + BigInt(input.quotedPrice)).toString(),
            updatedAt: now
          }
        : {
            id: randomUUID(),
            serviceId: input.serviceId,
            buyerWallet: input.buyerWallet,
            currency: input.payoutSplit.currency,
            availableAmount: input.quotedPrice,
            reservedAmount: "0",
            createdAt: now,
            updatedAt: now
          };
      entry = {
        id: randomUUID(),
        accountId: account.id,
        serviceId: input.serviceId,
        buyerWallet: input.buyerWallet,
        currency: input.payoutSplit.currency,
        kind: "topup",
        amount: input.quotedPrice,
        reservationId: null,
        paymentId: input.paymentId,
        metadata: clone(input.metadata ?? {}),
        createdAt: now
      };
    }

    const responseBody = buildStoredTopupResponseBody({
      routeId: input.routeId,
      serviceId: input.serviceId,
      buyerWallet: input.buyerWallet,
      quotedPrice: input.quotedPrice,
      account,
      entry
    });

    const idempotency: IdempotencyRecord = {
      paymentId: input.paymentId,
      normalizedRequestHash: input.normalizedRequestHash,
      buyerWallet: input.buyerWallet,
      routeId: input.routeId,
      routeVersion: input.routeVersion,
      pendingRecoveryAction: existingIdempotency?.pendingRecoveryAction ?? "retry",
      quotedPrice: input.quotedPrice,
      payoutSplit: clone(input.payoutSplit),
      paymentPayload: input.paymentPayload,
      facilitatorResponse: clone(input.facilitatorResponse),
      responseKind: "sync",
      responseStatusCode: 200,
      responseBody,
      responseHeaders: clone(input.responseHeaders ?? {}),
      providerPayoutSourceKind: "credit_topup",
      executionStatus: "completed",
      requestId: input.requestId ?? existingIdempotency?.requestId ?? null,
      jobToken: existingIdempotency?.jobToken,
      createdAt: existingIdempotency?.createdAt ?? now,
      updatedAt: now
    };

    if (!existingEntryId) {
      this.creditAccountsById.set(account.id, clone(account));
      this.creditAccountIdByKey.set(
        creditAccountKey(input.serviceId, input.buyerWallet, input.payoutSplit.currency),
        account.id
      );
      this.creditEntriesById.set(entry.id, clone(entry));
      this.creditTopupEntryIdByPaymentKey.set(topupLookupKey, entry.id);
    }

    if (
      input.payoutSplit.usesTreasurySettlement
      && BigInt(input.payoutSplit.providerAmount) > 0n
      && input.payoutSplit.providerWallet
    ) {
      const existingPayout = Array.from(this.providerPayoutsById.values()).find(
        (record) => record.sourceKind === "credit_topup" && record.sourceId === input.paymentId
      );
      if (!existingPayout) {
        const payout: ProviderPayoutRecord = {
          id: randomUUID(),
          sourceKind: "credit_topup",
          sourceId: input.paymentId,
          providerAccountId: input.payoutSplit.providerAccountId,
          providerWallet: input.payoutSplit.providerWallet,
          currency: input.payoutSplit.currency,
          amount: input.payoutSplit.providerAmount,
          status: "pending",
          txHash: null,
          sentAt: null,
          attemptCount: 0,
          lastError: null,
          createdAt: now,
          updatedAt: now
        };
        this.providerPayoutsById.set(payout.id, payout);
      }
    }

    this.idempotencyByPaymentId.set(idempotency.paymentId, clone(idempotency));

    return {
      idempotency: clone(idempotency),
      account: clone(account),
      entry: clone(entry)
    };
  }

  async createCreditTopup(input: {
    serviceId: string;
    buyerWallet: string;
    currency: "USDC" | "testUSDC";
    amount: string;
    paymentId: string;
    metadata?: Record<string, unknown>;
  }): Promise<{ account: CreditAccountRecord; entry: CreditLedgerEntryRecord }> {
    const existingEntryId = this.creditTopupEntryIdByPaymentKey.get(creditTopupKey(input.serviceId, input.paymentId));
    const existingEntry = existingEntryId ? this.creditEntriesById.get(existingEntryId) ?? null : null;
    if (existingEntry) {
      const existingAccount = this.creditAccountsById.get(existingEntry.accountId);
      if (!existingAccount) {
        throw new Error(`Credit account not found: ${existingEntry.accountId}`);
      }
      return {
        account: clone(existingAccount),
        entry: clone(existingEntry)
      };
    }

    const key = creditAccountKey(input.serviceId, input.buyerWallet, input.currency);
    const existingAccountId = this.creditAccountIdByKey.get(key);
    const existingAccount = existingAccountId ? this.creditAccountsById.get(existingAccountId) ?? null : null;
    const now = timestamp();
    const account: CreditAccountRecord = existingAccount
      ? {
          ...existingAccount,
          availableAmount: (BigInt(existingAccount.availableAmount) + BigInt(input.amount)).toString(),
          updatedAt: now
        }
      : {
          id: randomUUID(),
          serviceId: input.serviceId,
          buyerWallet: input.buyerWallet,
          currency: input.currency,
          availableAmount: input.amount,
          reservedAmount: "0",
          createdAt: now,
          updatedAt: now
        };

    this.creditAccountsById.set(account.id, account);
    this.creditAccountIdByKey.set(key, account.id);

    const entry: CreditLedgerEntryRecord = {
      id: randomUUID(),
      accountId: account.id,
      serviceId: input.serviceId,
      buyerWallet: input.buyerWallet,
      currency: input.currency,
      kind: "topup",
      amount: input.amount,
      reservationId: null,
      paymentId: input.paymentId,
      metadata: clone(input.metadata ?? {}),
      createdAt: now
    };
    this.creditEntriesById.set(entry.id, entry);
    this.creditTopupEntryIdByPaymentKey.set(creditTopupKey(input.serviceId, input.paymentId), entry.id);

    return {
      account: clone(account),
      entry: clone(entry)
    };
  }

  async getCreditTopupByPaymentId(
    serviceId: string,
    paymentId: string
  ): Promise<{ account: CreditAccountRecord; entry: CreditLedgerEntryRecord } | null> {
    const entryId = this.creditTopupEntryIdByPaymentKey.get(creditTopupKey(serviceId, paymentId));
    if (!entryId) {
      return null;
    }

    const entry = this.creditEntriesById.get(entryId);
    if (!entry) {
      return null;
    }

    const account = this.creditAccountsById.get(entry.accountId);
    if (!account) {
      return null;
    }

    return {
      account: clone(account),
      entry: clone(entry)
    };
  }

  async getCreditAccount(serviceId: string, buyerWallet: string, currency: "USDC" | "testUSDC"): Promise<CreditAccountRecord | null> {
    const accountId = this.creditAccountIdByKey.get(creditAccountKey(serviceId, buyerWallet, currency));
    return clone(accountId ? this.creditAccountsById.get(accountId) ?? null : null);
  }

  async reserveCredit(input: {
    serviceId: string;
    buyerWallet: string;
    currency: "USDC" | "testUSDC";
    amount: string;
    idempotencyKey: string;
    jobToken?: string | null;
    requestId?: string | null;
    paymentId?: string | null;
    providerReference?: string | null;
    expiresAt: string;
    metadata?: Record<string, unknown>;
  }): Promise<{ account: CreditAccountRecord; reservation: CreditReservationRecord; entry: CreditLedgerEntryRecord }> {
    const existingReservationIdByIdempotency = this.creditReservationIdByIdempotencyKey.get(
      creditReservationKey(input.serviceId, input.idempotencyKey)
    );
    const existingReservationIdByJobToken = input.jobToken
      ? this.creditReservationIdByJobToken.get(creditReservationJobTokenKey(input.serviceId, input.jobToken))
      : null;
    if (
      existingReservationIdByIdempotency
      && existingReservationIdByJobToken
      && existingReservationIdByIdempotency !== existingReservationIdByJobToken
    ) {
      throw new Error("Credit reservation idempotencyKey and jobToken reference different reservations.");
    }

    const existingReservationId = existingReservationIdByJobToken ?? existingReservationIdByIdempotency;
    if (existingReservationId) {
      const existingReservation = this.creditReservationsById.get(existingReservationId);
      if (!existingReservation) {
        throw new Error(`Credit reservation not found: ${existingReservationId}`);
      }
      if (existingReservation.status === "reserved" && Date.parse(existingReservation.expiresAt) <= Date.now()) {
        await this.expireCreditReservation(existingReservation.id);
      }
      const reservation = this.creditReservationsById.get(existingReservationId);
      if (reservation && (reservation.status === "reserved" || reservation.status === "captured")) {
        const account = this.creditAccountsById.get(reservation.accountId);
        if (!account) {
          throw new Error(`Credit account not found: ${reservation.accountId}`);
        }
        const entry = Array.from(this.creditEntriesById.values())
          .filter((candidate) => candidate.reservationId === reservation.id && candidate.kind === "reserve")
          .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
        if (!entry) {
          throw new Error(`Credit reserve entry not found: ${reservation.id}`);
        }
        return {
          account: clone(account),
          reservation: clone(reservation),
          entry: clone(entry)
        };
      }
    }

    const account = await this.getCreditAccount(input.serviceId, input.buyerWallet, input.currency);
    if (!account) {
      throw new Error("Credit account not found.");
    }
    if (BigInt(account.availableAmount) < BigInt(input.amount)) {
      throw new Error("Insufficient prepaid credit.");
    }

    const updatedAccount: CreditAccountRecord = {
      ...account,
      availableAmount: (BigInt(account.availableAmount) - BigInt(input.amount)).toString(),
      reservedAmount: (BigInt(account.reservedAmount) + BigInt(input.amount)).toString(),
      updatedAt: timestamp()
    };
    this.creditAccountsById.set(updatedAccount.id, updatedAccount);

    const reservation: CreditReservationRecord = {
      id: randomUUID(),
      accountId: updatedAccount.id,
      serviceId: input.serviceId,
      buyerWallet: input.buyerWallet,
      currency: input.currency,
      idempotencyKey: input.idempotencyKey,
      jobToken: input.jobToken ?? null,
      requestId: input.requestId ?? null,
      paymentId: input.paymentId ?? null,
      providerReference: input.providerReference ?? null,
      status: "reserved",
      reservedAmount: input.amount,
      capturedAmount: "0",
      expiresAt: input.expiresAt,
      createdAt: timestamp(),
      updatedAt: timestamp()
    };
    this.creditReservationsById.set(reservation.id, reservation);
    this.creditReservationIdByIdempotencyKey.set(creditReservationKey(input.serviceId, input.idempotencyKey), reservation.id);
    if (reservation.jobToken) {
      this.creditReservationIdByJobToken.set(creditReservationJobTokenKey(input.serviceId, reservation.jobToken), reservation.id);
    }

    const entry: CreditLedgerEntryRecord = {
      id: randomUUID(),
      accountId: updatedAccount.id,
      serviceId: input.serviceId,
      buyerWallet: input.buyerWallet,
      currency: input.currency,
      kind: "reserve",
      amount: input.amount,
      reservationId: reservation.id,
      paymentId: null,
      metadata: clone(input.metadata ?? {}),
      createdAt: timestamp()
    };
    this.creditEntriesById.set(entry.id, entry);

    return {
      account: clone(updatedAccount),
      reservation: clone(reservation),
      entry: clone(entry)
    };
  }

  async captureCreditReservation(input: {
    reservationId: string;
    amount: string;
    metadata?: Record<string, unknown>;
  }): Promise<{
    account: CreditAccountRecord;
    reservation: CreditReservationRecord;
    captureEntry: CreditLedgerEntryRecord;
    releaseEntry: CreditLedgerEntryRecord | null;
  }> {
    const existing = this.creditReservationsById.get(input.reservationId);
    if (!existing) {
      throw new Error(`Credit reservation not found: ${input.reservationId}`);
    }
    if (existing.status === "reserved" && Date.parse(existing.expiresAt) <= Date.now()) {
      await this.expireCreditReservation(existing.id);
    }
    const reservation = this.creditReservationsById.get(input.reservationId);
    if (!reservation) {
      throw new Error(`Credit reservation not found: ${input.reservationId}`);
    }
    const account = this.creditAccountsById.get(reservation.accountId);
    if (!account) {
      throw new Error(`Credit account not found: ${reservation.accountId}`);
    }
    if (reservation.status === "captured") {
      const captureEntry = Array.from(this.creditEntriesById.values()).find(
        (entry) => entry.reservationId === reservation.id && entry.kind === "capture"
      );
      if (!captureEntry) {
        throw new Error(`Capture entry not found for ${reservation.id}`);
      }
      const releaseEntry = Array.from(this.creditEntriesById.values()).find(
        (entry) => entry.reservationId === reservation.id && entry.kind === "release"
      ) ?? null;
      return {
        account: clone(account),
        reservation: clone(reservation),
        captureEntry: clone(captureEntry),
        releaseEntry: clone(releaseEntry)
      };
    }
    if (reservation.status !== "reserved") {
      throw new Error(`Credit reservation cannot be captured from status ${reservation.status}.`);
    }
    if (BigInt(input.amount) > BigInt(reservation.reservedAmount)) {
      throw new Error("Captured amount cannot exceed reserved amount.");
    }

    const remainder = (BigInt(reservation.reservedAmount) - BigInt(input.amount)).toString();
    const updatedAccount: CreditAccountRecord = {
      ...account,
      availableAmount: (BigInt(account.availableAmount) + BigInt(remainder)).toString(),
      reservedAmount: (BigInt(account.reservedAmount) - BigInt(reservation.reservedAmount)).toString(),
      updatedAt: timestamp()
    };
    this.creditAccountsById.set(updatedAccount.id, updatedAccount);

    const updatedReservation: CreditReservationRecord = {
      ...reservation,
      status: "captured",
      capturedAmount: input.amount,
      updatedAt: timestamp()
    };
    this.creditReservationsById.set(updatedReservation.id, updatedReservation);

    const captureEntry: CreditLedgerEntryRecord = {
      id: randomUUID(),
      accountId: updatedAccount.id,
      serviceId: updatedReservation.serviceId,
      buyerWallet: updatedReservation.buyerWallet,
      currency: updatedReservation.currency,
      kind: "capture",
      amount: input.amount,
      reservationId: updatedReservation.id,
      paymentId: null,
      metadata: clone(input.metadata ?? {}),
      createdAt: timestamp()
    };
    this.creditEntriesById.set(captureEntry.id, captureEntry);

    let releaseEntry: CreditLedgerEntryRecord | null = null;
    if (BigInt(remainder) > 0n) {
      releaseEntry = {
        id: randomUUID(),
        accountId: updatedAccount.id,
        serviceId: updatedReservation.serviceId,
        buyerWallet: updatedReservation.buyerWallet,
        currency: updatedReservation.currency,
        kind: "release",
        amount: remainder,
        reservationId: updatedReservation.id,
        paymentId: null,
        metadata: clone(input.metadata ?? {}),
        createdAt: timestamp()
      };
      this.creditEntriesById.set(releaseEntry.id, releaseEntry);
    }

    return {
      account: clone(updatedAccount),
      reservation: clone(updatedReservation),
      captureEntry: clone(captureEntry),
      releaseEntry: clone(releaseEntry)
    };
  }

  async releaseCreditReservation(input: {
    reservationId: string;
    metadata?: Record<string, unknown>;
  }): Promise<{ account: CreditAccountRecord; reservation: CreditReservationRecord; entry: CreditLedgerEntryRecord | null }> {
    const existing = this.creditReservationsById.get(input.reservationId);
    if (!existing) {
      throw new Error(`Credit reservation not found: ${input.reservationId}`);
    }
    const account = this.creditAccountsById.get(existing.accountId);
    if (!account) {
      throw new Error(`Credit account not found: ${existing.accountId}`);
    }
    if (existing.status !== "reserved") {
      return {
        account: clone(account),
        reservation: clone(existing),
        entry: null
      };
    }

    const updatedAccount: CreditAccountRecord = {
      ...account,
      availableAmount: (BigInt(account.availableAmount) + BigInt(existing.reservedAmount)).toString(),
      reservedAmount: (BigInt(account.reservedAmount) - BigInt(existing.reservedAmount)).toString(),
      updatedAt: timestamp()
    };
    this.creditAccountsById.set(updatedAccount.id, updatedAccount);

    const updatedReservation: CreditReservationRecord = {
      ...existing,
      status: "released",
      updatedAt: timestamp()
    };
    this.creditReservationsById.set(updatedReservation.id, updatedReservation);
    this.creditReservationIdByIdempotencyKey.delete(creditReservationKey(updatedReservation.serviceId, updatedReservation.idempotencyKey));
    if (updatedReservation.jobToken) {
      this.creditReservationIdByJobToken.delete(creditReservationJobTokenKey(updatedReservation.serviceId, updatedReservation.jobToken));
    }

    const entry: CreditLedgerEntryRecord = {
      id: randomUUID(),
      accountId: updatedAccount.id,
      serviceId: updatedReservation.serviceId,
      buyerWallet: updatedReservation.buyerWallet,
      currency: updatedReservation.currency,
      kind: "release",
      amount: existing.reservedAmount,
      reservationId: updatedReservation.id,
      paymentId: null,
      metadata: clone(input.metadata ?? {}),
      createdAt: timestamp()
    };
    this.creditEntriesById.set(entry.id, entry);

    return {
      account: clone(updatedAccount),
      reservation: clone(updatedReservation),
      entry: clone(entry)
    };
  }

  async expireCreditReservation(reservationId: string): Promise<{
    account: CreditAccountRecord;
    reservation: CreditReservationRecord;
    entry: CreditLedgerEntryRecord | null;
  }> {
    const existing = this.creditReservationsById.get(reservationId);
    if (!existing) {
      throw new Error(`Credit reservation not found: ${reservationId}`);
    }
    if (existing.status !== "reserved") {
      const account = this.creditAccountsById.get(existing.accountId);
      if (!account) {
        throw new Error(`Credit account not found: ${existing.accountId}`);
      }
      return {
        account: clone(account),
        reservation: clone(existing),
        entry: null
      };
    }

    const released = await this.releaseCreditReservation({
      reservationId,
      metadata: {
        reason: "expired"
      }
    });
    const expiredReservation: CreditReservationRecord = {
      ...released.reservation,
      status: "expired",
      updatedAt: timestamp()
    };
    this.creditReservationsById.set(expiredReservation.id, expiredReservation);
    this.creditReservationIdByIdempotencyKey.delete(creditReservationKey(expiredReservation.serviceId, expiredReservation.idempotencyKey));
    if (expiredReservation.jobToken) {
      this.creditReservationIdByJobToken.delete(creditReservationJobTokenKey(expiredReservation.serviceId, expiredReservation.jobToken));
    }
    return {
      account: clone(released.account),
      reservation: clone(expiredReservation),
      entry: clone(released.entry)
    };
  }

  async reverseCapturedCreditReservation(input: {
    reservationId: string;
    metadata?: Record<string, unknown>;
  }): Promise<{ account: CreditAccountRecord; reservation: CreditReservationRecord; entry: CreditLedgerEntryRecord | null }> {
    const existing = this.creditReservationsById.get(input.reservationId);
    if (!existing) {
      throw new Error(`Credit reservation not found: ${input.reservationId}`);
    }
    const account = this.creditAccountsById.get(existing.accountId);
    if (!account) {
      throw new Error(`Credit account not found: ${existing.accountId}`);
    }
    if (existing.status !== "captured") {
      return {
        account: clone(account),
        reservation: clone(existing),
        entry: null
      };
    }

    const updatedAccount: CreditAccountRecord = {
      ...account,
      availableAmount: (BigInt(account.availableAmount) + BigInt(existing.capturedAmount)).toString(),
      updatedAt: timestamp()
    };
    this.creditAccountsById.set(updatedAccount.id, updatedAccount);

    const updatedReservation: CreditReservationRecord = {
      ...existing,
      status: "reversed",
      updatedAt: timestamp()
    };
    this.creditReservationsById.set(updatedReservation.id, updatedReservation);
    this.creditReservationIdByIdempotencyKey.delete(creditReservationKey(updatedReservation.serviceId, updatedReservation.idempotencyKey));
    if (updatedReservation.jobToken) {
      this.creditReservationIdByJobToken.delete(creditReservationJobTokenKey(updatedReservation.serviceId, updatedReservation.jobToken));
    }

    const entry: CreditLedgerEntryRecord = {
      id: randomUUID(),
      accountId: updatedAccount.id,
      serviceId: updatedReservation.serviceId,
      buyerWallet: updatedReservation.buyerWallet,
      currency: updatedReservation.currency,
      kind: "restore",
      amount: updatedReservation.capturedAmount,
      reservationId: updatedReservation.id,
      paymentId: updatedReservation.paymentId,
      metadata: clone(input.metadata ?? {}),
      createdAt: timestamp()
    };
    this.creditEntriesById.set(entry.id, entry);

    return {
      account: clone(updatedAccount),
      reservation: clone(updatedReservation),
      entry: clone(entry)
    };
  }

  async getCreditReservationById(reservationId: string): Promise<CreditReservationRecord | null> {
    return clone(this.creditReservationsById.get(reservationId) ?? null);
  }

  async getCreditReservationByIdempotencyKey(serviceId: string, idempotencyKey: string): Promise<CreditReservationRecord | null> {
    const reservationId = this.creditReservationIdByIdempotencyKey.get(creditReservationKey(serviceId, idempotencyKey));
    if (reservationId) {
      return clone(this.creditReservationsById.get(reservationId) ?? null);
    }
    return clone(
      Array.from(this.creditReservationsById.values())
        .filter((reservation) => reservation.serviceId === serviceId && reservation.idempotencyKey === idempotencyKey)
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0]
        ?? null
    );
  }

  async getCreditReservationByJobToken(serviceId: string, jobToken: string): Promise<CreditReservationRecord | null> {
    const reservationId = this.creditReservationIdByJobToken.get(creditReservationJobTokenKey(serviceId, jobToken));
    if (reservationId) {
      return clone(this.creditReservationsById.get(reservationId) ?? null);
    }
    return clone(
      Array.from(this.creditReservationsById.values())
        .filter((reservation) => reservation.serviceId === serviceId && reservation.jobToken === jobToken)
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0]
        ?? null
    );
  }

  async listExpiredCreditReservations(limit: number, expiresBefore: string = new Date().toISOString()): Promise<CreditReservationRecord[]> {
    const boundary = Date.parse(expiresBefore);
    return Array.from(this.creditReservationsById.values())
      .filter((reservation) => reservation.status === "reserved" && Date.parse(reservation.expiresAt) <= boundary)
      .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt))
      .slice(0, limit)
      .map((reservation) => clone(reservation));
  }

  async extendCreditReservation(input: {
    reservationId: string;
    expiresAt: string;
  }): Promise<{ account: CreditAccountRecord; reservation: CreditReservationRecord }> {
    const reservation = this.creditReservationsById.get(input.reservationId);
    if (!reservation) {
      throw new Error(`Credit reservation not found: ${input.reservationId}`);
    }

    const account = this.creditAccountsById.get(reservation.accountId);
    if (!account) {
      throw new Error(`Credit account not found: ${reservation.accountId}`);
    }

    const updatedReservation: CreditReservationRecord = {
      ...reservation,
      expiresAt: input.expiresAt,
      updatedAt: timestamp()
    };
    this.creditReservationsById.set(updatedReservation.id, updatedReservation);

    return {
      account: clone(account),
      reservation: clone(updatedReservation)
    };
  }

  async rotateProviderRuntimeKey(serviceId: string, wallet: string, secretMaterial: {
    keyHash: string;
    keyPrefix: string;
    ciphertext: string;
    iv: string;
    authTag: string;
  }): Promise<ProviderRuntimeKeyRecord> {
    const detail = await this.getProviderServiceForOwner(serviceId, wallet);
    if (!detail) {
      throw new Error("Provider service not found.");
    }

    const record: ProviderRuntimeKeyRecord = {
      id: randomUUID(),
      serviceId,
      keyPrefix: secretMaterial.keyPrefix,
      keyHash: secretMaterial.keyHash,
      secretCiphertext: secretMaterial.ciphertext,
      iv: secretMaterial.iv,
      authTag: secretMaterial.authTag,
      createdAt: timestamp(),
      updatedAt: timestamp()
    };
    this.providerRuntimeKeysByServiceId.set(serviceId, record);
    return clone(record);
  }

  async getProviderRuntimeKeyForOwner(serviceId: string, wallet: string): Promise<ProviderRuntimeKeyRecord | null> {
    const detail = await this.getProviderServiceForOwner(serviceId, wallet);
    if (!detail) {
      return null;
    }
    return clone(this.providerRuntimeKeysByServiceId.get(serviceId) ?? null);
  }

  async getProviderRuntimeKeyByPlaintext(plaintextKey: string): Promise<ProviderRuntimeKeyRecord | null> {
    const keyHash = hashProviderRuntimeKey(plaintextKey);
    const match = Array.from(this.providerRuntimeKeysByServiceId.values()).find((record) => record.keyHash === keyHash);
    return clone(match ?? null);
  }

  async listBuyerActivity(input: {
    wallet: string;
    range: BuyerActivityRange;
    limit: number;
  }): Promise<BuyerActivityResponse> {
    const minimumCreatedAtMs = rangeStart(input.range);
    const routesByKey = new Map<string, PublishedEndpointVersionRecord>();
    const servicesByVersionId = new Map<string, PublishedServiceVersionRecord>();

    for (const route of this.publishedEndpointsByVersionId.values()) {
      routesByKey.set(buildRouteLookupKey(route.routeId, route.version), route);
    }

    for (const service of this.publishedServicesByVersionId.values()) {
      servicesByVersionId.set(service.versionId, service);
    }

    const items = Array.from(this.idempotencyByPaymentId.values())
      .filter((record) => {
        if (record.buyerWallet !== input.wallet || record.executionStatus !== "completed") {
          return false;
        }

        if (minimumCreatedAtMs === null) {
          return true;
        }

        return Date.parse(record.createdAt) >= minimumCreatedAtMs;
      })
      .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))
      .slice(0, input.limit)
      .map((record) => {
        const route = routesByKey.get(buildRouteLookupKey(record.routeId, record.routeVersion)) ?? null;
        const service = route ? servicesByVersionId.get(route.serviceVersionId) ?? null : null;
        const job = Array.from(this.jobsByToken.values()).find((candidate) => candidate.paymentId === record.paymentId) ?? null;
        const refund = this.refundsByPaymentId.get(record.paymentId) ?? null;

        return {
          paymentId: record.paymentId,
          kind: record.providerPayoutSourceKind === "credit_topup" ? "credit_topup" : "route_charge",
          status: buyerActivityStatus({ record, job, refund }),
          amount: rawToDecimalString(record.quotedPrice, 6),
          tokenSymbol: record.payoutSplit.currency,
          createdAt: record.createdAt,
          service: {
            slug: service?.slug ?? route?.serviceId ?? "unknown-service",
            name: service?.name ?? "Unknown service"
          },
          route: {
            ref: route ? buildRouteRef(route.provider, route.operation) : record.routeId,
            title: route?.title ?? record.routeId,
            mode: route?.mode ?? (job ? "async" : "sync"),
            billingType: route?.billing.type ?? "fixed_x402"
          },
          job: job
            ? {
                jobToken: job.jobToken,
                status: job.status
              }
            : null,
          refund: refund
            ? {
                status: refund.status,
                amount: rawToDecimalString(refund.amount, 6),
                txHash: refund.txHash
              }
            : null
        } satisfies BuyerActivityItem;
      });

    return summarizeBuyerActivity(input.wallet, items);
  }

  async getServiceAnalytics(routeIds: string[]): Promise<ServiceAnalytics> {
    return computeServiceAnalytics({
      routeIds,
      idempotencyRecords: Array.from(this.idempotencyByPaymentId.values()),
      jobs: Array.from(this.jobsByToken.values()),
      providerAttempts: this.attempts
    });
  }

  async listPublishedServices(): Promise<PublishedServiceVersionRecord[]> {
    const published: PublishedServiceVersionRecord[] = [];

    for (const service of this.providerServicesById.values()) {
      if (service.status !== "published") {
        continue;
      }

      const versionId = this.latestPublishedVersionByServiceId.get(service.id);
      if (!versionId) {
        continue;
      }

      const version = this.publishedServicesByVersionId.get(versionId);
      if (version) {
        published.push(mapPublishedServiceToDefinition(version));
      }
    }

    return published.sort((left, right) => left.name.localeCompare(right.name));
  }

  async getPublishedServiceBySlug(slug: string): Promise<{
    service: PublishedServiceVersionRecord;
    endpoints: PublishedServiceEndpointVersionRecord[];
  } | null> {
    let version: PublishedServiceVersionRecord | null = null;
    let versionId: string | null = null;

    for (const service of this.providerServicesById.values()) {
      if (service.status !== "published") {
        continue;
      }

      const candidateVersionId = this.latestPublishedVersionByServiceId.get(service.id);
      if (!candidateVersionId) {
        continue;
      }

      const candidateVersion = this.publishedServicesByVersionId.get(candidateVersionId);
      if (!candidateVersion || candidateVersion.slug !== slug) {
        continue;
      }

      version = candidateVersion;
      versionId = candidateVersionId;
      break;
    }

    if (!version || !versionId) {
      return null;
    }

    const endpoints: PublishedServiceEndpointVersionRecord[] = [
      ...Array.from(this.publishedEndpointsByVersionId.values()).filter(
        (endpoint) => endpoint.serviceVersionId === versionId
      ),
      ...Array.from(this.publishedExternalEndpointsByVersionId.values()).filter(
        (endpoint) => endpoint.serviceVersionId === versionId
      )
    ];

    return {
      service: clone(version),
      endpoints: endpoints.map((endpoint) => clone(endpoint))
    };
  }

  async listPublishedRoutes(): Promise<PublishedEndpointVersionRecord[]> {
    const publishedServices = await this.listPublishedServices();
    const activeVersionIds = new Set(publishedServices.map((service) => service.versionId));

    return Array.from(this.publishedEndpointsByVersionId.values())
      .filter((endpoint) => activeVersionIds.has(endpoint.serviceVersionId))
      .map((endpoint) => clone(endpoint));
  }

  async findPublishedRoute(provider: string, operation: string, network: MarketplaceRoute["network"]): Promise<PublishedEndpointVersionRecord | null> {
    const routes = await this.listPublishedRoutes();
    return clone(
      routes.find(
        (route) =>
          route.provider === provider &&
          route.operation === operation &&
          route.network === network
      ) ?? null
    );
  }

  async getProviderAccountByWallet(wallet: string): Promise<ProviderAccountRecord | null> {
    const id = this.providerAccountIdByWallet.get(wallet);
    if (!id) {
      return null;
    }

    return clone(this.providerAccountsById.get(id) ?? null);
  }

  async upsertProviderAccount(wallet: string, input: UpsertProviderAccountInput): Promise<ProviderAccountRecord> {
    const existing = await this.getProviderAccountByWallet(wallet);
    if (existing) {
      const updated: ProviderAccountRecord = {
        ...existing,
        displayName: input.displayName,
        bio: input.bio ?? null,
        websiteUrl: input.websiteUrl ?? null,
        contactEmail: input.contactEmail ?? null,
        updatedAt: timestamp()
      };
      this.providerAccountsById.set(updated.id, updated);
      return clone(updated);
    }

    const record: ProviderAccountRecord = {
      id: randomUUID(),
      ownerWallet: wallet,
      displayName: input.displayName,
      bio: input.bio ?? null,
      websiteUrl: input.websiteUrl ?? null,
      contactEmail: input.contactEmail ?? null,
      createdAt: timestamp(),
      updatedAt: timestamp()
    };
    this.providerAccountsById.set(record.id, record);
    this.providerAccountIdByWallet.set(wallet, record.id);
    return clone(record);
  }

  async listProviderServices(wallet: string): Promise<ProviderServiceDetailRecord[]> {
    const account = await this.getProviderAccountByWallet(wallet);
    if (!account) {
      return [];
    }

    return sortByUpdatedDesc(
      Array.from(this.providerServicesById.values()).filter((service) => service.providerAccountId === account.id)
    ).map((service) => this.buildProviderServiceDetail(service.id));
  }

  async createProviderService(wallet: string, input: CreateProviderServiceInput): Promise<ProviderServiceDetailRecord> {
    const account = await this.getProviderAccountByWallet(wallet);
    if (!account) {
      throw new Error("Provider account not found.");
    }

    this.assertServiceUniqueness(input.slug, input.apiNamespace ?? null);

    const record: ProviderServiceRecord = {
      id: randomUUID(),
      providerAccountId: account.id,
      serviceType: input.serviceType,
      settlementMode: isMarketplaceServiceType(input.serviceType) ? settlementModeForNewProviderService() : null,
      slug: input.slug,
      apiNamespace: isMarketplaceServiceType(input.serviceType) ? input.apiNamespace ?? null : null,
      name: input.name,
      tagline: input.tagline,
      about: input.about,
      categories: clone(input.categories),
      promptIntro: input.promptIntro,
      setupInstructions: clone(input.setupInstructions),
      websiteUrl: input.websiteUrl ?? account.websiteUrl ?? null,
      payoutWallet: isMarketplaceServiceType(input.serviceType) ? input.payoutWallet ?? null : null,
      featured: Boolean(input.featured),
      status: "draft",
      createdAt: timestamp(),
      updatedAt: timestamp()
    };

    this.providerServicesById.set(record.id, record);
    return this.buildProviderServiceDetail(record.id);
  }

  async getProviderServiceForOwner(serviceId: string, wallet: string): Promise<ProviderServiceDetailRecord | null> {
    if (!this.providerServicesById.has(serviceId)) {
      return null;
    }

    const detail = this.buildProviderServiceDetail(serviceId);
    if (detail.account.ownerWallet !== wallet) {
      return null;
    }

    return detail;
  }

  async updateProviderServiceForOwner(
    serviceId: string,
    wallet: string,
    input: UpdateProviderServiceInput
  ): Promise<ProviderServiceRecord | null> {
    const detail = await this.getProviderServiceForOwner(serviceId, wallet);
    if (!detail) {
      return null;
    }

    const nextServiceType = input.serviceType ?? detail.service.serviceType;
    if (nextServiceType !== detail.service.serviceType) {
      if (
        detail.endpoints.length > 0
        || this.latestSubmittedVersionByServiceId.has(serviceId)
        || this.latestPublishedVersionByServiceId.has(serviceId)
        || this.providerRuntimeKeysByServiceId.has(serviceId)
      ) {
        throw new Error("serviceType can only change before endpoints, runtime keys, or published versions exist.");
      }
    }

    const nextApiNamespace = isMarketplaceServiceType(nextServiceType)
      ? (input.apiNamespace === undefined ? detail.service.apiNamespace : input.apiNamespace)
      : null;
    const nextPayoutWallet = isMarketplaceServiceType(nextServiceType)
      ? (input.payoutWallet === undefined ? detail.service.payoutWallet : input.payoutWallet)
      : null;
    const updated: ProviderServiceRecord = {
      ...detail.service,
      serviceType: nextServiceType,
      settlementMode: isMarketplaceServiceType(nextServiceType)
        ? (nextServiceType === detail.service.serviceType
          ? detail.service.settlementMode ?? settlementModeForNewProviderService()
          : settlementModeForNewProviderService())
        : null,
      slug: input.slug ?? detail.service.slug,
      apiNamespace: nextApiNamespace,
      name: input.name ?? detail.service.name,
      tagline: input.tagline ?? detail.service.tagline,
      about: input.about ?? detail.service.about,
      categories: input.categories ? clone(input.categories) : detail.service.categories,
      promptIntro: input.promptIntro ?? detail.service.promptIntro,
      setupInstructions: input.setupInstructions ? clone(input.setupInstructions) : detail.service.setupInstructions,
      websiteUrl: input.websiteUrl === undefined ? detail.service.websiteUrl : input.websiteUrl,
      payoutWallet: nextPayoutWallet,
      featured: input.featured ?? detail.service.featured,
      updatedAt: timestamp()
    };

    this.assertServiceUniqueness(updated.slug, updated.apiNamespace, updated.id);
    this.providerServicesById.set(updated.id, updated);

    if (updated.payoutWallet !== detail.service.payoutWallet) {
      for (const [endpointId, endpoint] of this.endpointDraftsById.entries()) {
        if (endpoint.serviceId !== serviceId) {
          continue;
        }

        this.endpointDraftsById.set(endpointId, {
          ...endpoint,
          payout: {
            ...endpoint.payout,
            providerWallet: updated.payoutWallet
          },
          updatedAt: timestamp()
        });
      }
    }

    return clone(updated);
  }

  async createProviderEndpointDraft(
    serviceId: string,
    wallet: string,
    input: CreateProviderEndpointDraftInput,
    secretMaterial?: { label: string; ciphertext: string; iv: string; authTag: string } | null
  ): Promise<ProviderEndpointDraftRecord> {
    const detail = await this.getProviderServiceForOwner(serviceId, wallet);
    if (!detail) {
      throw new Error("Provider service not found.");
    }

    if (detail.service.serviceType === "external_registry") {
      if (input.endpointType !== "external_registry") {
        throw new Error("External services only accept external endpoint drafts.");
      }

      if (detail.endpoints.some((endpoint) =>
        isExternalEndpointDraft(endpoint)
        && endpoint.method === input.method
        && endpoint.publicUrl === input.publicUrl
      )) {
        throw new Error(`External endpoint already exists: ${input.method} ${input.publicUrl}`);
      }

      const record: ExternalProviderEndpointDraftRecord = {
        endpointType: "external_registry",
        id: randomUUID(),
        serviceId,
        routeId: null,
        operation: null,
        title: input.title,
        description: input.description,
        price: null,
        billing: null,
        mode: null,
        requestSchemaJson: null,
        responseSchemaJson: null,
        method: input.method,
        publicUrl: input.publicUrl,
        docsUrl: input.docsUrl,
        authNotes: input.authNotes ?? null,
        requestExample: clone(input.requestExample),
        responseExample: clone(input.responseExample),
        usageNotes: input.usageNotes ?? null,
        executorKind: null,
        upstreamBaseUrl: null,
        upstreamPath: null,
        upstreamAuthMode: null,
        upstreamAuthHeaderName: null,
        upstreamSecretRef: null,
        hasUpstreamSecret: false,
        payout: null,
        createdAt: timestamp(),
        updatedAt: timestamp()
      };

      this.externalEndpointDraftsById.set(record.id, record);
      return clone(record);
    }

    if (input.endpointType !== "marketplace_proxy") {
      throw new Error("Marketplace services only accept marketplace endpoint drafts.");
    }

    if (detail.endpoints.some((endpoint) => isMarketplaceEndpointDraft(endpoint) && endpoint.operation === input.operation)) {
      throw new Error(`Operation already exists: ${input.operation}`);
    }

    const secretRef = secretMaterial
      ? this.createProviderSecretRecord(detail.account.id, secretMaterial).id
      : null;
    const billing = createDraftRouteBilling(input);
    const apiNamespace = detail.service.apiNamespace;
    if (!apiNamespace) {
      throw new Error("Marketplace services require an apiNamespace before creating endpoints.");
    }

    const record: MarketplaceProviderEndpointDraftRecord = {
      endpointType: "marketplace_proxy",
      id: randomUUID(),
      serviceId,
      routeId: buildRouteId(apiNamespace, input.operation),
      operation: input.operation,
      method: input.method,
      title: input.title,
      description: input.description,
      price: billing.price,
      billing: billing.billing,
      mode: input.mode,
      asyncConfig: billing.billing.type === "topup_x402_variable"
        ? null
        : buildRouteAsyncConfig({
            mode: input.mode,
            asyncStrategy: input.asyncStrategy ?? null,
            asyncTimeoutMs: input.asyncTimeoutMs ?? null,
            pollPath: input.pollPath ?? null
          }),
      requestSchemaJson: clone(input.requestSchemaJson),
      responseSchemaJson: clone(input.responseSchemaJson),
      requestExample: clone(input.requestExample),
      responseExample: clone(input.responseExample),
      usageNotes: input.usageNotes ?? null,
      executorKind: billing.billing.type === "topup_x402_variable" ? "marketplace" : "http",
      upstreamBaseUrl: input.upstreamBaseUrl ?? null,
      upstreamPath: input.upstreamPath ?? null,
      upstreamAuthMode: input.upstreamAuthMode ?? null,
      upstreamAuthHeaderName: input.upstreamAuthHeaderName ?? null,
      upstreamSecretRef: billing.billing.type === "topup_x402_variable" ? null : secretRef,
      hasUpstreamSecret: billing.billing.type === "topup_x402_variable" ? false : Boolean(secretRef),
      payout: {
        providerAccountId: detail.account.id,
        providerWallet: detail.service.payoutWallet,
        providerBps: 10_000
      },
      createdAt: timestamp(),
      updatedAt: timestamp()
    };

    this.endpointDraftsById.set(record.id, record);
    return clone(record);
  }

  async updateProviderEndpointDraft(
    serviceId: string,
    endpointId: string,
    wallet: string,
    input: UpdateProviderEndpointDraftInput,
    secretMaterial?: { label: string; ciphertext: string; iv: string; authTag: string } | null
  ): Promise<ProviderEndpointDraftRecord | null> {
    const detail = await this.getProviderServiceForOwner(serviceId, wallet);
    if (!detail) {
      return null;
    }

    const existing = this.endpointDraftsById.get(endpointId) ?? this.externalEndpointDraftsById.get(endpointId);
    if (!existing || existing.serviceId !== serviceId) {
      return null;
    }

    if (existing.endpointType === "external_registry") {
      if (input.endpointType !== "external_registry") {
        throw new Error("External endpoint drafts only accept external updates.");
      }

      const nextMethod = input.method ?? existing.method;
      const nextPublicUrl = input.publicUrl ?? existing.publicUrl;
      if (
        (nextMethod !== existing.method || nextPublicUrl !== existing.publicUrl)
        && detail.endpoints.some((endpoint) =>
          endpoint.id !== endpointId
          && isExternalEndpointDraft(endpoint)
          && endpoint.method === nextMethod
          && endpoint.publicUrl === nextPublicUrl
        )
      ) {
        throw new Error(`External endpoint already exists: ${nextMethod} ${nextPublicUrl}`);
      }

      const updated: ExternalProviderEndpointDraftRecord = {
        ...existing,
        title: input.title ?? existing.title,
        description: input.description ?? existing.description,
        method: nextMethod,
        publicUrl: nextPublicUrl,
        docsUrl: input.docsUrl ?? existing.docsUrl,
        authNotes: input.authNotes === undefined ? existing.authNotes : input.authNotes,
        requestExample: input.requestExample === undefined ? existing.requestExample : clone(input.requestExample),
        responseExample: input.responseExample === undefined ? existing.responseExample : clone(input.responseExample),
        usageNotes: input.usageNotes === undefined ? existing.usageNotes : input.usageNotes,
        updatedAt: timestamp()
      };

      this.externalEndpointDraftsById.set(updated.id, updated);
      return clone(updated);
    }

    if (input.endpointType !== "marketplace_proxy") {
      throw new Error("Marketplace endpoint drafts only accept marketplace updates.");
    }

    const nextOperation = input.operation ?? existing.operation;
    if (
      nextOperation !== existing.operation &&
      detail.endpoints.some((endpoint) =>
        endpoint.id !== endpointId
        && isMarketplaceEndpointDraft(endpoint)
        && endpoint.operation === nextOperation
      )
    ) {
      throw new Error(`Operation already exists: ${nextOperation}`);
    }

    let secretRef = existing.upstreamSecretRef;
    if (input.clearUpstreamSecret) {
      secretRef = null;
    }
    if (secretMaterial) {
      secretRef = this.createProviderSecretRecord(detail.account.id, secretMaterial).id;
    }
    const billing = createDraftRouteBilling({
      billingType: input.billingType ?? existing.billing.type,
      price: input.price ?? existing.price,
      minAmount: input.minAmount ?? (existing.billing.type === "topup_x402_variable" ? existing.billing.minAmount : null),
      maxAmount: input.maxAmount ?? (existing.billing.type === "topup_x402_variable" ? existing.billing.maxAmount : null)
    });
    const apiNamespace = detail.service.apiNamespace;
    if (!apiNamespace) {
      throw new Error("Marketplace services require an apiNamespace before updating endpoints.");
    }

    const updated: MarketplaceProviderEndpointDraftRecord = {
      ...existing,
      routeId: buildRouteId(apiNamespace, nextOperation),
      operation: nextOperation,
      method: input.method ?? existing.method,
      title: input.title ?? existing.title,
      description: input.description ?? existing.description,
      price: billing.price,
      billing: billing.billing,
      mode: input.mode ?? existing.mode,
      asyncConfig: billing.billing.type === "topup_x402_variable"
        ? null
        : buildRouteAsyncConfig({
            mode: input.mode ?? existing.mode,
            asyncStrategy: input.asyncStrategy ?? existing.asyncConfig?.strategy ?? null,
            asyncTimeoutMs: input.asyncTimeoutMs ?? existing.asyncConfig?.timeoutMs ?? null,
            pollPath: input.pollPath === undefined
              ? (existing.asyncConfig?.pollPath ?? null)
              : input.pollPath
          }, existing.asyncConfig),
      requestSchemaJson: input.requestSchemaJson ? clone(input.requestSchemaJson) : existing.requestSchemaJson,
      responseSchemaJson: input.responseSchemaJson ? clone(input.responseSchemaJson) : existing.responseSchemaJson,
      requestExample: input.requestExample === undefined ? existing.requestExample : clone(input.requestExample),
      responseExample: input.responseExample === undefined ? existing.responseExample : clone(input.responseExample),
      usageNotes: input.usageNotes === undefined ? existing.usageNotes : input.usageNotes,
      executorKind: billing.billing.type === "topup_x402_variable" ? "marketplace" : "http",
      upstreamBaseUrl: billing.billing.type === "topup_x402_variable" ? null : input.upstreamBaseUrl ?? existing.upstreamBaseUrl,
      upstreamPath: billing.billing.type === "topup_x402_variable" ? null : input.upstreamPath ?? existing.upstreamPath,
      upstreamAuthMode: billing.billing.type === "topup_x402_variable" ? null : input.upstreamAuthMode ?? existing.upstreamAuthMode,
      upstreamAuthHeaderName:
        billing.billing.type === "topup_x402_variable"
          ? null
          : input.upstreamAuthHeaderName === undefined
          ? existing.upstreamAuthHeaderName
          : input.upstreamAuthHeaderName,
      upstreamSecretRef: billing.billing.type === "topup_x402_variable" ? null : secretRef,
      hasUpstreamSecret: billing.billing.type === "topup_x402_variable" ? false : Boolean(secretRef),
      payout: {
        providerAccountId: detail.account.id,
        providerWallet: detail.service.payoutWallet,
        providerBps: 10_000
      },
      updatedAt: timestamp()
    };

    this.endpointDraftsById.set(updated.id, updated);
    return clone(updated);
  }

  async deleteProviderEndpointDraft(serviceId: string, endpointId: string, wallet: string): Promise<boolean> {
    const detail = await this.getProviderServiceForOwner(serviceId, wallet);
    if (!detail) {
      return false;
    }

    const existing = this.endpointDraftsById.get(endpointId) ?? this.externalEndpointDraftsById.get(endpointId);
    if (!existing || existing.serviceId !== serviceId) {
      return false;
    }

    if (existing.endpointType === "marketplace_proxy") {
      this.endpointDraftsById.delete(endpointId);
    } else {
      this.externalEndpointDraftsById.delete(endpointId);
    }
    return true;
  }

  async createProviderVerificationChallenge(serviceId: string, wallet: string): Promise<ProviderVerificationRecord | null> {
    const detail = await this.getProviderServiceForOwner(serviceId, wallet);
    if (!detail) {
      return null;
    }

    const record: ProviderVerificationRecord = {
      id: randomUUID(),
      serviceId,
      token: `verify_${randomUUID()}`,
      status: "pending",
      verifiedHost: null,
      failureReason: null,
      createdAt: timestamp(),
      updatedAt: timestamp()
    };

    const current = this.verificationByService.get(serviceId) ?? [];
    current.push(record);
    this.verificationByService.set(serviceId, current);
    return clone(record);
  }

  async getLatestProviderVerification(serviceId: string): Promise<ProviderVerificationRecord | null> {
    return clone(latestByCreatedAt(this.verificationByService.get(serviceId) ?? []));
  }

  async markProviderVerificationResult(
    serviceId: string,
    status: ProviderVerificationStatus,
    input?: { verifiedHost?: string | null; failureReason?: string | null }
  ): Promise<ProviderVerificationRecord | null> {
    const current = this.verificationByService.get(serviceId) ?? [];
    const latest = latestByCreatedAt(current);
    if (!latest) {
      return null;
    }

    const updated: ProviderVerificationRecord = {
      ...latest,
      status,
      verifiedHost: input?.verifiedHost ?? latest.verifiedHost,
      failureReason: input?.failureReason ?? (status === "verified" ? null : latest.failureReason),
      updatedAt: timestamp()
    };

    const next = current.map((record) => (record.id === latest.id ? updated : record));
    this.verificationByService.set(serviceId, next);
    return clone(updated);
  }

  async submitProviderService(serviceId: string, wallet: string): Promise<ProviderServiceDetailRecord | null> {
    const detail = await this.getProviderServiceForOwner(serviceId, wallet);
    if (!detail) {
      return null;
    }

    const nextVersionNumber =
      Array.from(this.publishedServicesByVersionId.values()).filter((version) => version.serviceId === serviceId).length + 1;
    const versionTag = `v${nextVersionNumber}`;
    const serviceVersionId = randomUUID();
    const reviewId = randomUUID();

    const publishedService: PublishedServiceVersionRecord = {
      versionId: serviceVersionId,
      serviceId,
      providerAccountId: detail.account.id,
      serviceType: detail.service.serviceType,
      settlementMode: detail.service.settlementMode,
      slug: detail.service.slug,
      apiNamespace: detail.service.apiNamespace,
      name: detail.service.name,
      ownerName: detail.account.displayName,
      tagline: detail.service.tagline,
      about: detail.service.about,
      categories: clone(detail.service.categories),
      routeIds: detail.endpoints.filter(isMarketplaceEndpointDraft).map((endpoint) => endpoint.routeId),
      featured: detail.service.featured,
      promptIntro: detail.service.promptIntro,
      setupInstructions: clone(detail.service.setupInstructions),
      websiteUrl: detail.service.websiteUrl,
      contactEmail: detail.account.contactEmail,
      payoutWallet: detail.service.payoutWallet,
      status: "pending_review",
      submittedReviewId: reviewId,
      publishedAt: timestamp(),
      createdAt: timestamp(),
      updatedAt: timestamp()
    };

    const network = this.networkConfig;
    const publishedEndpoints = detail.endpoints.filter(isMarketplaceEndpointDraft).map<PublishedEndpointVersionRecord>((endpoint) => ({
      endpointType: "marketplace_proxy",
      endpointVersionId: randomUUID(),
      serviceId,
      serviceVersionId,
      endpointDraftId: endpoint.id,
      routeId: endpoint.routeId,
      provider: detail.service.apiNamespace ?? "unknown",
      operation: endpoint.operation,
      version: versionTag,
      method: endpoint.method,
      settlementMode: detail.service.settlementMode ?? "verified_escrow",
      mode: endpoint.mode,
      network: network.paymentNetwork,
      price: endpoint.price,
      billing: clone(endpoint.billing),
      asyncConfig: clone(endpoint.asyncConfig ?? null),
      title: endpoint.title,
      description: endpoint.description,
      payout: clone(endpoint.payout),
      requestExample: clone(endpoint.requestExample),
      responseExample: clone(endpoint.responseExample),
      usageNotes: endpoint.usageNotes ?? undefined,
      requestSchemaJson: clone(endpoint.requestSchemaJson),
      responseSchemaJson: clone(endpoint.responseSchemaJson),
      executorKind: endpoint.executorKind,
      upstreamBaseUrl: endpoint.upstreamBaseUrl,
      upstreamPath: endpoint.upstreamPath,
      upstreamAuthMode: endpoint.upstreamAuthMode,
      upstreamAuthHeaderName: endpoint.upstreamAuthHeaderName,
      upstreamSecretRef: endpoint.upstreamSecretRef,
      createdAt: timestamp(),
      updatedAt: timestamp()
    }));
    const publishedExternalEndpoints = detail.endpoints.filter(isExternalEndpointDraft).map<PublishedExternalEndpointVersionRecord>((endpoint) => ({
      endpointType: "external_registry",
      endpointVersionId: randomUUID(),
      serviceId,
      serviceVersionId,
      endpointDraftId: endpoint.id,
      routeId: null,
      provider: null,
      operation: null,
      version: null,
      settlementMode: null,
      mode: null,
      network: null,
      price: null,
      billing: null,
      title: endpoint.title,
      description: endpoint.description,
      payout: null,
      method: endpoint.method,
      publicUrl: endpoint.publicUrl,
      docsUrl: endpoint.docsUrl,
      authNotes: endpoint.authNotes,
      requestExample: clone(endpoint.requestExample),
      responseExample: clone(endpoint.responseExample),
      usageNotes: endpoint.usageNotes ?? undefined,
      requestSchemaJson: null,
      responseSchemaJson: null,
      executorKind: null,
      upstreamBaseUrl: null,
      upstreamPath: null,
      upstreamAuthMode: null,
      upstreamAuthHeaderName: null,
      upstreamSecretRef: null,
      createdAt: timestamp(),
      updatedAt: timestamp()
    }));

    const review: ProviderReviewRecord = {
      id: reviewId,
      serviceId,
      submittedVersionId: serviceVersionId,
      status: "pending_review",
      reviewNotes: null,
      reviewerIdentity: null,
      createdAt: timestamp(),
      updatedAt: timestamp()
    };

    this.publishedServicesByVersionId.set(serviceVersionId, publishedService);
    for (const endpoint of publishedEndpoints) {
      this.publishedEndpointsByVersionId.set(endpoint.endpointVersionId, endpoint);
    }
    for (const endpoint of publishedExternalEndpoints) {
      this.publishedExternalEndpointsByVersionId.set(endpoint.endpointVersionId, endpoint);
    }

    const currentReviews = this.reviewsByService.get(serviceId) ?? [];
    currentReviews.push(review);
    this.reviewsByService.set(serviceId, currentReviews);
    this.latestSubmittedVersionByServiceId.set(serviceId, serviceVersionId);

    this.providerServicesById.set(serviceId, {
      ...detail.service,
      status: "pending_review",
      updatedAt: timestamp()
    });

    return this.buildProviderServiceDetail(serviceId);
  }

  async listAdminProviderServices(status?: ProviderServiceStatus): Promise<ProviderServiceDetailRecord[]> {
    const services = Array.from(this.providerServicesById.values())
      .filter((service) => !status || service.status === status)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));

    return services.map((service) => this.buildProviderServiceDetail(service.id));
  }

  async getAdminProviderService(serviceId: string): Promise<ProviderServiceDetailRecord | null> {
    if (!this.providerServicesById.has(serviceId)) {
      return null;
    }

    return this.buildProviderServiceDetail(serviceId);
  }

  async getSubmittedProviderService(serviceId: string): Promise<ProviderServiceDetailRecord | null> {
    const detail = await this.getAdminProviderService(serviceId);
    const submittedVersionId = detail?.latestReview?.submittedVersionId ?? null;
    if (!detail || !submittedVersionId) {
      return null;
    }

    const version = this.publishedServicesByVersionId.get(submittedVersionId);
    if (!version) {
      return null;
    }

    const endpoints: PublishedServiceEndpointVersionRecord[] = [
      ...Array.from(this.publishedEndpointsByVersionId.values()).filter(
        (endpoint) => endpoint.serviceVersionId === submittedVersionId
      ),
      ...Array.from(this.publishedExternalEndpointsByVersionId.values()).filter(
        (endpoint) => endpoint.serviceVersionId === submittedVersionId
      )
    ].sort((left, right) => left.title.localeCompare(right.title));

    return buildSubmittedProviderServiceDetail({
      version,
      account: detail.account,
      endpoints,
      verification: detail.verification,
      latestReview: detail.latestReview,
      latestPublishedVersionId: detail.latestPublishedVersionId
    });
  }

  async requestProviderServiceChanges(
    serviceId: string,
    input: { reviewNotes: string; reviewerIdentity?: string | null }
  ): Promise<ProviderServiceDetailRecord | null> {
    const latestReview = latestByCreatedAt(this.reviewsByService.get(serviceId) ?? []);
    if (!latestReview) {
      return null;
    }

    const updatedReview: ProviderReviewRecord = {
      ...latestReview,
      status: "changes_requested",
      reviewNotes: input.reviewNotes,
      reviewerIdentity: input.reviewerIdentity ?? null,
      updatedAt: timestamp()
    };
    this.reviewsByService.set(
      serviceId,
      (this.reviewsByService.get(serviceId) ?? []).map((record) =>
        record.id === latestReview.id ? updatedReview : record
      )
    );

    const service = this.providerServicesById.get(serviceId);
    if (!service) {
      return null;
    }

    this.providerServicesById.set(serviceId, {
      ...service,
      status: "changes_requested",
      updatedAt: timestamp()
    });

    return this.buildProviderServiceDetail(serviceId);
  }

  async publishProviderService(
    serviceId: string,
    input?: { reviewerIdentity?: string | null; settlementMode?: SettlementMode | null; submittedVersionId?: string | null }
  ): Promise<ProviderServiceDetailRecord | null> {
    const service = this.providerServicesById.get(serviceId);
    if (!service) {
      return null;
    }

    const submittedVersionId = input?.submittedVersionId ?? latestByCreatedAt(this.reviewsByService.get(serviceId) ?? [])?.submittedVersionId ?? null;
    if (!submittedVersionId) {
      return null;
    }

    const submittedReview = (this.reviewsByService.get(serviceId) ?? []).find(
      (review) => review.submittedVersionId === submittedVersionId
    );
    if (!submittedReview) {
      return null;
    }

    const version = this.publishedServicesByVersionId.get(submittedVersionId);
    if (!version) {
      return null;
    }

    this.assertServiceUniqueness(version.slug, version.apiNamespace, serviceId);

    const settlementMode = service.serviceType === "marketplace_proxy"
      ? normalizeSettlementMode(input?.settlementMode ?? service.settlementMode, service.settlementMode ?? "verified_escrow")
      : null;

    this.latestPublishedVersionByServiceId.set(serviceId, version.versionId);
    this.providerServicesById.set(serviceId, {
      ...service,
      settlementMode,
      status: "published",
      updatedAt: timestamp()
    });
    this.publishedServicesByVersionId.set(version.versionId, {
      ...version,
      settlementMode,
      status: "published",
      publishedAt: timestamp(),
      updatedAt: timestamp()
    });
    if (settlementMode) {
      for (const [endpointVersionId, endpoint] of this.publishedEndpointsByVersionId.entries()) {
        if (endpoint.serviceVersionId !== version.versionId) {
          continue;
        }

        this.publishedEndpointsByVersionId.set(endpointVersionId, {
          ...endpoint,
          settlementMode,
          updatedAt: timestamp()
        });
      }
    }
    this.reviewsByService.set(
      serviceId,
      (this.reviewsByService.get(serviceId) ?? []).map((record) =>
        record.id === submittedReview.id
          ? {
              ...record,
              status: "published",
              reviewerIdentity: input?.reviewerIdentity ?? record.reviewerIdentity,
              updatedAt: timestamp()
            }
          : record
      )
    );

    return this.buildProviderServiceDetail(serviceId);
  }

  async updateProviderServiceSettlementMode(
    serviceId: string,
    input: {
      settlementMode: SettlementMode;
      reviewerIdentity?: string | null;
      submittedVersionId?: string | null;
      publishedVersionId?: string | null;
    }
  ): Promise<ProviderServiceDetailRecord | null> {
    const service = this.providerServicesById.get(serviceId);
    if (!service) {
      return null;
    }

    if (service.serviceType === "external_registry") {
      return this.buildProviderServiceDetail(serviceId);
    }

    const settlementMode = normalizeSettlementMode(input.settlementMode, service.settlementMode ?? "verified_escrow");
    this.providerServicesById.set(serviceId, {
      ...service,
      settlementMode,
      updatedAt: timestamp()
    });

    const latestSubmittedVersionId = input.submittedVersionId ?? this.latestSubmittedVersionByServiceId.get(serviceId);
    if (latestSubmittedVersionId) {
      const latestSubmittedVersion = this.publishedServicesByVersionId.get(latestSubmittedVersionId);
      if (latestSubmittedVersion) {
        this.publishedServicesByVersionId.set(latestSubmittedVersionId, {
          ...latestSubmittedVersion,
          settlementMode,
          updatedAt: timestamp()
        });
      }

      for (const [endpointVersionId, endpoint] of this.publishedEndpointsByVersionId.entries()) {
        if (endpoint.serviceVersionId !== latestSubmittedVersionId) {
          continue;
        }

        this.publishedEndpointsByVersionId.set(endpointVersionId, {
          ...endpoint,
          settlementMode,
          updatedAt: timestamp()
        });
      }
    }

    const latestPublishedVersionId = input.publishedVersionId ?? this.latestPublishedVersionByServiceId.get(serviceId);
    if (latestPublishedVersionId && latestPublishedVersionId !== latestSubmittedVersionId) {
      const latestPublishedVersion = this.publishedServicesByVersionId.get(latestPublishedVersionId);
      if (latestPublishedVersion) {
        this.publishedServicesByVersionId.set(latestPublishedVersionId, {
          ...latestPublishedVersion,
          settlementMode,
          updatedAt: timestamp()
        });
      }

      for (const [endpointVersionId, endpoint] of this.publishedEndpointsByVersionId.entries()) {
        if (endpoint.serviceVersionId !== latestPublishedVersionId) {
          continue;
        }

        this.publishedEndpointsByVersionId.set(endpointVersionId, {
          ...endpoint,
          settlementMode,
          updatedAt: timestamp()
        });
      }
    }

    return this.buildProviderServiceDetail(serviceId);
  }

  async suspendProviderService(
    serviceId: string,
    input?: { reviewNotes?: string | null; reviewerIdentity?: string | null }
  ): Promise<ProviderServiceDetailRecord | null> {
    const service = this.providerServicesById.get(serviceId);
    if (!service) {
      return null;
    }

    this.providerServicesById.set(serviceId, {
      ...service,
      status: "suspended",
      updatedAt: timestamp()
    });

    const latestReview = latestByCreatedAt(this.reviewsByService.get(serviceId) ?? []);
    if (latestReview) {
      this.reviewsByService.set(
        serviceId,
        (this.reviewsByService.get(serviceId) ?? []).map((record) =>
          record.id === latestReview.id
            ? {
                ...record,
                status: "suspended",
                reviewNotes: input?.reviewNotes ?? record.reviewNotes,
                reviewerIdentity: input?.reviewerIdentity ?? record.reviewerIdentity,
                updatedAt: timestamp()
              }
            : record
        )
      );
    }

    const latestPublishedVersionId = this.latestPublishedVersionByServiceId.get(serviceId);
    if (latestPublishedVersionId) {
      const version = this.publishedServicesByVersionId.get(latestPublishedVersionId);
      if (version) {
        this.publishedServicesByVersionId.set(latestPublishedVersionId, {
          ...version,
          status: "suspended",
          updatedAt: timestamp()
        });
      }
    }

    return this.buildProviderServiceDetail(serviceId);
  }

  async getProviderSecret(secretId: string): Promise<ProviderSecretRecord | null> {
    return clone(this.providerSecretsById.get(secretId) ?? null);
  }

  async createSuggestion(input: CreateSuggestionInput): Promise<SuggestionRecord> {
    const now = timestamp();
    const record: SuggestionRecord = {
      id: randomUUID(),
      type: input.type,
      serviceSlug: input.serviceSlug ?? null,
      title: input.title,
      description: input.description,
      sourceUrl: input.sourceUrl ?? null,
      requesterName: input.requesterName ?? null,
      requesterEmail: input.requesterEmail ?? null,
      status: "submitted",
      internalNotes: null,
      claimedByProviderAccountId: null,
      claimedByProviderName: null,
      claimedAt: null,
      createdAt: now,
      updatedAt: now
    };

    this.suggestionsById.set(record.id, record);
    return clone(record);
  }

  async listSuggestions(filter?: { status?: SuggestionStatus }): Promise<SuggestionRecord[]> {
    const suggestions = Array.from(this.suggestionsById.values())
      .filter((suggestion) => !filter?.status || suggestion.status === filter.status)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));

    return clone(suggestions);
  }

  async updateSuggestion(id: string, input: UpdateSuggestionInput): Promise<SuggestionRecord | null> {
    const existing = this.suggestionsById.get(id);
    if (!existing) {
      return null;
    }

    const nextStatus = input.status ?? existing.status;
    const shouldClearClaim = nextStatus === "submitted";

    const updated: SuggestionRecord = {
      ...existing,
      status: nextStatus,
      internalNotes: input.internalNotes === undefined ? existing.internalNotes : input.internalNotes,
      claimedByProviderAccountId: shouldClearClaim ? null : existing.claimedByProviderAccountId,
      claimedByProviderName: shouldClearClaim ? null : existing.claimedByProviderName,
      claimedAt: shouldClearClaim ? null : existing.claimedAt,
      updatedAt: timestamp()
    };

    this.suggestionsById.set(id, updated);
    return clone(updated);
  }

  async listProviderRequests(wallet: string): Promise<SuggestionRecord[]> {
    const account = await this.getProviderAccountByWallet(wallet);
    if (!account) {
      return [];
    }

    const requests = Array.from(this.suggestionsById.values())
      .filter((suggestion) => isSuggestionProviderVisible(suggestion.status))
      .sort((left, right) => {
        const leftRank =
          left.claimedByProviderAccountId === account.id ? 0 : left.claimedByProviderAccountId ? 2 : 1;
        const rightRank =
          right.claimedByProviderAccountId === account.id ? 0 : right.claimedByProviderAccountId ? 2 : 1;

        if (leftRank !== rightRank) {
          return leftRank - rightRank;
        }

        return right.updatedAt.localeCompare(left.updatedAt);
      });

    return clone(requests);
  }

  async claimProviderRequest(id: string, wallet: string): Promise<SuggestionRecord | null> {
    const account = await this.getProviderAccountByWallet(wallet);
    if (!account) {
      throw new Error("Provider account not found.");
    }

    const existing = this.suggestionsById.get(id);
    if (!existing) {
      return null;
    }

    if (!isSuggestionProviderVisible(existing.status) || existing.status === "shipped") {
      throw new Error("Request is not claimable.");
    }

    if (existing.claimedByProviderAccountId && existing.claimedByProviderAccountId !== account.id) {
      throw new Error(`Request already claimed by ${existing.claimedByProviderName ?? "another provider"}.`);
    }

    if (existing.claimedByProviderAccountId === account.id) {
      return clone(existing);
    }

    const now = timestamp();
    const updated: SuggestionRecord = {
      ...existing,
      status: existing.status === "submitted" ? "reviewing" : existing.status,
      claimedByProviderAccountId: account.id,
      claimedByProviderName: account.displayName,
      claimedAt: now,
      updatedAt: now
    };

    this.suggestionsById.set(id, updated);
    return clone(updated);
  }

  private createProviderSecretRecord(
    providerAccountId: string,
    secretMaterial: { label: string; ciphertext: string; iv: string; authTag: string }
  ): ProviderSecretRecord {
    const record: ProviderSecretRecord = {
      id: randomUUID(),
      providerAccountId,
      label: secretMaterial.label,
      secretCiphertext: secretMaterial.ciphertext,
      iv: secretMaterial.iv,
      authTag: secretMaterial.authTag,
      createdAt: timestamp(),
      updatedAt: timestamp()
    };
    this.providerSecretsById.set(record.id, record);
    return record;
  }

  private assertServiceUniqueness(slug: string, apiNamespace: string | null, serviceId?: string) {
    for (const service of this.providerServicesById.values()) {
      if (service.id === serviceId) {
        continue;
      }

      const latestPublishedVersionId = this.latestPublishedVersionByServiceId.get(service.id);
      const latestPublishedVersion = latestPublishedVersionId
        ? this.publishedServicesByVersionId.get(latestPublishedVersionId) ?? null
        : null;
      if (service.slug === slug || (service.status === "published" && latestPublishedVersion?.slug === slug)) {
        throw new Error(`Service slug already exists: ${slug}`);
      }

      if (
        apiNamespace
        && (service.apiNamespace === apiNamespace || (service.status === "published" && latestPublishedVersion?.apiNamespace === apiNamespace))
      ) {
        throw new Error(`API namespace already exists: ${apiNamespace}`);
      }
    }
  }

  private buildProviderServiceDetail(serviceId: string): ProviderServiceDetailRecord {
    const service = this.providerServicesById.get(serviceId);
    if (!service) {
      throw new Error(`Provider service not found: ${serviceId}`);
    }

    const account = this.providerAccountsById.get(service.providerAccountId);
    if (!account) {
      throw new Error(`Provider account not found: ${service.providerAccountId}`);
    }

    const endpoints = [
      ...Array.from(this.endpointDraftsById.values()).filter((endpoint) => endpoint.serviceId === serviceId),
      ...Array.from(this.externalEndpointDraftsById.values()).filter((endpoint) => endpoint.serviceId === serviceId)
    ];
    const verification = latestByCreatedAt(this.verificationByService.get(serviceId) ?? []);
    const latestReview = latestByCreatedAt(this.reviewsByService.get(serviceId) ?? []);

    return buildProviderServiceDetail({
      service,
      account,
      endpoints,
      verification,
      latestReview,
      latestPublishedVersionId: this.latestPublishedVersionByServiceId.get(serviceId) ?? null
    });
  }
}

export class PostgresMarketplaceStore implements MarketplaceStore {
  constructor(
    private readonly pool: Pool,
    private readonly networkConfig: MarketplaceNetworkConfig = getDefaultMarketplaceNetworkConfig()
  ) {}

  async ensureSchema(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS idempotency_records (
        payment_id TEXT PRIMARY KEY,
        normalized_request_hash TEXT NOT NULL,
        buyer_wallet TEXT NOT NULL,
        route_id TEXT NOT NULL,
        route_version TEXT NOT NULL,
        pending_recovery_action TEXT NOT NULL DEFAULT 'retry',
        quoted_price TEXT NOT NULL,
        payout_split JSONB NOT NULL DEFAULT '{}'::jsonb,
        payment_payload TEXT NOT NULL,
        facilitator_response JSONB NOT NULL,
        response_kind TEXT NOT NULL,
        response_status_code INTEGER NOT NULL,
        response_body JSONB NOT NULL,
        response_headers JSONB NOT NULL DEFAULT '{}'::jsonb,
        provider_payout_source_kind TEXT,
        job_token TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      ALTER TABLE idempotency_records
      ADD COLUMN IF NOT EXISTS provider_payout_source_kind TEXT;

      ALTER TABLE idempotency_records
      ADD COLUMN IF NOT EXISTS execution_status TEXT NOT NULL DEFAULT 'completed';

      ALTER TABLE idempotency_records
      ADD COLUMN IF NOT EXISTS request_id TEXT;

      ALTER TABLE idempotency_records
      ADD COLUMN IF NOT EXISTS pending_recovery_action TEXT;

      CREATE TABLE IF NOT EXISTS jobs (
        job_token TEXT PRIMARY KEY,
        payment_id TEXT REFERENCES idempotency_records(payment_id),
        route_id TEXT NOT NULL,
        service_id TEXT,
        provider TEXT NOT NULL,
        operation TEXT NOT NULL,
        buyer_wallet TEXT NOT NULL,
        quoted_price TEXT NOT NULL,
        payout_split JSONB NOT NULL DEFAULT '{}'::jsonb,
        request_id TEXT,
        provider_job_id TEXT,
        request_body JSONB NOT NULL,
        route_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
        provider_state JSONB,
        next_poll_at TIMESTAMPTZ,
        timeout_at TIMESTAMPTZ,
        status TEXT NOT NULL,
        result_body JSONB,
        error_message TEXT,
        refund_status TEXT NOT NULL DEFAULT 'not_required',
        refund_id TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS provider_attempts (
        id TEXT PRIMARY KEY,
        job_token TEXT REFERENCES jobs(job_token),
        payment_id TEXT,
        route_id TEXT NOT NULL,
        request_id TEXT,
        response_status_code INTEGER,
        phase TEXT NOT NULL,
        status TEXT NOT NULL,
        request_payload JSONB,
        response_payload JSONB,
        error_message TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      ALTER TABLE provider_attempts
      ALTER COLUMN job_token DROP NOT NULL;

      ALTER TABLE provider_attempts
      ADD COLUMN IF NOT EXISTS route_id TEXT;

      ALTER TABLE provider_attempts
      ADD COLUMN IF NOT EXISTS request_id TEXT;

      ALTER TABLE provider_attempts
      ADD COLUMN IF NOT EXISTS response_status_code INTEGER;

      ALTER TABLE provider_attempts
      ADD COLUMN IF NOT EXISTS payment_id TEXT;

      UPDATE provider_attempts attempts
      SET route_id = jobs.route_id
      FROM jobs
      WHERE attempts.route_id IS NULL
        AND attempts.job_token = jobs.job_token;

      ALTER TABLE provider_attempts
      ALTER COLUMN route_id SET NOT NULL;

      CREATE INDEX IF NOT EXISTS provider_attempts_route_id_idx
      ON provider_attempts(route_id);

      CREATE TABLE IF NOT EXISTS access_grants (
        id TEXT PRIMARY KEY,
        resource_type TEXT NOT NULL,
        resource_id TEXT NOT NULL,
        wallet TEXT NOT NULL,
        payment_id TEXT NOT NULL,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(resource_type, resource_id, wallet)
      );

      CREATE TABLE IF NOT EXISTS refunds (
        id TEXT PRIMARY KEY,
        job_token TEXT UNIQUE REFERENCES jobs(job_token),
        payment_id TEXT NOT NULL,
        wallet TEXT NOT NULL,
        amount TEXT NOT NULL,
        status TEXT NOT NULL,
        tx_hash TEXT,
        error_message TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS service_suggestions (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        service_slug TEXT,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        source_url TEXT,
        requester_name TEXT,
        requester_email TEXT,
        status TEXT NOT NULL,
        internal_notes TEXT,
        claimed_provider_account_id TEXT,
        claimed_provider_name TEXT,
        claimed_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS provider_accounts (
        id TEXT PRIMARY KEY,
        owner_wallet TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL,
        bio TEXT,
        website_url TEXT,
        contact_email TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS provider_services (
        id TEXT PRIMARY KEY,
        provider_account_id TEXT NOT NULL REFERENCES provider_accounts(id),
        service_type TEXT NOT NULL DEFAULT 'marketplace_proxy',
        settlement_mode TEXT DEFAULT 'verified_escrow',
        slug TEXT NOT NULL UNIQUE,
        api_namespace TEXT UNIQUE,
        name TEXT NOT NULL,
        tagline TEXT NOT NULL,
        about TEXT NOT NULL,
        categories JSONB NOT NULL DEFAULT '[]'::jsonb,
        prompt_intro TEXT NOT NULL,
        setup_instructions JSONB NOT NULL DEFAULT '[]'::jsonb,
        website_url TEXT,
        payout_wallet TEXT,
        featured BOOLEAN NOT NULL DEFAULT FALSE,
        status TEXT NOT NULL,
        latest_submitted_version_id TEXT,
        latest_published_version_id TEXT,
        latest_review_id TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS provider_secrets (
        id TEXT PRIMARY KEY,
        provider_account_id TEXT NOT NULL REFERENCES provider_accounts(id),
        label TEXT NOT NULL,
        secret_ciphertext TEXT NOT NULL,
        iv TEXT NOT NULL,
        auth_tag TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS provider_endpoint_drafts (
        id TEXT PRIMARY KEY,
        service_id TEXT NOT NULL REFERENCES provider_services(id) ON DELETE CASCADE,
        route_id TEXT NOT NULL,
        operation TEXT NOT NULL,
        method TEXT NOT NULL DEFAULT 'POST',
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        price TEXT NOT NULL,
        billing JSONB NOT NULL DEFAULT '{}'::jsonb,
        mode TEXT NOT NULL,
        async_config JSONB,
        request_schema_json JSONB NOT NULL,
        response_schema_json JSONB NOT NULL,
        request_example JSONB NOT NULL,
        response_example JSONB NOT NULL,
        usage_notes TEXT,
        executor_kind TEXT NOT NULL,
        upstream_base_url TEXT,
        upstream_path TEXT,
        upstream_auth_mode TEXT,
        upstream_auth_header_name TEXT,
        upstream_secret_ref TEXT,
        payout JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(service_id, operation)
      );

      CREATE TABLE IF NOT EXISTS provider_external_endpoint_drafts (
        id TEXT PRIMARY KEY,
        service_id TEXT NOT NULL REFERENCES provider_services(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        method TEXT NOT NULL,
        public_url TEXT NOT NULL,
        docs_url TEXT NOT NULL,
        auth_notes TEXT,
        request_example JSONB NOT NULL,
        response_example JSONB NOT NULL,
        usage_notes TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(service_id, method, public_url)
      );

      CREATE TABLE IF NOT EXISTS provider_verifications (
        id TEXT PRIMARY KEY,
        service_id TEXT NOT NULL REFERENCES provider_services(id) ON DELETE CASCADE,
        token TEXT NOT NULL,
        status TEXT NOT NULL,
        verified_host TEXT,
        failure_reason TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS published_service_versions (
        version_id TEXT PRIMARY KEY,
        service_id TEXT NOT NULL REFERENCES provider_services(id) ON DELETE CASCADE,
        provider_account_id TEXT NOT NULL REFERENCES provider_accounts(id),
        service_type TEXT NOT NULL DEFAULT 'marketplace_proxy',
        settlement_mode TEXT DEFAULT 'verified_escrow',
        slug TEXT NOT NULL,
        api_namespace TEXT,
        name TEXT NOT NULL,
        owner_name TEXT NOT NULL,
        tagline TEXT NOT NULL,
        about TEXT NOT NULL,
        categories JSONB NOT NULL DEFAULT '[]'::jsonb,
        route_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
        featured BOOLEAN NOT NULL DEFAULT FALSE,
        prompt_intro TEXT NOT NULL,
        setup_instructions JSONB NOT NULL DEFAULT '[]'::jsonb,
        website_url TEXT,
        contact_email TEXT,
        payout_wallet TEXT,
        status TEXT NOT NULL,
        submitted_review_id TEXT,
        published_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS published_endpoint_versions (
        endpoint_version_id TEXT PRIMARY KEY,
        service_id TEXT NOT NULL REFERENCES provider_services(id) ON DELETE CASCADE,
        service_version_id TEXT NOT NULL REFERENCES published_service_versions(version_id) ON DELETE CASCADE,
        endpoint_draft_id TEXT,
        route_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        operation TEXT NOT NULL,
        version TEXT NOT NULL,
        method TEXT NOT NULL DEFAULT 'POST',
        settlement_mode TEXT NOT NULL DEFAULT 'verified_escrow',
        mode TEXT NOT NULL,
        network TEXT NOT NULL,
        price TEXT NOT NULL,
        billing JSONB NOT NULL DEFAULT '{}'::jsonb,
        async_config JSONB,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        payout JSONB NOT NULL,
        request_example JSONB NOT NULL,
        response_example JSONB NOT NULL,
        usage_notes TEXT,
        request_schema_json JSONB NOT NULL,
        response_schema_json JSONB NOT NULL,
        executor_kind TEXT NOT NULL,
        upstream_base_url TEXT,
        upstream_path TEXT,
        upstream_auth_mode TEXT,
        upstream_auth_header_name TEXT,
        upstream_secret_ref TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS published_external_endpoint_versions (
        endpoint_version_id TEXT PRIMARY KEY,
        service_id TEXT NOT NULL REFERENCES provider_services(id) ON DELETE CASCADE,
        service_version_id TEXT NOT NULL REFERENCES published_service_versions(version_id) ON DELETE CASCADE,
        endpoint_draft_id TEXT,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        method TEXT NOT NULL,
        public_url TEXT NOT NULL,
        docs_url TEXT NOT NULL,
        auth_notes TEXT,
        request_example JSONB NOT NULL,
        response_example JSONB NOT NULL,
        usage_notes TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS provider_reviews (
        id TEXT PRIMARY KEY,
        service_id TEXT NOT NULL REFERENCES provider_services(id) ON DELETE CASCADE,
        submitted_version_id TEXT NOT NULL REFERENCES published_service_versions(version_id) ON DELETE CASCADE,
        status TEXT NOT NULL,
        review_notes TEXT,
        reviewer_identity TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS provider_payouts (
        id TEXT PRIMARY KEY,
        source_kind TEXT NOT NULL,
        source_id TEXT NOT NULL,
        provider_account_id TEXT NOT NULL REFERENCES provider_accounts(id),
        provider_wallet TEXT NOT NULL,
        currency TEXT NOT NULL,
        amount TEXT NOT NULL,
        status TEXT NOT NULL,
        tx_hash TEXT,
        sent_at TIMESTAMPTZ,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(source_kind, source_id)
      );

      CREATE TABLE IF NOT EXISTS credit_accounts (
        id TEXT PRIMARY KEY,
        service_id TEXT NOT NULL REFERENCES provider_services(id) ON DELETE CASCADE,
        buyer_wallet TEXT NOT NULL,
        currency TEXT NOT NULL,
        available_amount TEXT NOT NULL,
        reserved_amount TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(service_id, buyer_wallet, currency)
      );

      CREATE TABLE IF NOT EXISTS credit_reservations (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES credit_accounts(id) ON DELETE CASCADE,
        service_id TEXT NOT NULL REFERENCES provider_services(id) ON DELETE CASCADE,
        buyer_wallet TEXT NOT NULL,
        currency TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        job_token TEXT,
        request_id TEXT,
        payment_id TEXT,
        provider_reference TEXT,
        status TEXT NOT NULL,
        reserved_amount TEXT NOT NULL,
        captured_amount TEXT NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS credit_ledger_entries (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES credit_accounts(id) ON DELETE CASCADE,
        service_id TEXT NOT NULL REFERENCES provider_services(id) ON DELETE CASCADE,
        buyer_wallet TEXT NOT NULL,
        currency TEXT NOT NULL,
        kind TEXT NOT NULL,
        amount TEXT NOT NULL,
        reservation_id TEXT REFERENCES credit_reservations(id) ON DELETE SET NULL,
        payment_id TEXT,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      WITH ranked_credit_topups AS (
        SELECT
          ctid,
          account_id,
          ROW_NUMBER() OVER (
            PARTITION BY service_id, payment_id
            ORDER BY created_at ASC, id ASC
          ) AS row_num
        FROM credit_ledger_entries
        WHERE kind = 'topup'
          AND payment_id IS NOT NULL
      ),
      duplicate_credit_topups AS (
        SELECT ctid, account_id
        FROM ranked_credit_topups
        WHERE row_num > 1
      ),
      deleted_credit_topups AS (
        DELETE FROM credit_ledger_entries
        WHERE ctid IN (
          SELECT ctid
          FROM duplicate_credit_topups
        )
        RETURNING account_id
      ),
      affected_credit_accounts AS (
        SELECT DISTINCT account_id
        FROM duplicate_credit_topups
        UNION
        SELECT DISTINCT account_id
        FROM deleted_credit_topups
      ),
      recomputed_credit_accounts AS (
        SELECT
          accounts.id AS account_id,
          COALESCE(
            SUM(
              CASE
                WHEN entries.kind = 'topup' THEN entries.amount::numeric
                WHEN entries.kind = 'reserve' THEN -entries.amount::numeric
                WHEN entries.kind = 'release' THEN entries.amount::numeric
                ELSE 0::numeric
              END
            ),
            0::numeric
          )::text AS available_amount,
          COALESCE(
            SUM(
              CASE
                WHEN entries.kind = 'reserve' THEN entries.amount::numeric
                WHEN entries.kind IN ('capture', 'release') THEN -entries.amount::numeric
                ELSE 0::numeric
              END
            ),
            0::numeric
          )::text AS reserved_amount
        FROM credit_accounts accounts
        LEFT JOIN credit_ledger_entries entries
          ON entries.account_id = accounts.id
        WHERE accounts.id IN (
          SELECT account_id
          FROM affected_credit_accounts
        )
        GROUP BY accounts.id
      )
      UPDATE credit_accounts
      SET
        available_amount = recomputed_credit_accounts.available_amount,
        reserved_amount = recomputed_credit_accounts.reserved_amount,
        updated_at = NOW()
      FROM recomputed_credit_accounts
      WHERE credit_accounts.id = recomputed_credit_accounts.account_id;

      CREATE UNIQUE INDEX IF NOT EXISTS credit_topup_entries_service_payment_idx
      ON credit_ledger_entries(service_id, payment_id)
      WHERE kind = 'topup' AND payment_id IS NOT NULL;

      CREATE TABLE IF NOT EXISTS provider_runtime_keys (
        id TEXT PRIMARY KEY,
        service_id TEXT NOT NULL UNIQUE REFERENCES provider_services(id) ON DELETE CASCADE,
        key_prefix TEXT NOT NULL,
        key_hash TEXT NOT NULL,
        secret_ciphertext TEXT NOT NULL,
        iv TEXT NOT NULL,
        auth_tag TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      ALTER TABLE jobs
      ADD COLUMN IF NOT EXISTS route_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb;

      ALTER TABLE jobs
      ADD COLUMN IF NOT EXISTS service_id TEXT;

      ALTER TABLE jobs
      ADD COLUMN IF NOT EXISTS request_id TEXT;

      ALTER TABLE jobs
      ADD COLUMN IF NOT EXISTS next_poll_at TIMESTAMPTZ;

      ALTER TABLE jobs
      ADD COLUMN IF NOT EXISTS timeout_at TIMESTAMPTZ;

      ALTER TABLE jobs
      ALTER COLUMN payment_id DROP NOT NULL;

      ALTER TABLE jobs
      ALTER COLUMN provider_job_id DROP NOT NULL;

      ALTER TABLE service_suggestions
      ADD COLUMN IF NOT EXISTS claimed_provider_account_id TEXT;

      ALTER TABLE service_suggestions
      ADD COLUMN IF NOT EXISTS claimed_provider_name TEXT;

      ALTER TABLE service_suggestions
      ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ;

      ALTER TABLE provider_endpoint_drafts
      ADD COLUMN IF NOT EXISTS billing JSONB NOT NULL DEFAULT '{}'::jsonb;

      ALTER TABLE provider_endpoint_drafts
      ADD COLUMN IF NOT EXISTS method TEXT NOT NULL DEFAULT 'POST';

      ALTER TABLE provider_endpoint_drafts
      ADD COLUMN IF NOT EXISTS async_config JSONB;

      ALTER TABLE provider_services
      ADD COLUMN IF NOT EXISTS service_type TEXT NOT NULL DEFAULT 'marketplace_proxy';

      ALTER TABLE provider_services
      ADD COLUMN IF NOT EXISTS settlement_mode TEXT;

      ALTER TABLE published_service_versions
      ADD COLUMN IF NOT EXISTS service_type TEXT NOT NULL DEFAULT 'marketplace_proxy';

      ALTER TABLE published_service_versions
      ADD COLUMN IF NOT EXISTS settlement_mode TEXT;

      ALTER TABLE published_endpoint_versions
      ADD COLUMN IF NOT EXISTS settlement_mode TEXT;

      ALTER TABLE published_endpoint_versions
      ADD COLUMN IF NOT EXISTS method TEXT NOT NULL DEFAULT 'POST';

      ALTER TABLE published_endpoint_versions
      ADD COLUMN IF NOT EXISTS billing JSONB NOT NULL DEFAULT '{}'::jsonb;

      ALTER TABLE published_endpoint_versions
      ADD COLUMN IF NOT EXISTS async_config JSONB;

      ALTER TABLE credit_reservations
      ADD COLUMN IF NOT EXISTS job_token TEXT;

      ALTER TABLE credit_reservations
      ADD COLUMN IF NOT EXISTS request_id TEXT;

      ALTER TABLE credit_reservations
      ADD COLUMN IF NOT EXISTS payment_id TEXT;

      ALTER TABLE credit_reservations
      DROP CONSTRAINT IF EXISTS credit_reservations_service_idempotency_key_key;

      DROP INDEX IF EXISTS credit_reservations_service_job_token_idx;

      CREATE UNIQUE INDEX IF NOT EXISTS credit_reservations_active_idempotency_idx
      ON credit_reservations(service_id, idempotency_key)
      WHERE status IN ('reserved', 'captured');

      CREATE UNIQUE INDEX IF NOT EXISTS credit_reservations_active_job_token_idx
      ON credit_reservations(service_id, job_token)
      WHERE job_token IS NOT NULL AND status IN ('reserved', 'captured');

      UPDATE provider_services
      SET service_type = 'marketplace_proxy'
      WHERE service_type IS NULL;

      UPDATE published_service_versions
      SET service_type = 'marketplace_proxy'
      WHERE service_type IS NULL;

      UPDATE provider_services
      SET settlement_mode = 'verified_escrow'
      WHERE settlement_mode IS NULL;

      UPDATE published_service_versions versions
      SET settlement_mode = COALESCE(
        versions.settlement_mode,
        services.settlement_mode,
        'verified_escrow'
      )
      FROM provider_services services
      WHERE versions.service_id = services.id
        AND versions.settlement_mode IS NULL;

      UPDATE published_service_versions
      SET settlement_mode = 'verified_escrow'
      WHERE settlement_mode IS NULL;

      UPDATE published_endpoint_versions endpoints
      SET settlement_mode = COALESCE(
        endpoints.settlement_mode,
        versions.settlement_mode,
        'verified_escrow'
      )
      FROM published_service_versions versions
      WHERE endpoints.service_version_id = versions.version_id
        AND endpoints.settlement_mode IS NULL;

      UPDATE published_endpoint_versions
      SET settlement_mode = 'verified_escrow'
      WHERE settlement_mode IS NULL;

      UPDATE idempotency_records records
      SET pending_recovery_action = CASE
        WHEN published.executor_kind IN ('mock', 'marketplace') THEN 'retry'
        ELSE 'refund'
      END
      FROM (
        SELECT DISTINCT ON (route_id) route_id, executor_kind
        FROM published_endpoint_versions
        ORDER BY route_id, updated_at DESC, created_at DESC
      ) AS published
      WHERE records.pending_recovery_action IS NULL
        AND records.route_id = published.route_id;

      UPDATE idempotency_records
      SET pending_recovery_action = 'refund'
      WHERE pending_recovery_action IS NULL;

      ALTER TABLE idempotency_records
      ALTER COLUMN pending_recovery_action SET DEFAULT 'retry';

      ALTER TABLE idempotency_records
      ALTER COLUMN pending_recovery_action SET NOT NULL;

      ALTER TABLE provider_services
      ALTER COLUMN api_namespace DROP NOT NULL;

      ALTER TABLE provider_services
      ALTER COLUMN settlement_mode SET DEFAULT 'verified_escrow';

      ALTER TABLE provider_services
      ALTER COLUMN settlement_mode DROP NOT NULL;

      ALTER TABLE published_service_versions
      ALTER COLUMN api_namespace DROP NOT NULL;

      ALTER TABLE published_service_versions
      ALTER COLUMN settlement_mode SET DEFAULT 'verified_escrow';

      ALTER TABLE published_service_versions
      ALTER COLUMN settlement_mode DROP NOT NULL;

      ALTER TABLE published_endpoint_versions
      ALTER COLUMN settlement_mode SET DEFAULT 'verified_escrow';

      ALTER TABLE published_endpoint_versions
      ALTER COLUMN settlement_mode SET NOT NULL;

      UPDATE provider_endpoint_drafts
      SET billing = jsonb_build_object('type', 'fixed_x402', 'price', price)
      WHERE billing = '{}'::jsonb;

      UPDATE provider_endpoint_drafts
      SET method = 'POST'
      WHERE method IS NULL;

      UPDATE published_endpoint_versions
      SET billing = jsonb_build_object('type', 'fixed_x402', 'price', price)
      WHERE billing = '{}'::jsonb;

      UPDATE published_endpoint_versions
      SET method = 'POST'
      WHERE method IS NULL;

      UPDATE provider_payouts
      SET currency = 'USDC'
      WHERE currency = 'fastUSDC';

      UPDATE credit_accounts
      SET currency = 'USDC'
      WHERE currency = 'fastUSDC';

      UPDATE credit_reservations
      SET currency = 'USDC'
      WHERE currency = 'fastUSDC';

      UPDATE credit_ledger_entries
      SET currency = 'USDC'
      WHERE currency = 'fastUSDC';

      UPDATE idempotency_records
      SET payout_split = jsonb_set(payout_split, '{currency}', '"USDC"'::jsonb)
      WHERE payout_split->>'currency' = 'fastUSDC';

      UPDATE jobs
      SET payout_split = jsonb_set(payout_split, '{currency}', '"USDC"'::jsonb)
      WHERE payout_split->>'currency' = 'fastUSDC';

      ALTER TABLE refunds
      ALTER COLUMN job_token DROP NOT NULL;

      WITH ranked_refunds AS (
        SELECT
          ctid,
          ROW_NUMBER() OVER (
            PARTITION BY payment_id
            ORDER BY
              CASE status
                WHEN 'sent' THEN 0
                WHEN 'pending' THEN 1
                ELSE 2
              END,
              updated_at DESC,
              created_at DESC,
              id DESC
          ) AS row_num
        FROM refunds
      )
      DELETE FROM refunds
      WHERE ctid IN (
        SELECT ctid
        FROM ranked_refunds
        WHERE row_num > 1
      );

      CREATE UNIQUE INDEX IF NOT EXISTS refunds_payment_id_idx
      ON refunds(payment_id);
    `);

    await this.normalizeLegacyProviderColumnTypes();
    await this.seedDefaults();
  }

  private async normalizeLegacyProviderColumnTypes() {
    const textColumns: Array<[string, string]> = [
      ["provider_accounts", "owner_wallet"],
      ["provider_accounts", "display_name"],
      ["provider_accounts", "bio"],
      ["provider_accounts", "website_url"],
      ["provider_accounts", "contact_email"],
      ["provider_services", "service_type"],
      ["provider_services", "slug"],
      ["provider_services", "api_namespace"],
      ["provider_services", "settlement_mode"],
      ["provider_services", "name"],
      ["provider_services", "tagline"],
      ["provider_services", "about"],
      ["provider_services", "prompt_intro"],
      ["provider_services", "website_url"],
      ["provider_services", "payout_wallet"],
      ["provider_services", "status"],
      ["provider_services", "latest_submitted_version_id"],
      ["provider_services", "latest_published_version_id"],
      ["provider_services", "latest_review_id"],
      ["provider_endpoint_drafts", "route_id"],
      ["provider_endpoint_drafts", "operation"],
      ["provider_endpoint_drafts", "method"],
      ["provider_endpoint_drafts", "title"],
      ["provider_endpoint_drafts", "description"],
      ["provider_endpoint_drafts", "price"],
      ["provider_endpoint_drafts", "usage_notes"],
      ["provider_endpoint_drafts", "executor_kind"],
      ["provider_endpoint_drafts", "upstream_base_url"],
      ["provider_endpoint_drafts", "upstream_path"],
      ["provider_endpoint_drafts", "upstream_auth_mode"],
      ["provider_endpoint_drafts", "upstream_auth_header_name"],
      ["provider_endpoint_drafts", "upstream_secret_ref"],
      ["provider_external_endpoint_drafts", "title"],
      ["provider_external_endpoint_drafts", "description"],
      ["provider_external_endpoint_drafts", "method"],
      ["provider_external_endpoint_drafts", "public_url"],
      ["provider_external_endpoint_drafts", "docs_url"],
      ["provider_external_endpoint_drafts", "auth_notes"],
      ["provider_external_endpoint_drafts", "usage_notes"],
      ["provider_verifications", "token"],
      ["provider_verifications", "status"],
      ["provider_verifications", "verified_host"],
      ["provider_verifications", "failure_reason"],
      ["provider_reviews", "status"],
      ["provider_reviews", "review_notes"],
      ["provider_reviews", "reviewer_identity"],
      ["published_service_versions", "service_type"],
      ["published_service_versions", "slug"],
      ["published_service_versions", "api_namespace"],
      ["published_service_versions", "settlement_mode"],
      ["published_service_versions", "name"],
      ["published_service_versions", "owner_name"],
      ["published_service_versions", "tagline"],
      ["published_service_versions", "about"],
      ["published_service_versions", "prompt_intro"],
      ["published_service_versions", "website_url"],
      ["published_service_versions", "contact_email"],
      ["published_service_versions", "payout_wallet"],
      ["published_service_versions", "status"],
      ["published_service_versions", "submitted_review_id"],
      ["published_endpoint_versions", "route_id"],
      ["published_endpoint_versions", "provider"],
      ["published_endpoint_versions", "operation"],
      ["published_endpoint_versions", "version"],
      ["published_endpoint_versions", "method"],
      ["published_endpoint_versions", "settlement_mode"],
      ["published_endpoint_versions", "mode"],
      ["published_endpoint_versions", "network"],
      ["published_endpoint_versions", "price"],
      ["published_endpoint_versions", "title"],
      ["published_endpoint_versions", "description"],
      ["published_endpoint_versions", "usage_notes"],
      ["published_endpoint_versions", "executor_kind"],
      ["published_endpoint_versions", "upstream_base_url"],
      ["published_endpoint_versions", "upstream_path"],
      ["published_endpoint_versions", "upstream_auth_mode"],
      ["published_endpoint_versions", "upstream_auth_header_name"],
      ["published_endpoint_versions", "upstream_secret_ref"],
      ["published_external_endpoint_versions", "title"],
      ["published_external_endpoint_versions", "description"],
      ["published_external_endpoint_versions", "method"],
      ["published_external_endpoint_versions", "public_url"],
      ["published_external_endpoint_versions", "docs_url"],
      ["published_external_endpoint_versions", "auth_notes"],
      ["published_external_endpoint_versions", "usage_notes"],
      ["provider_secrets", "label"],
      ["provider_secrets", "secret_ciphertext"],
      ["provider_secrets", "iv"],
      ["provider_secrets", "auth_tag"]
    ];
    const booleanColumns: Array<[string, string]> = [
      ["provider_services", "featured"],
      ["published_service_versions", "featured"]
    ];

    for (const [table, column] of textColumns) {
      await this.coerceLegacyJsonColumnToText(table, column);
    }

    for (const [table, column] of booleanColumns) {
      await this.coerceLegacyJsonColumnToBoolean(table, column);
    }
  }

  private async coerceLegacyJsonColumnToText(table: string, column: string) {
    const result = await this.pool.query(
      `
      SELECT udt_name
      FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = $1
        AND column_name = $2
      LIMIT 1
      `,
      [table, column]
    );

    if (!result.rowCount) {
      return;
    }

    const type = result.rows[0].udt_name as string;
    if (type !== "json" && type !== "jsonb") {
      return;
    }

    const quotedTable = quoteIdentifier(table);
    const quotedColumn = quoteIdentifier(column);

    await this.pool.query(
      `
      ALTER TABLE ${quotedTable}
      ALTER COLUMN ${quotedColumn} TYPE TEXT
      USING trim(both '"' from ${quotedColumn}::text)
      `
    );
  }

  private async coerceLegacyJsonColumnToBoolean(table: string, column: string) {
    const result = await this.pool.query(
      `
      SELECT udt_name
      FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = $1
        AND column_name = $2
      LIMIT 1
      `,
      [table, column]
    );

    if (!result.rowCount) {
      return;
    }

    const type = result.rows[0].udt_name as string;
    if (type !== "json" && type !== "jsonb") {
      return;
    }

    const quotedTable = quoteIdentifier(table);
    const quotedColumn = quoteIdentifier(column);

    await this.pool.query(
      `
      ALTER TABLE ${quotedTable}
      ALTER COLUMN ${quotedColumn} TYPE BOOLEAN
      USING CASE
        WHEN ${quotedColumn} IS NULL THEN FALSE
        ELSE COALESCE(lower(trim(both '"' from ${quotedColumn}::text)) = 'true', FALSE)
      END
      `
    );
  }

  private async seedDefaults() {
    const network = this.networkConfig;
    const account = MARKETPLACE_PROVIDER_ACCOUNT_SEED;
    const services = buildSeededProviderServices(network);
    const draftEndpoints = buildSeededProviderEndpointDrafts(network);
    const publishedServices = buildSeededPublishedServiceVersions(network);
    const publishedEndpoints = buildSeededPublishedEndpointVersions(network);
    const publishedServiceByServiceId = new Map(publishedServices.map((service) => [service.serviceId, service]));
    const activeSeededServiceIds = new Set(services.map((service) => service.id));
    const staleSeededServiceIds = SEEDED_PROVIDER_SERVICE_IDS.filter((serviceId) => !activeSeededServiceIds.has(serviceId));

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      if (staleSeededServiceIds.length > 0) {
        await client.query("DELETE FROM provider_services WHERE id = ANY($1::text[])", [staleSeededServiceIds]);
      }

      await client.query(
        `
        INSERT INTO provider_accounts (id, owner_wallet, display_name, bio, website_url, contact_email, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        ON CONFLICT (id) DO UPDATE SET
          owner_wallet = EXCLUDED.owner_wallet,
          display_name = EXCLUDED.display_name,
          bio = EXCLUDED.bio,
          website_url = EXCLUDED.website_url,
          contact_email = EXCLUDED.contact_email,
          updated_at = EXCLUDED.updated_at
        `,
        [
          account.id,
          account.ownerWallet,
          account.displayName,
          account.bio,
          account.websiteUrl,
          account.contactEmail,
          account.createdAt,
          account.updatedAt
        ]
      );

      for (const service of services) {
        const publishedService = publishedServiceByServiceId.get(service.id);
        if (!publishedService) {
          throw new Error(`Seeded published service missing for ${service.id}.`);
        }

        await client.query(
          `
          INSERT INTO provider_services (
            id, provider_account_id, service_type, settlement_mode, slug, api_namespace, name, tagline, about, categories, prompt_intro,
            setup_instructions, website_url, payout_wallet, featured, status, latest_submitted_version_id,
            latest_published_version_id, latest_review_id, created_at, updated_at
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12::jsonb, $13, $14, $15, $16, $17, $18, NULL, $19, $20
          )
          ON CONFLICT (id) DO UPDATE SET
            provider_account_id = EXCLUDED.provider_account_id,
            service_type = EXCLUDED.service_type,
            settlement_mode = EXCLUDED.settlement_mode,
            slug = EXCLUDED.slug,
            api_namespace = EXCLUDED.api_namespace,
            name = EXCLUDED.name,
            tagline = EXCLUDED.tagline,
            about = EXCLUDED.about,
            categories = EXCLUDED.categories,
            prompt_intro = EXCLUDED.prompt_intro,
            setup_instructions = EXCLUDED.setup_instructions,
            website_url = EXCLUDED.website_url,
            payout_wallet = EXCLUDED.payout_wallet,
            featured = EXCLUDED.featured,
            status = EXCLUDED.status,
            latest_submitted_version_id = EXCLUDED.latest_submitted_version_id,
            latest_published_version_id = EXCLUDED.latest_published_version_id,
            updated_at = EXCLUDED.updated_at
          `,
          [
            service.id,
            service.providerAccountId,
            service.serviceType,
            service.settlementMode,
            service.slug,
            service.apiNamespace,
            service.name,
            service.tagline,
            service.about,
            JSON.stringify(service.categories),
            service.promptIntro,
            JSON.stringify(service.setupInstructions),
            service.websiteUrl,
            service.payoutWallet,
            service.featured,
            service.status,
            publishedService.versionId,
            publishedService.versionId,
            service.createdAt,
            service.updatedAt
          ]
        );
      }

      for (const endpoint of draftEndpoints.filter(isMarketplaceEndpointDraft)) {
        await client.query(
          `
          INSERT INTO provider_endpoint_drafts (
            id, service_id, route_id, operation, method, title, description, price, billing, mode, request_schema_json, response_schema_json,
            request_example, response_example, usage_notes, executor_kind, async_config, upstream_base_url, upstream_path,
            upstream_auth_mode, upstream_auth_header_name, upstream_secret_ref, payout, created_at, updated_at
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11::jsonb, $12::jsonb, $13::jsonb, $14::jsonb, $15, $16, $17::jsonb, $18, $19,
            $20, $21, $22, $23::jsonb, $24, $25
          )
          ON CONFLICT (id) DO UPDATE SET
            route_id = EXCLUDED.route_id,
            operation = EXCLUDED.operation,
            method = EXCLUDED.method,
            title = EXCLUDED.title,
            description = EXCLUDED.description,
            price = EXCLUDED.price,
            billing = EXCLUDED.billing,
            mode = EXCLUDED.mode,
            request_schema_json = EXCLUDED.request_schema_json,
            response_schema_json = EXCLUDED.response_schema_json,
            request_example = EXCLUDED.request_example,
            response_example = EXCLUDED.response_example,
            usage_notes = EXCLUDED.usage_notes,
            executor_kind = EXCLUDED.executor_kind,
            async_config = EXCLUDED.async_config,
            upstream_base_url = EXCLUDED.upstream_base_url,
            upstream_path = EXCLUDED.upstream_path,
            upstream_auth_mode = EXCLUDED.upstream_auth_mode,
            upstream_auth_header_name = EXCLUDED.upstream_auth_header_name,
            upstream_secret_ref = EXCLUDED.upstream_secret_ref,
            payout = EXCLUDED.payout,
            updated_at = EXCLUDED.updated_at
          `,
          [
            endpoint.id,
            endpoint.serviceId,
            endpoint.routeId,
            endpoint.operation,
            endpoint.method,
            endpoint.title,
            endpoint.description,
            endpoint.price,
            JSON.stringify(endpoint.billing),
            endpoint.mode,
            JSON.stringify(endpoint.requestSchemaJson),
            JSON.stringify(endpoint.responseSchemaJson),
            JSON.stringify(endpoint.requestExample),
            JSON.stringify(endpoint.responseExample),
            endpoint.usageNotes,
            endpoint.executorKind,
            JSON.stringify(endpoint.asyncConfig ?? null),
            endpoint.upstreamBaseUrl,
            endpoint.upstreamPath,
            endpoint.upstreamAuthMode,
            endpoint.upstreamAuthHeaderName,
            endpoint.upstreamSecretRef,
            JSON.stringify(endpoint.payout),
            endpoint.createdAt,
            endpoint.updatedAt
          ]
        );
      }

      for (const publishedService of publishedServices) {
        await client.query(
          `
          INSERT INTO published_service_versions (
            version_id, service_id, provider_account_id, service_type, settlement_mode, slug, api_namespace, name, owner_name, tagline, about,
            categories, route_ids, featured, prompt_intro, setup_instructions, website_url, contact_email,
            payout_wallet, status, submitted_review_id, published_at, created_at, updated_at
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13::jsonb, $14, $15, $16::jsonb, $17, $18,
            $19, $20, $21, $22, $23, $24
          )
          ON CONFLICT (version_id) DO UPDATE SET
            service_type = EXCLUDED.service_type,
            settlement_mode = EXCLUDED.settlement_mode,
            owner_name = EXCLUDED.owner_name,
            tagline = EXCLUDED.tagline,
            about = EXCLUDED.about,
            categories = EXCLUDED.categories,
            route_ids = EXCLUDED.route_ids,
            featured = EXCLUDED.featured,
            prompt_intro = EXCLUDED.prompt_intro,
            setup_instructions = EXCLUDED.setup_instructions,
            website_url = EXCLUDED.website_url,
            contact_email = EXCLUDED.contact_email,
            payout_wallet = EXCLUDED.payout_wallet,
            status = EXCLUDED.status,
            updated_at = EXCLUDED.updated_at
          `,
          [
            publishedService.versionId,
            publishedService.serviceId,
            publishedService.providerAccountId,
            publishedService.serviceType,
            publishedService.settlementMode,
            publishedService.slug,
            publishedService.apiNamespace,
            publishedService.name,
            publishedService.ownerName,
            publishedService.tagline,
            publishedService.about,
            JSON.stringify(publishedService.categories),
            JSON.stringify(publishedService.routeIds),
            publishedService.featured,
            publishedService.promptIntro,
            JSON.stringify(publishedService.setupInstructions),
            publishedService.websiteUrl,
            publishedService.contactEmail,
            publishedService.payoutWallet,
            publishedService.status,
            publishedService.submittedReviewId,
            publishedService.publishedAt,
            publishedService.createdAt,
            publishedService.updatedAt
          ]
        );
      }

      for (const endpoint of publishedEndpoints) {
        await client.query(
          `
          INSERT INTO published_endpoint_versions (
            endpoint_version_id, service_id, service_version_id, endpoint_draft_id, route_id, provider, operation,
            version, method, settlement_mode, mode, network, price, billing, async_config, title, description, payout, request_example, response_example, usage_notes,
            request_schema_json, response_schema_json, executor_kind, upstream_base_url, upstream_path, upstream_auth_mode,
            upstream_auth_header_name, upstream_secret_ref, created_at, updated_at
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, $15::jsonb, $16, $17, $18::jsonb, $19::jsonb, $20::jsonb, $21,
            $22::jsonb, $23::jsonb, $24, $25, $26, $27, $28, $29, $30, $31
          )
          ON CONFLICT (endpoint_version_id) DO UPDATE SET
            route_id = EXCLUDED.route_id,
            provider = EXCLUDED.provider,
            operation = EXCLUDED.operation,
            version = EXCLUDED.version,
            method = EXCLUDED.method,
            settlement_mode = EXCLUDED.settlement_mode,
            mode = EXCLUDED.mode,
            network = EXCLUDED.network,
            price = EXCLUDED.price,
            billing = EXCLUDED.billing,
            async_config = EXCLUDED.async_config,
            title = EXCLUDED.title,
            description = EXCLUDED.description,
            payout = EXCLUDED.payout,
            request_example = EXCLUDED.request_example,
            response_example = EXCLUDED.response_example,
            usage_notes = EXCLUDED.usage_notes,
            request_schema_json = EXCLUDED.request_schema_json,
            response_schema_json = EXCLUDED.response_schema_json,
            executor_kind = EXCLUDED.executor_kind,
            upstream_base_url = EXCLUDED.upstream_base_url,
            upstream_path = EXCLUDED.upstream_path,
            upstream_auth_mode = EXCLUDED.upstream_auth_mode,
            upstream_auth_header_name = EXCLUDED.upstream_auth_header_name,
            upstream_secret_ref = EXCLUDED.upstream_secret_ref,
            updated_at = EXCLUDED.updated_at
          `,
          [
            endpoint.endpointVersionId,
            endpoint.serviceId,
            endpoint.serviceVersionId,
            endpoint.endpointDraftId,
            endpoint.routeId,
            endpoint.provider,
            endpoint.operation,
            endpoint.version,
            endpoint.method,
            endpoint.settlementMode,
            endpoint.mode,
            endpoint.network,
            endpoint.price,
            JSON.stringify(endpoint.billing),
            JSON.stringify(endpoint.asyncConfig ?? null),
            endpoint.title,
            endpoint.description,
            JSON.stringify(endpoint.payout),
            JSON.stringify(endpoint.requestExample),
            JSON.stringify(endpoint.responseExample),
            endpoint.usageNotes ?? null,
            JSON.stringify(endpoint.requestSchemaJson),
            JSON.stringify(endpoint.responseSchemaJson),
            endpoint.executorKind,
            endpoint.upstreamBaseUrl,
            endpoint.upstreamPath,
            endpoint.upstreamAuthMode,
            endpoint.upstreamAuthHeaderName,
            endpoint.upstreamSecretRef,
            endpoint.createdAt,
            endpoint.updatedAt
          ]
        );
      }

      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async getIdempotencyByPaymentId(paymentId: string): Promise<IdempotencyRecord | null> {
    const result = await this.pool.query("SELECT * FROM idempotency_records WHERE payment_id = $1", [paymentId]);
    return result.rowCount ? mapIdempotencyRow(result.rows[0]) : null;
  }

  async claimPaymentExecution(input: ClaimPaymentExecutionInput): Promise<ClaimPaymentExecutionResult> {
    try {
      const result = await this.pool.query(
        `
        INSERT INTO idempotency_records (
          payment_id, normalized_request_hash, buyer_wallet, route_id, route_version,
          pending_recovery_action, quoted_price, payout_split, payment_payload, facilitator_response, response_kind,
          response_status_code, response_body, response_headers, provider_payout_source_kind,
          execution_status, request_id, job_token
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10::jsonb, $11,
          202, $12::jsonb, $13::jsonb, NULL, 'pending', $14, $15
        )
        RETURNING *
        `,
        [
          input.paymentId,
          input.normalizedRequestHash,
          input.buyerWallet,
          input.routeId,
          input.routeVersion,
          input.pendingRecoveryAction,
          input.quotedPrice,
          JSON.stringify(input.payoutSplit),
          input.paymentPayload,
          JSON.stringify(input.facilitatorResponse),
          input.responseKind,
          JSON.stringify(input.responseBody ?? { status: "processing" }),
          JSON.stringify(input.responseHeaders ?? {}),
          input.requestId,
          input.jobToken ?? null
        ]
      );

      return {
        record: mapIdempotencyRow(result.rows[0]),
        created: true
      };
    } catch (error) {
      if (!isPostgresUniqueViolation(error)) {
        throw error;
      }

      const existing = await this.getIdempotencyByPaymentId(input.paymentId);
      if (!existing) {
        throw error;
      }

      return {
        record: existing,
        created: false
      };
    }
  }

  async touchPendingPaymentExecution(paymentId: string): Promise<IdempotencyRecord | null> {
    const result = await this.pool.query(
      `
      UPDATE idempotency_records
      SET updated_at = NOW()
      WHERE payment_id = $1
        AND execution_status = 'pending'
      RETURNING *
      `,
      [paymentId]
    );
    if (result.rowCount) {
      return mapIdempotencyRow(result.rows[0]);
    }

    return this.getIdempotencyByPaymentId(paymentId);
  }

  async completePendingJobExecution(input: {
    paymentId: string;
    jobToken: string;
    responseBody: unknown;
    responseHeaders?: Record<string, string>;
  }): Promise<IdempotencyRecord | null> {
    const result = await this.pool.query(
      `
      UPDATE idempotency_records
      SET
        response_kind = 'job',
        response_status_code = 202,
        response_body = $2::jsonb,
        response_headers = COALESCE($3::jsonb, response_headers),
        execution_status = 'completed',
        job_token = COALESCE(job_token, $4),
        updated_at = NOW()
      WHERE payment_id = $1
        AND execution_status = 'pending'
      RETURNING *
      `,
      [
        input.paymentId,
        JSON.stringify(input.responseBody),
        input.responseHeaders === undefined ? null : JSON.stringify(input.responseHeaders),
        input.jobToken
      ]
    );
    if (result.rowCount) {
      return mapIdempotencyRow(result.rows[0]);
    }

    return this.getIdempotencyByPaymentId(input.paymentId);
  }

  async listStalePendingPaymentExecutions(updatedBefore: string, limit: number): Promise<IdempotencyRecord[]> {
    if (limit <= 0) {
      return [];
    }

    const result = await this.pool.query(
      `
      SELECT *
      FROM idempotency_records
      WHERE execution_status = 'pending'
        AND updated_at <= $1
      ORDER BY updated_at ASC
      LIMIT $2
      `,
      [updatedBefore, limit]
    );
    return result.rows.map(mapIdempotencyRow);
  }

  async saveSyncIdempotency(input: SaveSyncIdempotencyInput): Promise<IdempotencyRecord> {
    const result = await this.pool.query(
      `
      INSERT INTO idempotency_records (
        payment_id, normalized_request_hash, buyer_wallet, route_id, route_version,
        pending_recovery_action, quoted_price, payout_split, payment_payload, facilitator_response, response_kind,
        response_status_code, response_body, response_headers, provider_payout_source_kind,
        execution_status, request_id, job_token
      ) VALUES (
        $1, $2, $3, $4, $5, 'retry', $6, $7::jsonb, $8, $9::jsonb, 'sync', $10, $11::jsonb, $12::jsonb, $13,
        'completed', $14, NULL
      )
      ON CONFLICT (payment_id) DO UPDATE
      SET
        normalized_request_hash = EXCLUDED.normalized_request_hash,
        buyer_wallet = EXCLUDED.buyer_wallet,
        route_id = EXCLUDED.route_id,
        route_version = EXCLUDED.route_version,
        pending_recovery_action = COALESCE(idempotency_records.pending_recovery_action, EXCLUDED.pending_recovery_action),
        quoted_price = EXCLUDED.quoted_price,
        payout_split = EXCLUDED.payout_split,
        payment_payload = EXCLUDED.payment_payload,
        facilitator_response = EXCLUDED.facilitator_response,
        response_kind = 'sync',
        response_status_code = EXCLUDED.response_status_code,
        response_body = EXCLUDED.response_body,
        response_headers = EXCLUDED.response_headers,
        provider_payout_source_kind = EXCLUDED.provider_payout_source_kind,
        execution_status = 'completed',
        request_id = COALESCE(idempotency_records.request_id, EXCLUDED.request_id),
        updated_at = NOW()
      RETURNING *
      `,
      [
        input.paymentId,
        input.normalizedRequestHash,
        input.buyerWallet,
        input.routeId,
        input.routeVersion,
        input.quotedPrice,
        JSON.stringify(input.payoutSplit),
        input.paymentPayload,
        JSON.stringify(input.facilitatorResponse),
        input.statusCode,
        JSON.stringify(input.body),
        JSON.stringify(input.headers ?? {}),
        input.providerPayoutSourceKind ?? null,
        input.requestId ?? null
      ]
    );

    return mapIdempotencyRow(result.rows[0]);
  }

  async saveAsyncAcceptance(input: SaveAsyncAcceptanceInput): Promise<{ idempotency: IdempotencyRecord; job: JobRecord }> {
    const client = await this.pool.connect();

    try {
      await client.query("BEGIN");
      const now = timestamp();
      const idempotencyResult = await client.query(
        `
        INSERT INTO idempotency_records (
          payment_id, normalized_request_hash, buyer_wallet, route_id, route_version,
          pending_recovery_action, quoted_price, payout_split, payment_payload, facilitator_response, response_kind,
          response_status_code, response_body, response_headers, job_token, execution_status, request_id
        ) VALUES ($1, $2, $3, $4, $5, 'retry', $6, $7::jsonb, $8, $9::jsonb, 'job', 202, $10::jsonb, $11::jsonb, $12, 'completed', $13)
        ON CONFLICT (payment_id) DO UPDATE
        SET
          normalized_request_hash = EXCLUDED.normalized_request_hash,
          buyer_wallet = EXCLUDED.buyer_wallet,
          route_id = EXCLUDED.route_id,
          route_version = EXCLUDED.route_version,
          pending_recovery_action =
            COALESCE(idempotency_records.pending_recovery_action, EXCLUDED.pending_recovery_action),
          quoted_price = EXCLUDED.quoted_price,
          payout_split = EXCLUDED.payout_split,
          payment_payload = EXCLUDED.payment_payload,
          facilitator_response = EXCLUDED.facilitator_response,
          response_kind = 'job',
          response_status_code = 202,
          response_body = EXCLUDED.response_body,
          response_headers = EXCLUDED.response_headers,
          job_token = COALESCE(idempotency_records.job_token, EXCLUDED.job_token),
          execution_status = 'completed',
          request_id = COALESCE(idempotency_records.request_id, EXCLUDED.request_id),
          updated_at = NOW()
        RETURNING *
        `,
        [
          input.paymentId,
          input.normalizedRequestHash,
          input.buyerWallet,
          input.route.routeId,
          input.route.version,
          input.quotedPrice,
          JSON.stringify(input.payoutSplit),
          input.paymentPayload,
          JSON.stringify(input.facilitatorResponse),
          JSON.stringify(input.responseBody),
          JSON.stringify(input.responseHeaders ?? {}),
          input.jobToken,
          input.requestId ?? null
        ]
      );

      const persistedIdempotency = mapIdempotencyRow(idempotencyResult.rows[0]);
      const persistedJobToken = persistedIdempotency.jobToken ?? input.jobToken;
      const existingJobResult = await client.query(
        "SELECT * FROM jobs WHERE job_token = $1 LIMIT 1 FOR UPDATE",
        [persistedJobToken]
      );
      const mergedJob = buildAcceptedAsyncJobRecord({
        ...input,
        jobToken: persistedJobToken
      }, existingJobResult.rowCount ? mapJobRow(existingJobResult.rows[0]) : null, now);

      const jobResult = existingJobResult.rowCount
        ? await client.query(
            `
            UPDATE jobs
            SET
              payment_id = $2,
              route_id = $3,
              service_id = $4,
              provider = $5,
              operation = $6,
              buyer_wallet = $7,
              quoted_price = $8,
              payout_split = $9::jsonb,
              request_id = $10,
              provider_job_id = $11,
              request_body = $12::jsonb,
              route_snapshot = $13::jsonb,
              provider_state = $14::jsonb,
              next_poll_at = $15,
              timeout_at = $16,
              status = $17,
              result_body = $18::jsonb,
              error_message = $19,
              refund_status = $20,
              refund_id = $21,
              updated_at = NOW()
            WHERE job_token = $1
            RETURNING *
            `,
            [
              mergedJob.jobToken,
              mergedJob.paymentId,
              mergedJob.routeId,
              mergedJob.serviceId,
              mergedJob.provider,
              mergedJob.operation,
              mergedJob.buyerWallet,
              mergedJob.quotedPrice,
              JSON.stringify(mergedJob.payoutSplit),
              mergedJob.requestId,
              mergedJob.providerJobId,
              JSON.stringify(mergedJob.requestBody),
              JSON.stringify(mergedJob.routeSnapshot),
              JSON.stringify(mergedJob.providerState ?? null),
              mergedJob.nextPollAt,
              mergedJob.timeoutAt,
              mergedJob.status,
              JSON.stringify(mergedJob.resultBody),
              mergedJob.errorMessage,
              mergedJob.refundStatus,
              mergedJob.refundId
            ]
          )
        : await client.query(
            `
            INSERT INTO jobs (
              job_token, payment_id, route_id, service_id, provider, operation, buyer_wallet, quoted_price,
              payout_split, request_id, provider_job_id, request_body, route_snapshot, provider_state, next_poll_at, timeout_at,
              status, result_body, error_message, refund_status, refund_id
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12::jsonb, $13::jsonb, $14::jsonb, $15, $16, $17, $18::jsonb, $19, $20, $21)
            RETURNING *
            `,
            [
              mergedJob.jobToken,
              mergedJob.paymentId,
              mergedJob.routeId,
              mergedJob.serviceId,
              mergedJob.provider,
              mergedJob.operation,
              mergedJob.buyerWallet,
              mergedJob.quotedPrice,
              JSON.stringify(mergedJob.payoutSplit),
              mergedJob.requestId,
              mergedJob.providerJobId,
              JSON.stringify(mergedJob.requestBody),
              JSON.stringify(mergedJob.routeSnapshot),
              JSON.stringify(mergedJob.providerState ?? null),
              mergedJob.nextPollAt,
              mergedJob.timeoutAt,
              mergedJob.status,
              JSON.stringify(mergedJob.resultBody),
              mergedJob.errorMessage,
              mergedJob.refundStatus,
              mergedJob.refundId
            ]
          );

      await client.query(
        `
        INSERT INTO access_grants (id, resource_type, resource_id, wallet, payment_id, metadata)
        VALUES ($1, 'job', $2, $3, $4, $5::jsonb)
        ON CONFLICT (resource_type, resource_id, wallet) DO NOTHING
        `,
        [
          randomUUID(),
          persistedIdempotency.jobToken ?? input.jobToken,
          input.buyerWallet,
          input.paymentId,
          JSON.stringify({
            routeId: input.route.routeId
          })
        ]
      );

      await client.query("COMMIT");
      return {
        idempotency: persistedIdempotency,
        job: mapJobRow(jobResult.rows[0])
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async savePendingAsyncJob(input: SavePendingAsyncJobInput): Promise<JobRecord> {
    const client = await this.pool.connect();

    try {
      await client.query("BEGIN");
      const now = timestamp();
      const existingResult = await client.query(
        "SELECT * FROM jobs WHERE job_token = $1 LIMIT 1 FOR UPDATE",
        [input.jobToken]
      );
      const mergedJob = buildPendingAsyncJobRecord(input, existingResult.rowCount ? mapJobRow(existingResult.rows[0]) : null, now);

      const result = existingResult.rowCount
        ? await client.query(
            `
            UPDATE jobs
            SET
              payment_id = $2,
              route_id = $3,
              service_id = $4,
              provider = $5,
              operation = $6,
              buyer_wallet = $7,
              quoted_price = $8,
              payout_split = $9::jsonb,
              request_id = $10,
              provider_job_id = $11,
              request_body = $12::jsonb,
              route_snapshot = $13::jsonb,
              provider_state = $14::jsonb,
              next_poll_at = $15,
              timeout_at = $16,
              status = $17,
              result_body = $18::jsonb,
              error_message = $19,
              refund_status = $20,
              refund_id = $21,
              updated_at = NOW()
            WHERE job_token = $1
            RETURNING *
            `,
            [
              mergedJob.jobToken,
              mergedJob.paymentId,
              mergedJob.routeId,
              mergedJob.serviceId,
              mergedJob.provider,
              mergedJob.operation,
              mergedJob.buyerWallet,
              mergedJob.quotedPrice,
              JSON.stringify(mergedJob.payoutSplit),
              mergedJob.requestId,
              mergedJob.providerJobId,
              JSON.stringify(mergedJob.requestBody),
              JSON.stringify(mergedJob.routeSnapshot),
              JSON.stringify(mergedJob.providerState ?? null),
              mergedJob.nextPollAt,
              mergedJob.timeoutAt,
              mergedJob.status,
              JSON.stringify(mergedJob.resultBody),
              mergedJob.errorMessage,
              mergedJob.refundStatus,
              mergedJob.refundId
            ]
          )
        : await client.query(
            `
            INSERT INTO jobs (
              job_token, payment_id, route_id, service_id, provider, operation, buyer_wallet, quoted_price,
              payout_split, request_id, provider_job_id, request_body, route_snapshot, provider_state, next_poll_at, timeout_at,
              status, result_body, error_message, refund_status, refund_id
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12::jsonb, $13::jsonb, $14::jsonb, $15, $16, $17, $18::jsonb, $19, $20, $21)
            RETURNING *
            `,
            [
              mergedJob.jobToken,
              mergedJob.paymentId,
              mergedJob.routeId,
              mergedJob.serviceId,
              mergedJob.provider,
              mergedJob.operation,
              mergedJob.buyerWallet,
              mergedJob.quotedPrice,
              JSON.stringify(mergedJob.payoutSplit),
              mergedJob.requestId,
              mergedJob.providerJobId,
              JSON.stringify(mergedJob.requestBody),
              JSON.stringify(mergedJob.routeSnapshot),
              JSON.stringify(mergedJob.providerState ?? null),
              mergedJob.nextPollAt,
              mergedJob.timeoutAt,
              mergedJob.status,
              JSON.stringify(mergedJob.resultBody),
              mergedJob.errorMessage,
              mergedJob.refundStatus,
              mergedJob.refundId
            ]
          );

      await client.query("COMMIT");
      return mapJobRow(result.rows[0]);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async getJob(jobToken: string): Promise<JobRecord | null> {
    const result = await this.pool.query("SELECT * FROM jobs WHERE job_token = $1", [jobToken]);
    return result.rowCount ? mapJobRow(result.rows[0]) : null;
  }

  async listPendingJobs(input: { limit: number; now?: string }): Promise<JobRecord[]> {
    if (input.limit <= 0) {
      return [];
    }

    const now = input.now ?? new Date().toISOString();
    const result = await this.pool.query(
      `
      SELECT *
      FROM jobs
      WHERE status = 'pending'
        AND (
          (timeout_at IS NOT NULL AND timeout_at <= $1::timestamptz)
          OR (
            provider_job_id IS NULL
            AND (next_poll_at IS NULL OR next_poll_at <= $1::timestamptz)
          )
          OR (
            provider_job_id IS NOT NULL
            AND COALESCE(route_snapshot->'asyncConfig'->>'strategy', '') <> 'webhook'
            AND (next_poll_at IS NULL OR next_poll_at <= $1::timestamptz)
          )
        )
      ORDER BY
        CASE WHEN timeout_at IS NOT NULL AND timeout_at <= $1::timestamptz THEN 0 ELSE 1 END,
        CASE WHEN provider_job_id IS NOT NULL THEN 0 ELSE 1 END,
        created_at ASC
      LIMIT $2
      `,
      [now, input.limit]
    );
    return result.rows.map(mapJobRow);
  }

  async updateJobPending(input: {
    jobToken: string;
    providerState?: Record<string, unknown> | null;
    nextPollAt?: string | null;
  }): Promise<JobRecord> {
    const result = await this.pool.query(
      `
      UPDATE jobs
      SET
        provider_state = CASE
          WHEN $2::jsonb IS NULL AND $3::boolean THEN provider_state
          ELSE $2::jsonb
        END,
        next_poll_at = CASE
          WHEN $4::timestamptz IS NULL AND $5::boolean THEN next_poll_at
          ELSE $4::timestamptz
        END,
        updated_at = NOW()
      WHERE job_token = $1
      RETURNING *
      `,
      [
        input.jobToken,
        JSON.stringify(input.providerState ?? null),
        input.providerState === undefined,
        input.nextPollAt ?? null,
        input.nextPollAt === undefined
      ]
    );

    return mapJobRow(result.rows[0]);
  }

  async completeJob(jobToken: string, body: unknown): Promise<JobRecord> {
    const result = await this.pool.query(
      `
      WITH updated AS (
        UPDATE jobs
        SET status = 'completed', result_body = $2::jsonb, error_message = NULL, next_poll_at = NULL, updated_at = NOW()
        WHERE job_token = $1
          AND status = 'pending'
        RETURNING *
      )
      SELECT * FROM updated
      UNION ALL
      SELECT * FROM jobs
      WHERE job_token = $1
        AND NOT EXISTS (SELECT 1 FROM updated)
      `,
      [jobToken, JSON.stringify(body)]
    );

    return mapJobRow(result.rows[0]);
  }

  async failJob(jobToken: string, error: string): Promise<JobRecord> {
    const result = await this.pool.query(
      `
      WITH updated AS (
        UPDATE jobs
        SET status = 'failed', error_message = $2, next_poll_at = NULL, updated_at = NOW()
        WHERE job_token = $1
          AND status = 'pending'
        RETURNING *
      )
      SELECT * FROM updated
      UNION ALL
      SELECT * FROM jobs
      WHERE job_token = $1
        AND NOT EXISTS (SELECT 1 FROM updated)
      `,
      [jobToken, error]
    );

    return mapJobRow(result.rows[0]);
  }

  async createAccessGrant(input: {
    resourceType: ResourceType;
    resourceId: string;
    wallet: string;
    paymentId: string;
    metadata?: Record<string, unknown>;
  }): Promise<AccessGrantRecord> {
    const existing = await this.getAccessGrant(input.resourceType, input.resourceId, input.wallet);
    if (existing) {
      return existing;
    }

    const result = await this.pool.query(
      `
      INSERT INTO access_grants (id, resource_type, resource_id, wallet, payment_id, metadata)
      VALUES ($1, $2, $3, $4, $5, $6::jsonb)
      RETURNING *
      `,
      [randomUUID(), input.resourceType, input.resourceId, input.wallet, input.paymentId, JSON.stringify(input.metadata ?? {})]
    );

    return mapAccessGrantRow(result.rows[0]);
  }

  async getAccessGrant(resourceType: ResourceType, resourceId: string, wallet: string): Promise<AccessGrantRecord | null> {
    const result = await this.pool.query(
      `
      SELECT * FROM access_grants
      WHERE resource_type = $1 AND resource_id = $2 AND wallet = $3
      `,
      [resourceType, resourceId, wallet]
    );
    return result.rowCount ? mapAccessGrantRow(result.rows[0]) : null;
  }

  async recordProviderAttempt(input: {
    jobToken?: string | null;
    paymentId?: string | null;
    routeId: string;
    requestId?: string | null;
    responseStatusCode?: number | null;
    phase: "execute" | "poll" | "callback" | "refund";
    status: "pending" | "succeeded" | "failed";
    requestPayload?: unknown;
    responsePayload?: unknown;
    errorMessage?: string;
  }): Promise<ProviderAttemptRecord> {
    const result = await this.pool.query(
      `
      INSERT INTO provider_attempts (
        id, job_token, payment_id, route_id, request_id, response_status_code, phase, status, request_payload, response_payload, error_message
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11)
      RETURNING *
      `,
      [
        randomUUID(),
        input.jobToken ?? null,
        input.paymentId ?? null,
        input.routeId,
        input.requestId ?? null,
        input.responseStatusCode ?? null,
        input.phase,
        input.status,
        JSON.stringify(input.requestPayload ?? null),
        JSON.stringify(input.responsePayload ?? null),
        input.errorMessage ?? null
      ]
    );

    return mapAttemptRow(result.rows[0]);
  }

  async getLatestSuccessfulProviderExecuteAttempt(jobToken: string): Promise<ProviderAttemptRecord | null> {
    const result = await this.pool.query(
      `
      SELECT *
      FROM provider_attempts
      WHERE job_token = $1
        AND phase = 'execute'
        AND status = 'succeeded'
      ORDER BY created_at DESC
      LIMIT 1
      `,
      [jobToken]
    );

    return result.rowCount ? mapAttemptRow(result.rows[0]) : null;
  }

  async getLatestSuccessfulProviderExecuteAttemptByPaymentId(paymentId: string): Promise<ProviderAttemptRecord | null> {
    const result = await this.pool.query(
      `
      SELECT *
      FROM provider_attempts
      WHERE payment_id = $1
        AND phase = 'execute'
        AND status = 'succeeded'
      ORDER BY created_at DESC
      LIMIT 1
      `,
      [paymentId]
    );

    return result.rowCount ? mapAttemptRow(result.rows[0]) : null;
  }

  async getLatestProviderExecuteAttempt(jobToken: string): Promise<ProviderAttemptRecord | null> {
    const result = await this.pool.query(
      `
      SELECT *
      FROM provider_attempts
      WHERE job_token = $1
        AND phase = 'execute'
      ORDER BY created_at DESC
      LIMIT 1
      `,
      [jobToken]
    );

    return result.rowCount ? mapAttemptRow(result.rows[0]) : null;
  }

  async createRefund(input: {
    jobToken?: string | null;
    paymentId: string;
    wallet: string;
    amount: string;
  }): Promise<RefundRecord> {
    const jobToken = input.jobToken ?? null;
    const existingResult = await this.pool.query(
      `
      SELECT *
      FROM refunds
      WHERE payment_id = $1
        OR ($2::text IS NOT NULL AND job_token = $2)
      ORDER BY created_at ASC
      LIMIT 1
      `,
      [input.paymentId, jobToken]
    );
    if (existingResult.rowCount) {
      const existing = mapRefundRow(existingResult.rows[0]);
      if (jobToken && existing.jobToken && existing.jobToken !== jobToken) {
        throw new Error("Refund paymentId and jobToken reference different jobs.");
      }

      if (jobToken && !existing.jobToken) {
        const result = await this.pool.query(
          `
          UPDATE refunds
          SET job_token = $2, updated_at = NOW()
          WHERE id = $1
            AND job_token IS NULL
          RETURNING *
          `,
          [existing.id, jobToken]
        );
        const updated = mapRefundRow(result.rows[0] ?? existingResult.rows[0]);
        await this.pool.query(
          `
          UPDATE jobs
          SET refund_status = $2, refund_id = $3, updated_at = NOW()
          WHERE job_token = $1
          `,
          [jobToken, updated.status, updated.id]
        );
        return updated;
      }

      return existing;
    }

    const result = await this.pool.query(
      `
      INSERT INTO refunds (id, job_token, payment_id, wallet, amount, status)
      VALUES ($1, $2, $3, $4, $5, 'pending')
      ON CONFLICT (payment_id) DO UPDATE
      SET updated_at = refunds.updated_at
      RETURNING *
      `,
      [randomUUID(), jobToken, input.paymentId, input.wallet, input.amount]
    );

    const refund = mapRefundRow(result.rows[0]);
    if (jobToken) {
      await this.pool.query(
        `
        UPDATE jobs
        SET refund_status = 'pending', refund_id = $2, updated_at = NOW()
        WHERE job_token = $1
        `,
        [jobToken, refund.id]
      );
    }

    return refund;
  }

  async claimRefundForSend(refundId: string): Promise<RefundRecord | null> {
    const staleBefore = new Date(Date.now() - PAYMENT_EXECUTION_RECOVERY_MS).toISOString();
    const result = await this.pool.query(
      `
      UPDATE refunds
      SET status = 'sending', error_message = NULL, updated_at = NOW()
      WHERE id = $1
        AND (
          status = 'pending'
          OR (status = 'sending' AND updated_at <= $2)
        )
      RETURNING *
      `,
      [refundId, staleBefore]
    );
    if (!result.rowCount) {
      return null;
    }

    const refund = mapRefundRow(result.rows[0]);
    if (refund.jobToken) {
      await this.pool.query(
        `
        UPDATE jobs
        SET refund_status = 'sending', refund_id = $2, updated_at = NOW()
        WHERE job_token = $1
        `,
        [refund.jobToken, refund.id]
      );
    }

    return refund;
  }

  async markRefundSent(refundId: string, txHash: string): Promise<RefundRecord> {
    const result = await this.pool.query(
      `
      UPDATE refunds
      SET status = 'sent', tx_hash = $2, error_message = NULL, updated_at = NOW()
      WHERE id = $1
      RETURNING *
      `,
      [refundId, txHash]
    );

    const refund = mapRefundRow(result.rows[0]);
    if (refund.jobToken) {
      await this.pool.query(
        `
        UPDATE jobs
        SET refund_status = 'sent', refund_id = $2, updated_at = NOW()
        WHERE job_token = $1
        `,
        [refund.jobToken, refund.id]
      );
    }

    return refund;
  }

  async markRefundFailed(refundId: string, errorMessage: string): Promise<RefundRecord> {
    const result = await this.pool.query(
      `
      UPDATE refunds
      SET status = 'failed', error_message = $2, updated_at = NOW()
      WHERE id = $1
      RETURNING *
      `,
      [refundId, errorMessage]
    );

    const refund = mapRefundRow(result.rows[0]);
    if (refund.jobToken) {
      await this.pool.query(
        `
        UPDATE jobs
        SET refund_status = 'failed', refund_id = $2, updated_at = NOW()
        WHERE job_token = $1
        `,
        [refund.jobToken, refund.id]
      );
    }

    return refund;
  }

  async getRefundByJobToken(jobToken: string): Promise<RefundRecord | null> {
    const result = await this.pool.query("SELECT * FROM refunds WHERE job_token = $1", [jobToken]);
    return result.rowCount ? mapRefundRow(result.rows[0]) : null;
  }

  async getRefundByPaymentId(paymentId: string): Promise<RefundRecord | null> {
    const result = await this.pool.query("SELECT * FROM refunds WHERE payment_id = $1", [paymentId]);
    return result.rowCount ? mapRefundRow(result.rows[0]) : null;
  }

  async createProviderPayout(input: ProviderPayoutInput): Promise<ProviderPayoutRecord> {
    const result = await this.pool.query(
      `
      INSERT INTO provider_payouts (
        id, source_kind, source_id, provider_account_id, provider_wallet, currency, amount, status
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, 'pending'
      )
      ON CONFLICT (source_kind, source_id) DO UPDATE
      SET updated_at = provider_payouts.updated_at
      RETURNING *
      `,
      [
        randomUUID(),
        input.sourceKind,
        input.sourceId,
        input.providerAccountId,
        input.providerWallet,
        input.currency,
        input.amount
      ]
    );
    return mapProviderPayoutRow(result.rows[0]);
  }

  async listRecoverableProviderPayouts(limit: number): Promise<ProviderPayoutInput[]> {
    if (limit <= 0) {
      return [];
    }

    const syncResult = await this.pool.query(
      `
      SELECT
        provider_payout_source_kind AS source_kind,
        payment_id AS source_id,
        payout_split->>'providerAccountId' AS provider_account_id,
        payout_split->>'providerWallet' AS provider_wallet,
        payout_split->>'currency' AS currency,
        payout_split->>'providerAmount' AS amount
      FROM idempotency_records
      WHERE execution_status = 'completed'
        AND response_kind = 'sync'
        AND response_status_code >= 200
        AND response_status_code < 400
        AND provider_payout_source_kind IS NOT NULL
        AND COALESCE((payout_split->>'usesTreasurySettlement')::boolean, TRUE)
        AND COALESCE(payout_split->>'providerWallet', '') <> ''
        AND (payout_split->>'providerAmount')::numeric > 0
        AND NOT EXISTS (
          SELECT 1
          FROM provider_payouts
          WHERE source_kind = idempotency_records.provider_payout_source_kind
            AND source_id = idempotency_records.payment_id
        )
      ORDER BY created_at ASC
      LIMIT $1
      `,
      [limit]
    );
    const syncCount = syncResult.rowCount ?? 0;

    if (syncCount >= limit) {
      return syncResult.rows.map(mapProviderPayoutInputRow);
    }

    const jobResult = await this.pool.query(
      `
      SELECT
        'route_charge' AS source_kind,
        job_token AS source_id,
        payout_split->>'providerAccountId' AS provider_account_id,
        payout_split->>'providerWallet' AS provider_wallet,
        payout_split->>'currency' AS currency,
        payout_split->>'providerAmount' AS amount
      FROM jobs
      WHERE status = 'completed'
        AND refund_status = 'not_required'
        AND COALESCE((payout_split->>'usesTreasurySettlement')::boolean, TRUE)
        AND COALESCE(payout_split->>'providerWallet', '') <> ''
        AND (payout_split->>'providerAmount')::numeric > 0
        AND NOT EXISTS (
          SELECT 1
          FROM provider_payouts
          WHERE source_kind = 'route_charge'
            AND source_id = jobs.job_token
        )
      ORDER BY created_at ASC
      LIMIT $1
      `,
      [limit - syncCount]
    );

    return [...syncResult.rows, ...jobResult.rows].map(mapProviderPayoutInputRow);
  }

  async listPendingProviderPayouts(limit: number): Promise<ProviderPayoutRecord[]> {
    const result = await this.pool.query(
      `
      SELECT *
      FROM provider_payouts
      WHERE status = 'pending'
      ORDER BY created_at ASC
      LIMIT $1
      `,
      [limit]
    );
    return result.rows.map(mapProviderPayoutRow);
  }

  async claimPendingProviderPayouts(limit: number): Promise<ProviderPayoutRecord[]> {
    if (limit <= 0) {
      return [];
    }

    const staleBefore = new Date(Date.now() - PAYMENT_EXECUTION_RECOVERY_MS).toISOString();
    const result = await this.pool.query(
      `
      WITH claimed AS (
        SELECT id
        FROM provider_payouts
        WHERE status = 'pending'
           OR (status = 'sending' AND updated_at <= $2)
        ORDER BY created_at ASC
        LIMIT $1
        FOR UPDATE SKIP LOCKED
      )
      UPDATE provider_payouts
      SET status = 'sending', last_error = NULL, updated_at = NOW()
      WHERE id IN (SELECT id FROM claimed)
      RETURNING *
      `,
      [limit, staleBefore]
    );
    return result.rows.map(mapProviderPayoutRow);
  }

  async markProviderPayoutSendFailure(payoutIds: string[], errorMessage: string): Promise<void> {
    if (payoutIds.length === 0) {
      return;
    }

    await this.pool.query(
      `
      UPDATE provider_payouts
      SET status = 'pending', attempt_count = attempt_count + 1, last_error = $2, updated_at = NOW()
      WHERE id = ANY($1::text[])
      `,
      [payoutIds, errorMessage]
    );
  }

  async markProviderPayoutsSent(payoutIds: string[], txHash: string): Promise<ProviderPayoutRecord[]> {
    if (payoutIds.length === 0) {
      return [];
    }

    const result = await this.pool.query(
      `
      UPDATE provider_payouts
      SET
        status = 'sent',
        tx_hash = $2,
        sent_at = NOW(),
        attempt_count = attempt_count + 1,
        last_error = NULL,
        updated_at = NOW()
      WHERE id = ANY($1::text[])
      RETURNING *
      `,
      [payoutIds, txHash]
    );
    return result.rows.map(mapProviderPayoutRow);
  }

  async completeCreditTopupCharge(
    input: CompleteCreditTopupChargeInput
  ): Promise<{ idempotency: IdempotencyRecord; account: CreditAccountRecord; entry: CreditLedgerEntryRecord }> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      const accountResult = await client.query(
        `
        INSERT INTO credit_accounts (
          id, service_id, buyer_wallet, currency, available_amount, reserved_amount
        ) VALUES (
          $1, $2, $3, $4, '0', '0'
        )
        ON CONFLICT (service_id, buyer_wallet, currency) DO UPDATE
        SET updated_at = NOW()
        RETURNING *
        `,
        [randomUUID(), input.serviceId, input.buyerWallet, input.payoutSplit.currency]
      );

      let account = mapCreditAccountRow(accountResult.rows[0]);

      const entryResult = await client.query(
        `
        INSERT INTO credit_ledger_entries (
          id, account_id, service_id, buyer_wallet, currency, kind, amount, reservation_id, payment_id, metadata
        ) VALUES (
          $1, $2, $3, $4, $5, 'topup', $6, NULL, $7, $8::jsonb
        )
        ON CONFLICT DO NOTHING
        RETURNING *
        `,
        [
          randomUUID(),
          account.id,
          input.serviceId,
          input.buyerWallet,
          input.payoutSplit.currency,
          input.quotedPrice,
          input.paymentId,
          JSON.stringify(input.metadata ?? {})
        ]
      );

      let entry: CreditLedgerEntryRecord;
      if (entryResult.rowCount) {
        const updatedAccountResult = await client.query(
          `
          UPDATE credit_accounts
          SET
            available_amount = (available_amount::numeric + $2::numeric)::text,
            updated_at = NOW()
          WHERE id = $1
          RETURNING *
          `,
          [account.id, input.quotedPrice]
        );
        account = mapCreditAccountRow(updatedAccountResult.rows[0]);
        entry = mapCreditLedgerEntryRow(entryResult.rows[0]);
      } else {
        const existingEntryResult = await client.query(
          `
          SELECT *
          FROM credit_ledger_entries
          WHERE service_id = $1
            AND payment_id = $2
            AND kind = 'topup'
          LIMIT 1
          `,
          [input.serviceId, input.paymentId]
        );
        if (!existingEntryResult.rowCount) {
          throw new Error(`Credit top-up entry not found after conflict: ${input.serviceId}:${input.paymentId}`);
        }

        entry = mapCreditLedgerEntryRow(existingEntryResult.rows[0]);
        const existingAccountResult = await client.query("SELECT * FROM credit_accounts WHERE id = $1", [entry.accountId]);
        if (!existingAccountResult.rowCount) {
          throw new Error(`Credit account not found: ${entry.accountId}`);
        }
        account = mapCreditAccountRow(existingAccountResult.rows[0]);
      }

      if (
        input.payoutSplit.usesTreasurySettlement
        && BigInt(input.payoutSplit.providerAmount) > 0n
        && input.payoutSplit.providerWallet
      ) {
        await client.query(
          `
          INSERT INTO provider_payouts (
            id, source_kind, source_id, provider_account_id, provider_wallet, currency, amount, status
          ) VALUES (
            $1, 'credit_topup', $2, $3, $4, $5, $6, 'pending'
          )
          ON CONFLICT (source_kind, source_id) DO UPDATE
          SET updated_at = provider_payouts.updated_at
          `,
          [
            randomUUID(),
            input.paymentId,
            input.payoutSplit.providerAccountId,
            input.payoutSplit.providerWallet,
            input.payoutSplit.currency,
            input.payoutSplit.providerAmount
          ]
        );
      }

      const responseBody = buildStoredTopupResponseBody({
        routeId: input.routeId,
        serviceId: input.serviceId,
        buyerWallet: input.buyerWallet,
        quotedPrice: input.quotedPrice,
        account,
        entry
      });

      const idempotencyResult = await client.query(
        `
        INSERT INTO idempotency_records (
          payment_id, normalized_request_hash, buyer_wallet, route_id, route_version,
          pending_recovery_action, quoted_price, payout_split, payment_payload, facilitator_response, response_kind,
          response_status_code, response_body, response_headers, provider_payout_source_kind,
          execution_status, request_id, job_token
        ) VALUES (
          $1, $2, $3, $4, $5, 'retry', $6, $7::jsonb, $8, $9::jsonb, 'sync',
          200, $10::jsonb, $11::jsonb, 'credit_topup', 'completed', $12, NULL
        )
        ON CONFLICT (payment_id) DO UPDATE
        SET
          normalized_request_hash = EXCLUDED.normalized_request_hash,
          buyer_wallet = EXCLUDED.buyer_wallet,
          route_id = EXCLUDED.route_id,
          route_version = EXCLUDED.route_version,
          pending_recovery_action =
            COALESCE(idempotency_records.pending_recovery_action, EXCLUDED.pending_recovery_action),
          quoted_price = EXCLUDED.quoted_price,
          payout_split = EXCLUDED.payout_split,
          payment_payload = EXCLUDED.payment_payload,
          facilitator_response = EXCLUDED.facilitator_response,
          response_kind = 'sync',
          response_status_code = 200,
          response_body = EXCLUDED.response_body,
          response_headers = EXCLUDED.response_headers,
          provider_payout_source_kind = 'credit_topup',
          execution_status = 'completed',
          request_id = COALESCE(idempotency_records.request_id, EXCLUDED.request_id),
          updated_at = NOW()
        RETURNING *
        `,
        [
          input.paymentId,
          input.normalizedRequestHash,
          input.buyerWallet,
          input.routeId,
          input.routeVersion,
          input.quotedPrice,
          JSON.stringify(input.payoutSplit),
          input.paymentPayload,
          JSON.stringify(input.facilitatorResponse),
          JSON.stringify(responseBody),
          JSON.stringify(input.responseHeaders ?? {}),
          input.requestId ?? null
        ]
      );

      await client.query("COMMIT");
      return {
        idempotency: mapIdempotencyRow(idempotencyResult.rows[0]),
        account,
        entry
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async createCreditTopup(input: {
    serviceId: string;
    buyerWallet: string;
    currency: "USDC" | "testUSDC";
    amount: string;
    paymentId: string;
    metadata?: Record<string, unknown>;
  }): Promise<{ account: CreditAccountRecord; entry: CreditLedgerEntryRecord }> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      const accountResult = await client.query(
        `
        INSERT INTO credit_accounts (
          id, service_id, buyer_wallet, currency, available_amount, reserved_amount
        ) VALUES (
          $1, $2, $3, $4, '0', '0'
        )
        ON CONFLICT (service_id, buyer_wallet, currency) DO UPDATE
        SET
          updated_at = NOW()
        RETURNING *
        `,
        [randomUUID(), input.serviceId, input.buyerWallet, input.currency]
      );
      let account = mapCreditAccountRow(accountResult.rows[0]);

      const entryResult = await client.query(
        `
        INSERT INTO credit_ledger_entries (
          id, account_id, service_id, buyer_wallet, currency, kind, amount, reservation_id, payment_id, metadata
        ) VALUES (
          $1, $2, $3, $4, $5, 'topup', $6, NULL, $7, $8::jsonb
        )
        ON CONFLICT DO NOTHING
        RETURNING *
        `,
        [
          randomUUID(),
          account.id,
          input.serviceId,
          input.buyerWallet,
          input.currency,
          input.amount,
          input.paymentId,
          JSON.stringify(input.metadata ?? {})
        ]
      );

      if (!entryResult.rowCount) {
        const existingEntryResult = await client.query(
          `
          SELECT *
          FROM credit_ledger_entries
          WHERE service_id = $1
            AND payment_id = $2
            AND kind = 'topup'
          LIMIT 1
          `,
          [input.serviceId, input.paymentId]
        );
        if (!existingEntryResult.rowCount) {
          throw new Error(`Credit top-up entry not found after conflict: ${input.serviceId}:${input.paymentId}`);
        }

        const entry = mapCreditLedgerEntryRow(existingEntryResult.rows[0]);
        const existingAccountResult = await client.query("SELECT * FROM credit_accounts WHERE id = $1", [entry.accountId]);
        if (!existingAccountResult.rowCount) {
          throw new Error(`Credit account not found: ${entry.accountId}`);
        }

        await client.query("COMMIT");
        return {
          account: mapCreditAccountRow(existingAccountResult.rows[0]),
          entry
        };
      }

      const updatedAccountResult = await client.query(
        `
        UPDATE credit_accounts
        SET
          available_amount = (available_amount::numeric + $2::numeric)::text,
          updated_at = NOW()
        WHERE id = $1
        RETURNING *
        `,
        [account.id, input.amount]
      );
      account = mapCreditAccountRow(updatedAccountResult.rows[0]);

      await client.query("COMMIT");
      return {
        account,
        entry: mapCreditLedgerEntryRow(entryResult.rows[0])
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async getCreditTopupByPaymentId(
    serviceId: string,
    paymentId: string
  ): Promise<{ account: CreditAccountRecord; entry: CreditLedgerEntryRecord } | null> {
    const result = await this.pool.query(
      `
      SELECT
        account.id AS account_id,
        account.service_id AS account_service_id,
        account.buyer_wallet AS account_buyer_wallet,
        account.currency AS account_currency,
        account.available_amount AS account_available_amount,
        account.reserved_amount AS account_reserved_amount,
        account.created_at AS account_created_at,
        account.updated_at AS account_updated_at,
        entry.*
      FROM credit_ledger_entries entry
      JOIN credit_accounts account ON account.id = entry.account_id
      WHERE entry.service_id = $1
        AND entry.payment_id = $2
        AND entry.kind = 'topup'
      LIMIT 1
      `,
      [serviceId, paymentId]
    );
    if (!result.rowCount) {
      return null;
    }

    const row = result.rows[0];
    return {
      account: mapCreditAccountRow({
        id: row.account_id,
        service_id: row.account_service_id,
        buyer_wallet: row.account_buyer_wallet,
        currency: row.account_currency,
        available_amount: row.account_available_amount,
        reserved_amount: row.account_reserved_amount,
        created_at: row.account_created_at,
        updated_at: row.account_updated_at
      }),
      entry: mapCreditLedgerEntryRow(row)
    };
  }

  async getCreditAccount(serviceId: string, buyerWallet: string, currency: "USDC" | "testUSDC"): Promise<CreditAccountRecord | null> {
    const result = await this.pool.query(
      `
      SELECT *
      FROM credit_accounts
      WHERE service_id = $1 AND buyer_wallet = $2 AND currency = $3
      LIMIT 1
      `,
      [serviceId, buyerWallet, currency]
    );
    return result.rowCount ? mapCreditAccountRow(result.rows[0]) : null;
  }

  async reserveCredit(input: {
    serviceId: string;
    buyerWallet: string;
    currency: "USDC" | "testUSDC";
    amount: string;
    idempotencyKey: string;
    jobToken?: string | null;
    requestId?: string | null;
    paymentId?: string | null;
    providerReference?: string | null;
    expiresAt: string;
    metadata?: Record<string, unknown>;
  }): Promise<{ account: CreditAccountRecord; reservation: CreditReservationRecord; entry: CreditLedgerEntryRecord }> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      const existingReservationByIdempotencyResult = await client.query(
        `
        SELECT *
        FROM credit_reservations
        WHERE service_id = $1 AND idempotency_key = $2
          AND status IN ('reserved', 'captured')
        LIMIT 1
        FOR UPDATE
        `,
        [input.serviceId, input.idempotencyKey]
      );

      const existingReservationByJobTokenResult = input.jobToken
        ? await client.query(
            `
            SELECT *
            FROM credit_reservations
            WHERE service_id = $1 AND job_token = $2
              AND status IN ('reserved', 'captured')
            LIMIT 1
            FOR UPDATE
            `,
            [input.serviceId, input.jobToken]
          )
        : { rowCount: 0, rows: [] as Record<string, unknown>[] };

      if (
        existingReservationByIdempotencyResult.rowCount
        && existingReservationByJobTokenResult.rowCount
        && existingReservationByIdempotencyResult.rows[0]?.id !== existingReservationByJobTokenResult.rows[0]?.id
      ) {
        throw new Error("Credit reservation idempotencyKey and jobToken reference different reservations.");
      }

      const existingReservationRow = existingReservationByJobTokenResult.rowCount
        ? existingReservationByJobTokenResult.rows[0]
        : existingReservationByIdempotencyResult.rows[0];

      if (existingReservationRow) {
        let reservation = mapCreditReservationRow(existingReservationRow);
        let account: CreditAccountRecord;

        const accountResult = await client.query(
          `
          SELECT *
          FROM credit_accounts
          WHERE id = $1
          LIMIT 1
          FOR UPDATE
          `,
          [reservation.accountId]
        );
        if (!accountResult.rowCount) {
          throw new Error(`Credit account not found: ${reservation.accountId}`);
        }
        account = mapCreditAccountRow(accountResult.rows[0]);

        if (reservation.status === "reserved" && Date.parse(reservation.expiresAt) <= Date.now()) {
          const updatedAccountResult = await client.query(
            `
            UPDATE credit_accounts
            SET
              available_amount = (available_amount::numeric + $2::numeric)::text,
              reserved_amount = (reserved_amount::numeric - $2::numeric)::text,
              updated_at = NOW()
            WHERE id = $1
            RETURNING *
            `,
            [account.id, reservation.reservedAmount]
          );
          account = mapCreditAccountRow(updatedAccountResult.rows[0]);

          const updatedReservationResult = await client.query(
            `
            UPDATE credit_reservations
            SET status = 'expired', updated_at = NOW()
            WHERE id = $1
            RETURNING *
            `,
            [reservation.id]
            );
          reservation = mapCreditReservationRow(updatedReservationResult.rows[0]);
          await client.query(
            `
            INSERT INTO credit_ledger_entries (
              id, account_id, service_id, buyer_wallet, currency, kind, amount, reservation_id, payment_id, metadata
            ) VALUES (
              $1, $2, $3, $4, $5, 'release', $6, $7, NULL, $8::jsonb
            )
            RETURNING *
            `,
            [
              randomUUID(),
              account.id,
              reservation.serviceId,
              reservation.buyerWallet,
              reservation.currency,
              reservation.reservedAmount,
              reservation.id,
              JSON.stringify({ reason: "expired" })
            ]
          );
        }

        if (reservation.status === "reserved" || reservation.status === "captured") {
          const reserveEntryResult = await client.query(
            `
            SELECT *
            FROM credit_ledger_entries
            WHERE reservation_id = $1 AND kind = 'reserve'
            ORDER BY created_at ASC
            LIMIT 1
            `,
            [reservation.id]
          );
          if (!reserveEntryResult.rowCount) {
            throw new Error(`Credit reserve entry not found: ${reservation.id}`);
          }

          await client.query("COMMIT");
          return {
            account,
            reservation,
            entry: mapCreditLedgerEntryRow(reserveEntryResult.rows[0])
          };
        }
      }

      const accountResult = await client.query(
        `
        SELECT *
        FROM credit_accounts
        WHERE service_id = $1 AND buyer_wallet = $2 AND currency = $3
        LIMIT 1
        FOR UPDATE
        `,
        [input.serviceId, input.buyerWallet, input.currency]
      );
      if (!accountResult.rowCount) {
        throw new Error("Credit account not found.");
      }

      const account = mapCreditAccountRow(accountResult.rows[0]);
      if (BigInt(account.availableAmount) < BigInt(input.amount)) {
        throw new Error("Insufficient prepaid credit.");
      }

      const updatedAccountResult = await client.query(
        `
        UPDATE credit_accounts
        SET
          available_amount = (available_amount::numeric - $2::numeric)::text,
          reserved_amount = (reserved_amount::numeric + $2::numeric)::text,
          updated_at = NOW()
        WHERE id = $1
        RETURNING *
        `,
        [account.id, input.amount]
      );
      const updatedAccount = mapCreditAccountRow(updatedAccountResult.rows[0]);

      const reservationResult = await client.query(
        `
        INSERT INTO credit_reservations (
          id, account_id, service_id, buyer_wallet, currency, idempotency_key, job_token, provider_reference,
          request_id, payment_id, status, reserved_amount, captured_amount, expires_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'reserved', $11, '0', $12
        )
        RETURNING *
        `,
        [
          randomUUID(),
          updatedAccount.id,
          input.serviceId,
          input.buyerWallet,
          input.currency,
          input.idempotencyKey,
          input.jobToken ?? null,
          input.providerReference ?? null,
          input.requestId ?? null,
          input.paymentId ?? null,
          input.amount,
          input.expiresAt
        ]
      );
      const reservation = mapCreditReservationRow(reservationResult.rows[0]);

      const entryResult = await client.query(
        `
        INSERT INTO credit_ledger_entries (
          id, account_id, service_id, buyer_wallet, currency, kind, amount, reservation_id, payment_id, metadata
        ) VALUES (
          $1, $2, $3, $4, $5, 'reserve', $6, $7, NULL, $8::jsonb
        )
        RETURNING *
        `,
        [
          randomUUID(),
          updatedAccount.id,
          input.serviceId,
          input.buyerWallet,
          input.currency,
          input.amount,
          reservation.id,
          JSON.stringify(input.metadata ?? {})
        ]
      );

      await client.query("COMMIT");
      return {
        account: updatedAccount,
        reservation,
        entry: mapCreditLedgerEntryRow(entryResult.rows[0])
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async captureCreditReservation(input: {
    reservationId: string;
    amount: string;
    metadata?: Record<string, unknown>;
  }): Promise<{
    account: CreditAccountRecord;
    reservation: CreditReservationRecord;
    captureEntry: CreditLedgerEntryRecord;
    releaseEntry: CreditLedgerEntryRecord | null;
  }> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      const reservationResult = await client.query(
        `
        SELECT *
        FROM credit_reservations
        WHERE id = $1
        LIMIT 1
        FOR UPDATE
        `,
        [input.reservationId]
      );
      if (!reservationResult.rowCount) {
        throw new Error(`Credit reservation not found: ${input.reservationId}`);
      }

      let reservation = mapCreditReservationRow(reservationResult.rows[0]);
      const accountResult = await client.query(
        `
        SELECT *
        FROM credit_accounts
        WHERE id = $1
        LIMIT 1
        FOR UPDATE
        `,
        [reservation.accountId]
      );
      if (!accountResult.rowCount) {
        throw new Error(`Credit account not found: ${reservation.accountId}`);
      }
      let account = mapCreditAccountRow(accountResult.rows[0]);

      if (reservation.status === "reserved" && Date.parse(reservation.expiresAt) <= Date.now()) {
        const releasedAccountResult = await client.query(
          `
          UPDATE credit_accounts
          SET
            available_amount = (available_amount::numeric + $2::numeric)::text,
            reserved_amount = (reserved_amount::numeric - $2::numeric)::text,
            updated_at = NOW()
          WHERE id = $1
          RETURNING *
          `,
          [account.id, reservation.reservedAmount]
        );
        account = mapCreditAccountRow(releasedAccountResult.rows[0]);

        const expiredReservationResult = await client.query(
          `
          UPDATE credit_reservations
          SET status = 'expired', updated_at = NOW()
          WHERE id = $1
          RETURNING *
          `,
          [reservation.id]
        );
        reservation = mapCreditReservationRow(expiredReservationResult.rows[0]);

        await client.query(
          `
          INSERT INTO credit_ledger_entries (
            id, account_id, service_id, buyer_wallet, currency, kind, amount, reservation_id, payment_id, metadata
          ) VALUES (
            $1, $2, $3, $4, $5, 'release', $6, $7, NULL, $8::jsonb
          )
          RETURNING *
          `,
          [
            randomUUID(),
            account.id,
            reservation.serviceId,
            reservation.buyerWallet,
            reservation.currency,
            reservation.reservedAmount,
            reservation.id,
            JSON.stringify({ reason: "expired" })
          ]
        );
        await client.query("COMMIT");
        throw new Error(`Credit reservation cannot be captured from status ${reservation.status}.`);
      }

      if (reservation.status === "captured") {
        const captureEntryResult = await client.query(
          `
          SELECT *
          FROM credit_ledger_entries
          WHERE reservation_id = $1 AND kind = 'capture'
          ORDER BY created_at ASC
          LIMIT 1
          `,
          [reservation.id]
        );
        if (!captureEntryResult.rowCount) {
          throw new Error(`Capture entry not found for ${reservation.id}`);
        }
        const releaseEntryResult = await client.query(
          `
          SELECT *
          FROM credit_ledger_entries
          WHERE reservation_id = $1 AND kind = 'release'
          ORDER BY created_at ASC
          LIMIT 1
          `,
          [reservation.id]
        );
        await client.query("COMMIT");
        return {
          account,
          reservation,
          captureEntry: mapCreditLedgerEntryRow(captureEntryResult.rows[0]),
          releaseEntry: releaseEntryResult.rowCount ? mapCreditLedgerEntryRow(releaseEntryResult.rows[0]) : null
        };
      }

      if (reservation.status !== "reserved") {
        throw new Error(`Credit reservation cannot be captured from status ${reservation.status}.`);
      }
      if (BigInt(input.amount) > BigInt(reservation.reservedAmount)) {
        throw new Error("Captured amount cannot exceed reserved amount.");
      }

      const remainder = (BigInt(reservation.reservedAmount) - BigInt(input.amount)).toString();
      const updatedAccountResult = await client.query(
        `
        UPDATE credit_accounts
        SET
          available_amount = (available_amount::numeric + $2::numeric)::text,
          reserved_amount = (reserved_amount::numeric - $3::numeric)::text,
          updated_at = NOW()
        WHERE id = $1
        RETURNING *
        `,
        [account.id, remainder, reservation.reservedAmount]
      );
      const updatedAccount = mapCreditAccountRow(updatedAccountResult.rows[0]);

      const updatedReservationResult = await client.query(
        `
        UPDATE credit_reservations
        SET status = 'captured', captured_amount = $2, updated_at = NOW()
        WHERE id = $1
        RETURNING *
        `,
        [reservation.id, input.amount]
      );
      const updatedReservation = mapCreditReservationRow(updatedReservationResult.rows[0]);

      const captureEntryResult = await client.query(
        `
        INSERT INTO credit_ledger_entries (
          id, account_id, service_id, buyer_wallet, currency, kind, amount, reservation_id, payment_id, metadata
        ) VALUES (
          $1, $2, $3, $4, $5, 'capture', $6, $7, NULL, $8::jsonb
        )
        RETURNING *
        `,
        [
          randomUUID(),
          updatedAccount.id,
          updatedReservation.serviceId,
          updatedReservation.buyerWallet,
          updatedReservation.currency,
          input.amount,
          updatedReservation.id,
          JSON.stringify(input.metadata ?? {})
        ]
      );

      let releaseEntry: CreditLedgerEntryRecord | null = null;
      if (BigInt(remainder) > 0n) {
        const releaseEntryResult = await client.query(
          `
          INSERT INTO credit_ledger_entries (
            id, account_id, service_id, buyer_wallet, currency, kind, amount, reservation_id, payment_id, metadata
          ) VALUES (
            $1, $2, $3, $4, $5, 'release', $6, $7, NULL, $8::jsonb
          )
          RETURNING *
          `,
          [
            randomUUID(),
            updatedAccount.id,
            updatedReservation.serviceId,
            updatedReservation.buyerWallet,
            updatedReservation.currency,
            remainder,
            updatedReservation.id,
            JSON.stringify(input.metadata ?? {})
          ]
        );
        releaseEntry = mapCreditLedgerEntryRow(releaseEntryResult.rows[0]);
      }

      await client.query("COMMIT");
      return {
        account: updatedAccount,
        reservation: updatedReservation,
        captureEntry: mapCreditLedgerEntryRow(captureEntryResult.rows[0]),
        releaseEntry
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async releaseCreditReservation(input: {
    reservationId: string;
    metadata?: Record<string, unknown>;
  }): Promise<{ account: CreditAccountRecord; reservation: CreditReservationRecord; entry: CreditLedgerEntryRecord | null }> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      const reservationResult = await client.query(
        `
        SELECT *
        FROM credit_reservations
        WHERE id = $1
        LIMIT 1
        FOR UPDATE
        `,
        [input.reservationId]
      );
      if (!reservationResult.rowCount) {
        throw new Error(`Credit reservation not found: ${input.reservationId}`);
      }
      const reservation = mapCreditReservationRow(reservationResult.rows[0]);

      const accountResult = await client.query(
        `
        SELECT *
        FROM credit_accounts
        WHERE id = $1
        LIMIT 1
        FOR UPDATE
        `,
        [reservation.accountId]
      );
      if (!accountResult.rowCount) {
        throw new Error(`Credit account not found: ${reservation.accountId}`);
      }
      const account = mapCreditAccountRow(accountResult.rows[0]);

      if (reservation.status !== "reserved") {
        await client.query("COMMIT");
        return {
          account,
          reservation,
          entry: null
        };
      }

      const updatedAccountResult = await client.query(
        `
        UPDATE credit_accounts
        SET
          available_amount = (available_amount::numeric + $2::numeric)::text,
          reserved_amount = (reserved_amount::numeric - $2::numeric)::text,
          updated_at = NOW()
        WHERE id = $1
        RETURNING *
        `,
        [account.id, reservation.reservedAmount]
      );
      const updatedAccount = mapCreditAccountRow(updatedAccountResult.rows[0]);

      const updatedReservationResult = await client.query(
        `
        UPDATE credit_reservations
        SET status = 'released', updated_at = NOW()
        WHERE id = $1
        RETURNING *
        `,
        [reservation.id]
      );
      const updatedReservation = mapCreditReservationRow(updatedReservationResult.rows[0]);

      const entryResult = await client.query(
        `
        INSERT INTO credit_ledger_entries (
          id, account_id, service_id, buyer_wallet, currency, kind, amount, reservation_id, payment_id, metadata
        ) VALUES (
          $1, $2, $3, $4, $5, 'release', $6, $7, NULL, $8::jsonb
        )
        RETURNING *
        `,
        [
          randomUUID(),
          updatedAccount.id,
          updatedReservation.serviceId,
          updatedReservation.buyerWallet,
          updatedReservation.currency,
          reservation.reservedAmount,
          updatedReservation.id,
          JSON.stringify(input.metadata ?? {})
        ]
      );

      await client.query("COMMIT");
      return {
        account: updatedAccount,
        reservation: updatedReservation,
        entry: mapCreditLedgerEntryRow(entryResult.rows[0])
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async expireCreditReservation(reservationId: string): Promise<{
    account: CreditAccountRecord;
    reservation: CreditReservationRecord;
    entry: CreditLedgerEntryRecord | null;
  }> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      const reservationResult = await client.query(
        `
        SELECT *
        FROM credit_reservations
        WHERE id = $1
        LIMIT 1
        FOR UPDATE
        `,
        [reservationId]
      );
      if (!reservationResult.rowCount) {
        throw new Error(`Credit reservation not found: ${reservationId}`);
      }
      const reservation = mapCreditReservationRow(reservationResult.rows[0]);

      const accountResult = await client.query(
        `
        SELECT *
        FROM credit_accounts
        WHERE id = $1
        LIMIT 1
        FOR UPDATE
        `,
        [reservation.accountId]
      );
      if (!accountResult.rowCount) {
        throw new Error(`Credit account not found: ${reservation.accountId}`);
      }
      const account = mapCreditAccountRow(accountResult.rows[0]);

      if (reservation.status !== "reserved") {
        await client.query("COMMIT");
        return {
          account,
          reservation,
          entry: null
        };
      }

      const updatedAccountResult = await client.query(
        `
        UPDATE credit_accounts
        SET
          available_amount = (available_amount::numeric + $2::numeric)::text,
          reserved_amount = (reserved_amount::numeric - $2::numeric)::text,
          updated_at = NOW()
        WHERE id = $1
        RETURNING *
        `,
        [account.id, reservation.reservedAmount]
      );
      const updatedAccount = mapCreditAccountRow(updatedAccountResult.rows[0]);

      const updatedReservationResult = await client.query(
        `
        UPDATE credit_reservations
        SET status = 'expired', updated_at = NOW()
        WHERE id = $1
        RETURNING *
        `,
        [reservation.id]
      );
      const updatedReservation = mapCreditReservationRow(updatedReservationResult.rows[0]);

      const entryResult = await client.query(
        `
        INSERT INTO credit_ledger_entries (
          id, account_id, service_id, buyer_wallet, currency, kind, amount, reservation_id, payment_id, metadata
        ) VALUES (
          $1, $2, $3, $4, $5, 'release', $6, $7, NULL, $8::jsonb
        )
        RETURNING *
        `,
        [
          randomUUID(),
          updatedAccount.id,
          updatedReservation.serviceId,
          updatedReservation.buyerWallet,
          updatedReservation.currency,
          reservation.reservedAmount,
          updatedReservation.id,
          JSON.stringify({ reason: "expired" })
        ]
      );

      await client.query("COMMIT");
      return {
        account: updatedAccount,
        reservation: updatedReservation,
        entry: mapCreditLedgerEntryRow(entryResult.rows[0])
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async reverseCapturedCreditReservation(input: {
    reservationId: string;
    metadata?: Record<string, unknown>;
  }): Promise<{ account: CreditAccountRecord; reservation: CreditReservationRecord; entry: CreditLedgerEntryRecord | null }> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      const reservationResult = await client.query(
        `
        SELECT *
        FROM credit_reservations
        WHERE id = $1
        LIMIT 1
        FOR UPDATE
        `,
        [input.reservationId]
      );
      if (!reservationResult.rowCount) {
        throw new Error(`Credit reservation not found: ${input.reservationId}`);
      }
      const reservation = mapCreditReservationRow(reservationResult.rows[0]);

      const accountResult = await client.query(
        `
        SELECT *
        FROM credit_accounts
        WHERE id = $1
        LIMIT 1
        FOR UPDATE
        `,
        [reservation.accountId]
      );
      if (!accountResult.rowCount) {
        throw new Error(`Credit account not found: ${reservation.accountId}`);
      }
      const account = mapCreditAccountRow(accountResult.rows[0]);

      if (reservation.status !== "captured") {
        await client.query("COMMIT");
        return {
          account,
          reservation,
          entry: null
        };
      }

      const updatedAccountResult = await client.query(
        `
        UPDATE credit_accounts
        SET
          available_amount = (available_amount::numeric + $2::numeric)::text,
          updated_at = NOW()
        WHERE id = $1
        RETURNING *
        `,
        [account.id, reservation.capturedAmount]
      );
      const updatedAccount = mapCreditAccountRow(updatedAccountResult.rows[0]);

      const updatedReservationResult = await client.query(
        `
        UPDATE credit_reservations
        SET status = 'reversed', updated_at = NOW()
        WHERE id = $1
        RETURNING *
        `,
        [reservation.id]
      );
      const updatedReservation = mapCreditReservationRow(updatedReservationResult.rows[0]);

      const entryResult = await client.query(
        `
        INSERT INTO credit_ledger_entries (
          id, account_id, service_id, buyer_wallet, currency, kind, amount, reservation_id, payment_id, metadata
        ) VALUES (
          $1, $2, $3, $4, $5, 'restore', $6, $7, $8, $9::jsonb
        )
        RETURNING *
        `,
        [
          randomUUID(),
          updatedAccount.id,
          updatedReservation.serviceId,
          updatedReservation.buyerWallet,
          updatedReservation.currency,
          updatedReservation.capturedAmount,
          updatedReservation.id,
          updatedReservation.paymentId,
          JSON.stringify(input.metadata ?? {})
        ]
      );

      await client.query("COMMIT");
      return {
        account: updatedAccount,
        reservation: updatedReservation,
        entry: mapCreditLedgerEntryRow(entryResult.rows[0])
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async getCreditReservationById(reservationId: string): Promise<CreditReservationRecord | null> {
    const result = await this.pool.query("SELECT * FROM credit_reservations WHERE id = $1 LIMIT 1", [reservationId]);
    return result.rowCount ? mapCreditReservationRow(result.rows[0]) : null;
  }

  async getCreditReservationByIdempotencyKey(serviceId: string, idempotencyKey: string): Promise<CreditReservationRecord | null> {
    const result = await this.pool.query(
      "SELECT * FROM credit_reservations WHERE service_id = $1 AND idempotency_key = $2 ORDER BY created_at DESC LIMIT 1",
      [serviceId, idempotencyKey]
    );
    return result.rowCount ? mapCreditReservationRow(result.rows[0]) : null;
  }

  async getCreditReservationByJobToken(serviceId: string, jobToken: string): Promise<CreditReservationRecord | null> {
    const result = await this.pool.query(
      "SELECT * FROM credit_reservations WHERE service_id = $1 AND job_token = $2 ORDER BY created_at DESC LIMIT 1",
      [serviceId, jobToken]
    );
    return result.rowCount ? mapCreditReservationRow(result.rows[0]) : null;
  }

  async listExpiredCreditReservations(limit: number, expiresBefore: string = new Date().toISOString()): Promise<CreditReservationRecord[]> {
    const result = await this.pool.query(
      `
      SELECT *
      FROM credit_reservations
      WHERE status = 'reserved' AND expires_at <= $1::timestamptz
      ORDER BY created_at ASC
      LIMIT $2
      `,
      [expiresBefore, limit]
    );
    return result.rows.map(mapCreditReservationRow);
  }

  async extendCreditReservation(input: {
    reservationId: string;
    expiresAt: string;
  }): Promise<{ account: CreditAccountRecord; reservation: CreditReservationRecord }> {
    const client = await this.pool.connect();

    try {
      await client.query("BEGIN");
      const reservationResult = await client.query(
        `
        UPDATE credit_reservations
        SET expires_at = $2, updated_at = NOW()
        WHERE id = $1
        RETURNING *
        `,
        [input.reservationId, input.expiresAt]
      );
      if (!reservationResult.rowCount) {
        throw new Error(`Credit reservation not found: ${input.reservationId}`);
      }

      const reservation = mapCreditReservationRow(reservationResult.rows[0]);
      const accountResult = await client.query("SELECT * FROM credit_accounts WHERE id = $1 LIMIT 1", [reservation.accountId]);
      if (!accountResult.rowCount) {
        throw new Error(`Credit account not found: ${reservation.accountId}`);
      }

      await client.query("COMMIT");
      return {
        account: mapCreditAccountRow(accountResult.rows[0]),
        reservation
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async rotateProviderRuntimeKey(serviceId: string, wallet: string, secretMaterial: {
    keyHash: string;
    keyPrefix: string;
    ciphertext: string;
    iv: string;
    authTag: string;
  }): Promise<ProviderRuntimeKeyRecord> {
    const detail = await this.getProviderServiceForOwner(serviceId, wallet);
    if (!detail) {
      throw new Error("Provider service not found.");
    }

    const result = await this.pool.query(
      `
      INSERT INTO provider_runtime_keys (
        id, service_id, key_prefix, key_hash, secret_ciphertext, iv, auth_tag
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7
      )
      ON CONFLICT (service_id) DO UPDATE
      SET
        id = EXCLUDED.id,
        key_prefix = EXCLUDED.key_prefix,
        key_hash = EXCLUDED.key_hash,
        secret_ciphertext = EXCLUDED.secret_ciphertext,
        iv = EXCLUDED.iv,
        auth_tag = EXCLUDED.auth_tag,
        created_at = NOW(),
        updated_at = NOW()
      RETURNING *
      `,
      [
        randomUUID(),
        serviceId,
        secretMaterial.keyPrefix,
        secretMaterial.keyHash,
        secretMaterial.ciphertext,
        secretMaterial.iv,
        secretMaterial.authTag
      ]
    );
    return mapProviderRuntimeKeyRow(result.rows[0]);
  }

  async getProviderRuntimeKeyForOwner(serviceId: string, wallet: string): Promise<ProviderRuntimeKeyRecord | null> {
    const detail = await this.getProviderServiceForOwner(serviceId, wallet);
    if (!detail) {
      return null;
    }

    const result = await this.pool.query("SELECT * FROM provider_runtime_keys WHERE service_id = $1 LIMIT 1", [serviceId]);
    return result.rowCount ? mapProviderRuntimeKeyRow(result.rows[0]) : null;
  }

  async getProviderRuntimeKeyByPlaintext(plaintextKey: string): Promise<ProviderRuntimeKeyRecord | null> {
    const result = await this.pool.query("SELECT * FROM provider_runtime_keys WHERE key_hash = $1 LIMIT 1", [
      hashProviderRuntimeKey(plaintextKey)
    ]);
    return result.rowCount ? mapProviderRuntimeKeyRow(result.rows[0]) : null;
  }

  async listBuyerActivity(input: {
    wallet: string;
    range: BuyerActivityRange;
    limit: number;
  }): Promise<BuyerActivityResponse> {
    const minimumCreatedAtMs = rangeStart(input.range);
    const minimumCreatedAt = minimumCreatedAtMs === null ? null : new Date(minimumCreatedAtMs).toISOString();
    const result = await this.pool.query(
      `
      SELECT
        i.payment_id,
        i.provider_payout_source_kind,
        i.response_kind,
        i.response_status_code,
        i.quoted_price,
        i.payout_split,
        i.route_id,
        i.created_at,
        j.job_token,
        j.status AS job_status,
        r.status AS refund_status,
        r.amount AS refund_amount,
        r.tx_hash AS refund_tx_hash,
        e.provider,
        e.operation,
        e.title,
        e.mode,
        e.billing,
        e.service_id,
        s.slug AS service_slug,
        s.name AS service_name
      FROM idempotency_records i
      LEFT JOIN jobs j
        ON j.payment_id = i.payment_id
      LEFT JOIN refunds r
        ON r.payment_id = i.payment_id
      LEFT JOIN published_endpoint_versions e
        ON e.route_id = i.route_id
       AND e.version = i.route_version
      LEFT JOIN published_service_versions s
        ON s.version_id = e.service_version_id
      WHERE i.buyer_wallet = $1
        AND i.execution_status = 'completed'
        AND ($2::timestamptz IS NULL OR i.created_at >= $2)
      ORDER BY i.created_at DESC
      LIMIT $3
      `,
      [input.wallet, minimumCreatedAt, input.limit]
    );

    const items = result.rows.map((row) => {
      const payoutSplit = normalizePersistedPayoutSplit(row.payout_split as IdempotencyRecord["payoutSplit"]);
      const billing = row.billing as { type?: BuyerActivityItem["route"]["billingType"] } | null;
      const refund = row.refund_status
        ? {
            status: row.refund_status as RefundRecord["status"],
            amount: row.refund_amount as string,
            txHash: (row.refund_tx_hash as string | null) ?? null
          }
        : null;
      const job = row.job_token
        ? {
            jobToken: row.job_token as string,
            status: row.job_status as JobRecord["status"]
          }
        : null;

      return {
        paymentId: row.payment_id as string,
        kind: row.provider_payout_source_kind === "credit_topup" ? "credit_topup" : "route_charge",
        status: buyerActivityStatus({
          record: {
            responseKind: row.response_kind as IdempotencyRecord["responseKind"],
            responseStatusCode: Number(row.response_status_code)
          },
          job,
          refund
        }),
        amount: rawToDecimalString(row.quoted_price as string, 6),
        tokenSymbol: payoutSplit.currency,
        createdAt: new Date(row.created_at as string | Date).toISOString(),
        service: {
          slug: (row.service_slug as string | null) ?? (row.service_id as string | null) ?? "unknown-service",
          name: (row.service_name as string | null) ?? "Unknown service"
        },
        route: {
          ref:
            typeof row.provider === "string" && typeof row.operation === "string"
              ? buildRouteRef(row.provider as string, row.operation as string)
              : (row.route_id as string),
          title: (row.title as string | null) ?? (row.route_id as string),
          mode: (row.mode as BuyerActivityItem["route"]["mode"] | null) ?? (job ? "async" : "sync"),
          billingType: billing?.type ?? "fixed_x402"
        },
        job,
        refund: refund
          ? {
              status: refund.status,
              amount: rawToDecimalString(refund.amount, 6),
              txHash: refund.txHash
            }
          : null
      } satisfies BuyerActivityItem;
    });

    return summarizeBuyerActivity(input.wallet, items);
  }

  async getServiceAnalytics(routeIds: string[]): Promise<ServiceAnalytics> {
    const [idempotencyResult, jobsResult, attemptsResult] = await Promise.all([
      this.pool.query(
        `
        SELECT * FROM idempotency_records
        WHERE route_id = ANY($1::text[])
        `,
        [routeIds]
      ),
      this.pool.query(
        `
        SELECT * FROM jobs
        WHERE route_id = ANY($1::text[])
        `,
        [routeIds]
      ),
      this.pool.query(
        `
        SELECT * FROM provider_attempts
        WHERE route_id = ANY($1::text[])
        `,
        [routeIds]
      )
    ]);

    return computeServiceAnalytics({
      routeIds,
      idempotencyRecords: idempotencyResult.rows.map(mapIdempotencyRow),
      jobs: jobsResult.rows.map(mapJobRow),
      providerAttempts: attemptsResult.rows.map(mapAttemptRow)
    });
  }

  async listPublishedServices(): Promise<PublishedServiceVersionRecord[]> {
    const result = await this.pool.query(
      `
      SELECT v.*
      FROM provider_services s
      JOIN published_service_versions v
        ON v.version_id = s.latest_published_version_id
      WHERE s.status = 'published'
      ORDER BY v.name ASC
      `
    );

    return result.rows.map(mapPublishedServiceVersionRow);
  }

  async getPublishedServiceBySlug(slug: string): Promise<{ service: PublishedServiceVersionRecord; endpoints: PublishedServiceEndpointVersionRecord[] } | null> {
    const serviceResult = await this.pool.query(
      `
      SELECT v.*
      FROM provider_services s
      JOIN published_service_versions v
        ON v.version_id = s.latest_published_version_id
      WHERE v.slug = $1 AND s.status = 'published'
      `,
      [slug]
    );

    if (!serviceResult.rowCount) {
      return null;
    }

    const service = mapPublishedServiceVersionRow(serviceResult.rows[0]);
    const [endpointsResult, externalEndpointsResult] = await Promise.all([
      this.pool.query(
        `
        SELECT * FROM published_endpoint_versions
        WHERE service_version_id = $1
        ORDER BY operation ASC
        `,
        [service.versionId]
      ),
      this.pool.query(
        `
        SELECT * FROM published_external_endpoint_versions
        WHERE service_version_id = $1
        ORDER BY title ASC
        `,
        [service.versionId]
      )
    ]);

    return {
      service,
      endpoints: [
        ...endpointsResult.rows.map(mapPublishedEndpointVersionRow),
        ...externalEndpointsResult.rows.map(mapPublishedExternalEndpointVersionRow)
      ]
    };
  }

  async listPublishedRoutes(): Promise<PublishedEndpointVersionRecord[]> {
    const result = await this.pool.query(
      `
      SELECT e.*
      FROM provider_services s
      JOIN published_endpoint_versions e
        ON e.service_version_id = s.latest_published_version_id
      WHERE s.status = 'published'
      `
    );

    return result.rows.map(mapPublishedEndpointVersionRow);
  }

  async findPublishedRoute(provider: string, operation: string, network: MarketplaceRoute["network"]): Promise<PublishedEndpointVersionRecord | null> {
    const result = await this.pool.query(
      `
      SELECT e.*
      FROM provider_services s
      JOIN published_endpoint_versions e
        ON e.service_version_id = s.latest_published_version_id
      WHERE s.status = 'published'
        AND e.provider = $1
        AND e.operation = $2
        AND e.network = $3
      LIMIT 1
      `,
      [provider, operation, network]
    );

    return result.rowCount ? mapPublishedEndpointVersionRow(result.rows[0]) : null;
  }

  async getProviderAccountByWallet(wallet: string): Promise<ProviderAccountRecord | null> {
    const result = await this.pool.query("SELECT * FROM provider_accounts WHERE owner_wallet = $1", [wallet]);
    return result.rowCount ? mapProviderAccountRow(result.rows[0]) : null;
  }

  async upsertProviderAccount(wallet: string, input: UpsertProviderAccountInput): Promise<ProviderAccountRecord> {
    const existing = await this.getProviderAccountByWallet(wallet);
    if (existing) {
      const result = await this.pool.query(
        `
        UPDATE provider_accounts
        SET display_name = $2, bio = $3, website_url = $4, contact_email = $5, updated_at = NOW()
        WHERE owner_wallet = $1
        RETURNING *
        `,
        [wallet, input.displayName, input.bio ?? null, input.websiteUrl ?? null, input.contactEmail ?? null]
      );
      return mapProviderAccountRow(result.rows[0]);
    }

    const result = await this.pool.query(
      `
      INSERT INTO provider_accounts (id, owner_wallet, display_name, bio, website_url, contact_email)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *
      `,
      [randomUUID(), wallet, input.displayName, input.bio ?? null, input.websiteUrl ?? null, input.contactEmail ?? null]
    );
    return mapProviderAccountRow(result.rows[0]);
  }

  async listProviderServices(wallet: string): Promise<ProviderServiceDetailRecord[]> {
    const account = await this.getProviderAccountByWallet(wallet);
    if (!account) {
      return [];
    }

    const result = await this.pool.query(
      `
      SELECT id FROM provider_services
      WHERE provider_account_id = $1
      ORDER BY updated_at DESC
      `,
      [account.id]
    );

    return Promise.all(result.rows.map((row) => this.getProviderServiceDetailById(row.id as string)));
  }

  async createProviderService(wallet: string, input: CreateProviderServiceInput): Promise<ProviderServiceDetailRecord> {
    const account = await this.getProviderAccountByWallet(wallet);
    if (!account) {
      throw new Error("Provider account not found.");
    }

    await this.assertServiceUniqueness(input.slug, input.apiNamespace ?? null);
    const id = randomUUID();
    await this.pool.query(
      `
      INSERT INTO provider_services (
        id, provider_account_id, service_type, settlement_mode, slug, api_namespace, name, tagline, about, categories,
        prompt_intro, setup_instructions, website_url, payout_wallet, featured, status
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12::jsonb, $13, $14, $15, 'draft')
      `,
      [
        id,
        account.id,
        input.serviceType,
        isMarketplaceServiceType(input.serviceType) ? settlementModeForNewProviderService() : null,
        input.slug,
        isMarketplaceServiceType(input.serviceType) ? input.apiNamespace ?? null : null,
        input.name,
        input.tagline,
        input.about,
        JSON.stringify(input.categories),
        input.promptIntro,
        JSON.stringify(input.setupInstructions),
        input.websiteUrl ?? account.websiteUrl ?? null,
        isMarketplaceServiceType(input.serviceType) ? input.payoutWallet ?? null : null,
        Boolean(input.featured)
      ]
    );

    return this.getProviderServiceDetailById(id);
  }

  async getProviderServiceForOwner(serviceId: string, wallet: string): Promise<ProviderServiceDetailRecord | null> {
    try {
      const detail = await this.getProviderServiceDetailById(serviceId);
      return detail.account.ownerWallet === wallet ? detail : null;
    } catch (error) {
      if (error instanceof Error && error.message.includes("Provider service not found")) {
        return null;
      }

      throw error;
    }
  }

  async updateProviderServiceForOwner(
    serviceId: string,
    wallet: string,
    input: UpdateProviderServiceInput
  ): Promise<ProviderServiceRecord | null> {
    const detail = await this.getProviderServiceForOwner(serviceId, wallet);
    if (!detail) {
      return null;
    }

    const nextServiceType = input.serviceType ?? detail.service.serviceType;
    if (nextServiceType !== detail.service.serviceType) {
      if (
        detail.endpoints.length > 0
        || detail.latestPublishedVersionId
        || detail.latestReview
        || await this.getProviderRuntimeKeyForOwner(serviceId, wallet)
      ) {
        throw new Error("serviceType can only change before endpoints, runtime keys, or published versions exist.");
      }
    }

    const nextSlug = input.slug ?? detail.service.slug;
    const nextNamespace = isMarketplaceServiceType(nextServiceType)
      ? (input.apiNamespace === undefined ? detail.service.apiNamespace : input.apiNamespace)
      : null;
    const nextPayoutWallet = isMarketplaceServiceType(nextServiceType)
      ? (input.payoutWallet === undefined ? detail.service.payoutWallet : input.payoutWallet)
      : null;
    await this.assertServiceUniqueness(nextSlug, nextNamespace, serviceId);

    const client = await this.pool.connect();

    try {
      await client.query("BEGIN");
      const result = await client.query(
        `
        UPDATE provider_services
        SET
          service_type = $2,
          settlement_mode = $3,
          slug = $4,
          api_namespace = $5,
          name = $6,
          tagline = $7,
          about = $8,
          categories = $9::jsonb,
          prompt_intro = $10,
          setup_instructions = $11::jsonb,
          website_url = $12,
          payout_wallet = $13,
          featured = $14,
          updated_at = NOW()
        WHERE id = $1
        RETURNING *
        `,
        [
          serviceId,
          nextServiceType,
          isMarketplaceServiceType(nextServiceType)
            ? (nextServiceType === detail.service.serviceType
              ? detail.service.settlementMode ?? settlementModeForNewProviderService()
              : settlementModeForNewProviderService())
            : null,
          nextSlug,
          nextNamespace,
          input.name ?? detail.service.name,
          input.tagline ?? detail.service.tagline,
          input.about ?? detail.service.about,
          JSON.stringify(input.categories ?? detail.service.categories),
          input.promptIntro ?? detail.service.promptIntro,
          JSON.stringify(input.setupInstructions ?? detail.service.setupInstructions),
          input.websiteUrl === undefined ? detail.service.websiteUrl : input.websiteUrl,
          nextPayoutWallet,
          input.featured ?? detail.service.featured
        ]
      );

      if (!result.rowCount) {
        await client.query("ROLLBACK");
        return null;
      }

      if (nextPayoutWallet !== detail.service.payoutWallet) {
        await client.query(
          `
          UPDATE provider_endpoint_drafts
          SET
            payout = jsonb_set(
              COALESCE(payout, '{}'::jsonb),
              '{providerWallet}',
              CASE
                WHEN $2::text IS NULL THEN 'null'::jsonb
                ELSE to_jsonb($2::text)
              END,
              true
            ),
            updated_at = NOW()
          WHERE service_id = $1
          `,
          [serviceId, nextPayoutWallet]
        );
      }

      await client.query("COMMIT");
      return mapProviderServiceRow(result.rows[0]);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async createProviderEndpointDraft(
    serviceId: string,
    wallet: string,
    input: CreateProviderEndpointDraftInput,
    secretMaterial?: { label: string; ciphertext: string; iv: string; authTag: string } | null
  ): Promise<ProviderEndpointDraftRecord> {
    const detail = await this.getProviderServiceForOwner(serviceId, wallet);
    if (!detail) {
      throw new Error("Provider service not found.");
    }

    if (detail.service.serviceType === "external_registry") {
      if (input.endpointType !== "external_registry") {
        throw new Error("External services only accept external endpoint drafts.");
      }

      if (detail.endpoints.some((endpoint) =>
        isExternalEndpointDraft(endpoint)
        && endpoint.method === input.method
        && endpoint.publicUrl === input.publicUrl
      )) {
        throw new Error(`External endpoint already exists: ${input.method} ${input.publicUrl}`);
      }

      let result;
      try {
        result = await this.pool.query(
          `
          INSERT INTO provider_external_endpoint_drafts (
            id, service_id, title, description, method, public_url, docs_url, auth_notes, request_example, response_example, usage_notes
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11
          )
          RETURNING *
          `,
          [
            randomUUID(),
            serviceId,
            input.title,
            input.description,
            input.method,
            input.publicUrl,
            input.docsUrl,
            input.authNotes ?? null,
            JSON.stringify(input.requestExample),
            JSON.stringify(input.responseExample),
            input.usageNotes ?? null
          ]
        );
      } catch (error) {
        if (!isPostgresUniqueViolation(error)) {
          throw error;
        }

        throw new Error(`External endpoint already exists: ${input.method} ${input.publicUrl}`);
      }

      return mapProviderExternalEndpointDraftRow(result.rows[0]);
    }

    if (input.endpointType !== "marketplace_proxy") {
      throw new Error("Marketplace services only accept marketplace endpoint drafts.");
    }

    const secretRef = secretMaterial
      ? (
          await this.pool.query(
            `
            INSERT INTO provider_secrets (id, provider_account_id, label, secret_ciphertext, iv, auth_tag)
            VALUES ($1, $2, $3, $4, $5, $6)
            RETURNING *
            `,
            [
              randomUUID(),
              detail.account.id,
              secretMaterial.label,
              secretMaterial.ciphertext,
              secretMaterial.iv,
              secretMaterial.authTag
            ]
          )
        ).rows[0].id as string
      : null;
    const billing = createDraftRouteBilling(input);
    const apiNamespace = detail.service.apiNamespace;
    if (!apiNamespace) {
      throw new Error("Marketplace services require an apiNamespace before creating endpoints.");
    }

    const result = await this.pool.query(
      `
      INSERT INTO provider_endpoint_drafts (
        id, service_id, route_id, operation, method, title, description, price, billing, mode, request_schema_json, response_schema_json,
        request_example, response_example, usage_notes, executor_kind, async_config, upstream_base_url, upstream_path,
        upstream_auth_mode, upstream_auth_header_name, upstream_secret_ref, payout
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11::jsonb, $12::jsonb, $13::jsonb, $14::jsonb, $15, $16, $17::jsonb, $18, $19,
        $20, $21, $22, $23::jsonb
      )
      RETURNING *
      `,
      [
        randomUUID(),
        serviceId,
        buildRouteId(apiNamespace, input.operation),
        input.operation,
        input.method,
        input.title,
        input.description,
        billing.price,
        JSON.stringify(billing.billing),
        input.mode,
        JSON.stringify(input.requestSchemaJson),
        JSON.stringify(input.responseSchemaJson),
        JSON.stringify(input.requestExample),
        JSON.stringify(input.responseExample),
        input.usageNotes ?? null,
        billing.billing.type === "topup_x402_variable" ? "marketplace" : "http",
        JSON.stringify(
          billing.billing.type === "topup_x402_variable"
            ? null
            : buildRouteAsyncConfig({
                mode: input.mode,
                asyncStrategy: input.asyncStrategy ?? null,
                asyncTimeoutMs: input.asyncTimeoutMs ?? null,
                pollPath: input.pollPath ?? null
              })
        ),
        billing.billing.type === "topup_x402_variable" ? null : input.upstreamBaseUrl ?? null,
        billing.billing.type === "topup_x402_variable" ? null : input.upstreamPath ?? null,
        billing.billing.type === "topup_x402_variable" ? null : input.upstreamAuthMode ?? null,
        billing.billing.type === "topup_x402_variable" ? null : input.upstreamAuthHeaderName ?? null,
        billing.billing.type === "topup_x402_variable" ? null : secretRef,
        JSON.stringify({
          providerAccountId: detail.account.id,
          providerWallet: detail.service.payoutWallet,
          providerBps: 10_000
        })
      ]
    );

    return mapProviderEndpointDraftRow(result.rows[0]);
  }

  async updateProviderEndpointDraft(
    serviceId: string,
    endpointId: string,
    wallet: string,
    input: UpdateProviderEndpointDraftInput,
    secretMaterial?: { label: string; ciphertext: string; iv: string; authTag: string } | null
  ): Promise<ProviderEndpointDraftRecord | null> {
    const detail = await this.getProviderServiceForOwner(serviceId, wallet);
    if (!detail) {
      return null;
    }

    const [existingResult, existingExternalResult] = await Promise.all([
      this.pool.query(
        "SELECT * FROM provider_endpoint_drafts WHERE id = $1 AND service_id = $2",
        [endpointId, serviceId]
      ),
      this.pool.query(
        "SELECT * FROM provider_external_endpoint_drafts WHERE id = $1 AND service_id = $2",
        [endpointId, serviceId]
      )
    ]);
    if (!existingResult.rowCount && !existingExternalResult.rowCount) {
      return null;
    }

    if (existingExternalResult.rowCount) {
      if (input.endpointType !== "external_registry") {
        throw new Error("External endpoint drafts only accept external updates.");
      }

      const existing = mapProviderExternalEndpointDraftRow(existingExternalResult.rows[0]);
      const nextMethod = input.method ?? existing.method;
      const nextPublicUrl = input.publicUrl ?? existing.publicUrl;
      if (
        (nextMethod !== existing.method || nextPublicUrl !== existing.publicUrl)
        && detail.endpoints.some((endpoint) =>
          endpoint.id !== endpointId
          && isExternalEndpointDraft(endpoint)
          && endpoint.method === nextMethod
          && endpoint.publicUrl === nextPublicUrl
        )
      ) {
        throw new Error(`External endpoint already exists: ${nextMethod} ${nextPublicUrl}`);
      }

      let result;
      try {
        result = await this.pool.query(
          `
          UPDATE provider_external_endpoint_drafts
          SET
            title = $3,
            description = $4,
            method = $5,
            public_url = $6,
            docs_url = $7,
            auth_notes = $8,
            request_example = $9::jsonb,
            response_example = $10::jsonb,
            usage_notes = $11,
            updated_at = NOW()
          WHERE id = $1 AND service_id = $2
          RETURNING *
          `,
          [
            endpointId,
            serviceId,
            input.title ?? existing.title,
            input.description ?? existing.description,
            nextMethod,
            nextPublicUrl,
            input.docsUrl ?? existing.docsUrl,
            input.authNotes === undefined ? existing.authNotes : input.authNotes,
            JSON.stringify(input.requestExample === undefined ? existing.requestExample : input.requestExample),
            JSON.stringify(input.responseExample === undefined ? existing.responseExample : input.responseExample),
            input.usageNotes === undefined ? existing.usageNotes : input.usageNotes
          ]
        );
      } catch (error) {
        if (!isPostgresUniqueViolation(error)) {
          throw error;
        }

        throw new Error(`External endpoint already exists: ${nextMethod} ${nextPublicUrl}`);
      }

      return result.rowCount ? mapProviderExternalEndpointDraftRow(result.rows[0]) : null;
    }

    if (input.endpointType !== "marketplace_proxy") {
      throw new Error("Marketplace endpoint drafts only accept marketplace updates.");
    }

    const existing = mapProviderEndpointDraftRow(existingResult.rows[0]);

    let secretRef = existing.upstreamSecretRef;
    if (input.clearUpstreamSecret) {
      secretRef = null;
    }
    if (secretMaterial) {
      const secretResult = await this.pool.query(
        `
        INSERT INTO provider_secrets (id, provider_account_id, label, secret_ciphertext, iv, auth_tag)
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING id
        `,
        [
          randomUUID(),
          detail.account.id,
          secretMaterial.label,
          secretMaterial.ciphertext,
          secretMaterial.iv,
          secretMaterial.authTag
        ]
      );
      secretRef = secretResult.rows[0].id as string;
    }

    const operation = input.operation ?? existing.operation;
    const apiNamespace = detail.service.apiNamespace;
    if (!apiNamespace) {
      throw new Error("Marketplace services require an apiNamespace before updating endpoints.");
    }
    const billing = createDraftRouteBilling({
      billingType: input.billingType ?? existing.billing.type,
      price: input.price ?? existing.price,
      minAmount: input.minAmount ?? (existing.billing.type === "topup_x402_variable" ? existing.billing.minAmount : null),
      maxAmount: input.maxAmount ?? (existing.billing.type === "topup_x402_variable" ? existing.billing.maxAmount : null)
    });
    const result = await this.pool.query(
      `
      UPDATE provider_endpoint_drafts
      SET
        route_id = $3,
        operation = $4,
        method = $5,
        title = $6,
        description = $7,
        price = $8,
        billing = $9::jsonb,
        mode = $10,
        async_config = $11::jsonb,
        request_schema_json = $12::jsonb,
        response_schema_json = $13::jsonb,
        request_example = $14::jsonb,
        response_example = $15::jsonb,
        usage_notes = $16,
        executor_kind = $17,
        upstream_base_url = $18,
        upstream_path = $19,
        upstream_auth_mode = $20,
        upstream_auth_header_name = $21,
        upstream_secret_ref = $22,
        payout = $23::jsonb,
        updated_at = NOW()
      WHERE id = $1 AND service_id = $2
      RETURNING *
      `,
      [
        endpointId,
        serviceId,
        buildRouteId(apiNamespace, operation),
        operation,
        input.method ?? existing.method,
        input.title ?? existing.title,
        input.description ?? existing.description,
        billing.price,
        JSON.stringify(billing.billing),
        input.mode ?? existing.mode,
        JSON.stringify(
          billing.billing.type === "topup_x402_variable"
            ? null
            : buildRouteAsyncConfig({
                mode: input.mode ?? existing.mode,
                asyncStrategy: input.asyncStrategy ?? existing.asyncConfig?.strategy ?? null,
                asyncTimeoutMs: input.asyncTimeoutMs ?? existing.asyncConfig?.timeoutMs ?? null,
                pollPath: input.pollPath === undefined
                  ? (existing.asyncConfig?.pollPath ?? null)
                  : input.pollPath
              }, existing.asyncConfig)
        ),
        JSON.stringify(input.requestSchemaJson ?? existing.requestSchemaJson),
        JSON.stringify(input.responseSchemaJson ?? existing.responseSchemaJson),
        JSON.stringify(input.requestExample === undefined ? existing.requestExample : input.requestExample),
        JSON.stringify(input.responseExample === undefined ? existing.responseExample : input.responseExample),
        input.usageNotes === undefined ? existing.usageNotes : input.usageNotes,
        billing.billing.type === "topup_x402_variable" ? "marketplace" : "http",
        billing.billing.type === "topup_x402_variable" ? null : input.upstreamBaseUrl ?? existing.upstreamBaseUrl,
        billing.billing.type === "topup_x402_variable" ? null : input.upstreamPath ?? existing.upstreamPath,
        billing.billing.type === "topup_x402_variable" ? null : input.upstreamAuthMode ?? existing.upstreamAuthMode,
        billing.billing.type === "topup_x402_variable"
          ? null
          : input.upstreamAuthHeaderName === undefined
          ? existing.upstreamAuthHeaderName
          : input.upstreamAuthHeaderName,
        billing.billing.type === "topup_x402_variable" ? null : secretRef,
        JSON.stringify({
          providerAccountId: detail.account.id,
          providerWallet: detail.service.payoutWallet,
          providerBps: 10_000
        })
      ]
    );

    return result.rowCount ? mapProviderEndpointDraftRow(result.rows[0]) : null;
  }

  async deleteProviderEndpointDraft(serviceId: string, endpointId: string, wallet: string): Promise<boolean> {
    const detail = await this.getProviderServiceForOwner(serviceId, wallet);
    if (!detail) {
      return false;
    }

    const [result, externalResult] = await Promise.all([
      this.pool.query(
        "DELETE FROM provider_endpoint_drafts WHERE id = $1 AND service_id = $2",
        [endpointId, serviceId]
      ),
      this.pool.query(
        "DELETE FROM provider_external_endpoint_drafts WHERE id = $1 AND service_id = $2",
        [endpointId, serviceId]
      )
    ]);
    return Boolean(result.rowCount || externalResult.rowCount);
  }

  async createProviderVerificationChallenge(serviceId: string, wallet: string): Promise<ProviderVerificationRecord | null> {
    const detail = await this.getProviderServiceForOwner(serviceId, wallet);
    if (!detail) {
      return null;
    }

    const result = await this.pool.query(
      `
      INSERT INTO provider_verifications (id, service_id, token, status)
      VALUES ($1, $2, $3, 'pending')
      RETURNING *
      `,
      [randomUUID(), serviceId, `verify_${randomUUID()}`]
    );
    return mapProviderVerificationRow(result.rows[0]);
  }

  async getLatestProviderVerification(serviceId: string): Promise<ProviderVerificationRecord | null> {
    const result = await this.pool.query(
      `
      SELECT * FROM provider_verifications
      WHERE service_id = $1
      ORDER BY created_at DESC
      LIMIT 1
      `,
      [serviceId]
    );
    return result.rowCount ? mapProviderVerificationRow(result.rows[0]) : null;
  }

  async markProviderVerificationResult(
    serviceId: string,
    status: ProviderVerificationStatus,
    input?: { verifiedHost?: string | null; failureReason?: string | null }
  ): Promise<ProviderVerificationRecord | null> {
    const latest = await this.getLatestProviderVerification(serviceId);
    if (!latest) {
      return null;
    }

    const result = await this.pool.query(
      `
      UPDATE provider_verifications
      SET status = $2, verified_host = $3, failure_reason = $4, updated_at = NOW()
      WHERE id = $1
      RETURNING *
      `,
      [
        latest.id,
        status,
        input?.verifiedHost ?? latest.verifiedHost,
        input?.failureReason ?? (status === "verified" ? null : latest.failureReason)
      ]
    );

    return result.rowCount ? mapProviderVerificationRow(result.rows[0]) : null;
  }

  async submitProviderService(serviceId: string, wallet: string): Promise<ProviderServiceDetailRecord | null> {
    const detail = await this.getProviderServiceForOwner(serviceId, wallet);
    if (!detail) {
      return null;
    }

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const countResult = await client.query(
        "SELECT COUNT(*)::int AS count FROM published_service_versions WHERE service_id = $1",
        [serviceId]
      );
      const versionTag = `v${(countResult.rows[0].count as number) + 1}`;
      const serviceVersionId = randomUUID();
      const reviewId = randomUUID();
      const network = this.networkConfig;

      await client.query(
        `
        INSERT INTO published_service_versions (
          version_id, service_id, provider_account_id, service_type, settlement_mode, slug, api_namespace, name, owner_name, tagline, about,
          categories, route_ids, featured, prompt_intro, setup_instructions, website_url, contact_email,
          payout_wallet, status, submitted_review_id
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13::jsonb, $14, $15, $16::jsonb, $17, $18, $19, 'pending_review', $20
        )
        `,
        [
          serviceVersionId,
          serviceId,
          detail.account.id,
          detail.service.serviceType,
          detail.service.settlementMode,
          detail.service.slug,
          detail.service.apiNamespace,
          detail.service.name,
          detail.account.displayName,
          detail.service.tagline,
          detail.service.about,
          JSON.stringify(detail.service.categories),
          JSON.stringify(detail.endpoints.filter(isMarketplaceEndpointDraft).map((endpoint) => endpoint.routeId)),
          detail.service.featured,
          detail.service.promptIntro,
          JSON.stringify(detail.service.setupInstructions),
          detail.service.websiteUrl,
          detail.account.contactEmail,
          detail.service.payoutWallet,
          reviewId
        ]
      );

      for (const endpoint of detail.endpoints.filter(isMarketplaceEndpointDraft)) {
        await client.query(
          `
          INSERT INTO published_endpoint_versions (
            endpoint_version_id, service_id, service_version_id, endpoint_draft_id, route_id, provider, operation,
            version, method, settlement_mode, mode, network, price, billing, async_config, title, description, payout, request_example, response_example, usage_notes,
            request_schema_json, response_schema_json, executor_kind, upstream_base_url, upstream_path,
            upstream_auth_mode, upstream_auth_header_name, upstream_secret_ref
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, $15::jsonb, $16, $17, $18::jsonb, $19::jsonb, $20::jsonb, $21,
            $22::jsonb, $23::jsonb, $24, $25, $26, $27, $28, $29
          )
          `,
          [
            randomUUID(),
            serviceId,
            serviceVersionId,
            endpoint.id,
            endpoint.routeId,
            detail.service.apiNamespace,
            endpoint.operation,
            versionTag,
            endpoint.method,
            detail.service.settlementMode,
            endpoint.mode,
            network.paymentNetwork,
            endpoint.price,
            JSON.stringify(endpoint.billing),
            JSON.stringify(endpoint.asyncConfig ?? null),
            endpoint.title,
            endpoint.description,
            JSON.stringify(endpoint.payout),
            JSON.stringify(endpoint.requestExample),
            JSON.stringify(endpoint.responseExample),
            endpoint.usageNotes,
            JSON.stringify(endpoint.requestSchemaJson),
            JSON.stringify(endpoint.responseSchemaJson),
            endpoint.executorKind,
            endpoint.upstreamBaseUrl,
            endpoint.upstreamPath,
            endpoint.upstreamAuthMode,
            endpoint.upstreamAuthHeaderName,
            endpoint.upstreamSecretRef
          ]
        );
      }

      for (const endpoint of detail.endpoints.filter(isExternalEndpointDraft)) {
        await client.query(
          `
          INSERT INTO published_external_endpoint_versions (
            endpoint_version_id, service_id, service_version_id, endpoint_draft_id, title, description, method, public_url,
            docs_url, auth_notes, request_example, response_example, usage_notes
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12::jsonb, $13
          )
          `,
          [
            randomUUID(),
            serviceId,
            serviceVersionId,
            endpoint.id,
            endpoint.title,
            endpoint.description,
            endpoint.method,
            endpoint.publicUrl,
            endpoint.docsUrl,
            endpoint.authNotes,
            JSON.stringify(endpoint.requestExample),
            JSON.stringify(endpoint.responseExample),
            endpoint.usageNotes
          ]
        );
      }

      await client.query(
        `
        INSERT INTO provider_reviews (id, service_id, submitted_version_id, status, review_notes, reviewer_identity)
        VALUES ($1, $2, $3, 'pending_review', NULL, NULL)
        `,
        [reviewId, serviceId, serviceVersionId]
      );

      await client.query(
        `
        UPDATE provider_services
        SET status = 'pending_review', latest_submitted_version_id = $2, latest_review_id = $3, updated_at = NOW()
        WHERE id = $1
        `,
        [serviceId, serviceVersionId, reviewId]
      );

      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

    return this.getProviderServiceDetailById(serviceId);
  }

  async listAdminProviderServices(status?: ProviderServiceStatus): Promise<ProviderServiceDetailRecord[]> {
    const result = await this.pool.query(
      `
      SELECT id FROM provider_services
      WHERE ($1::text IS NULL OR status = $1)
      ORDER BY updated_at DESC
      `,
      [status ?? null]
    );

    return Promise.all(result.rows.map((row) => this.getProviderServiceDetailById(row.id as string)));
  }

  async getAdminProviderService(serviceId: string): Promise<ProviderServiceDetailRecord | null> {
    try {
      return await this.getProviderServiceDetailById(serviceId);
    } catch {
      return null;
    }
  }

  async getSubmittedProviderService(serviceId: string): Promise<ProviderServiceDetailRecord | null> {
    const detail = await this.getAdminProviderService(serviceId);
    const submittedVersionId = detail?.latestReview?.submittedVersionId ?? null;
    if (!detail || !submittedVersionId) {
      return null;
    }

    const [serviceResult, endpointsResult, externalEndpointsResult] = await Promise.all([
      this.pool.query("SELECT * FROM published_service_versions WHERE version_id = $1", [submittedVersionId]),
      this.pool.query(
        `
        SELECT * FROM published_endpoint_versions
        WHERE service_version_id = $1
        ORDER BY operation ASC
        `,
        [submittedVersionId]
      ),
      this.pool.query(
        `
        SELECT * FROM published_external_endpoint_versions
        WHERE service_version_id = $1
        ORDER BY title ASC
        `,
        [submittedVersionId]
      )
    ]);

    if (!serviceResult.rowCount) {
      return null;
    }

    return buildSubmittedProviderServiceDetail({
      version: mapPublishedServiceVersionRow(serviceResult.rows[0]),
      account: detail.account,
      endpoints: [
        ...endpointsResult.rows.map(mapPublishedEndpointVersionRow),
        ...externalEndpointsResult.rows.map(mapPublishedExternalEndpointVersionRow)
      ],
      verification: detail.verification,
      latestReview: detail.latestReview,
      latestPublishedVersionId: detail.latestPublishedVersionId
    });
  }

  async requestProviderServiceChanges(
    serviceId: string,
    input: { reviewNotes: string; reviewerIdentity?: string | null }
  ): Promise<ProviderServiceDetailRecord | null> {
    const service = await this.getAdminProviderService(serviceId);
    if (!service?.latestReview) {
      return null;
    }

    await this.pool.query(
      `
      UPDATE provider_reviews
      SET status = 'changes_requested', review_notes = $2, reviewer_identity = $3, updated_at = NOW()
      WHERE id = $1
      `,
      [service.latestReview.id, input.reviewNotes, input.reviewerIdentity ?? null]
    );
    await this.pool.query(
      `
      UPDATE provider_services
      SET status = 'changes_requested', updated_at = NOW()
      WHERE id = $1
      `,
      [serviceId]
    );
    await this.pool.query(
      `
      UPDATE published_service_versions
      SET status = 'changes_requested', updated_at = NOW()
      WHERE version_id = $1
      `,
      [service.latestReview.submittedVersionId]
    );

    return this.getProviderServiceDetailById(serviceId);
  }

  async publishProviderService(
    serviceId: string,
    input?: { reviewerIdentity?: string | null; settlementMode?: SettlementMode | null; submittedVersionId?: string | null }
  ): Promise<ProviderServiceDetailRecord | null> {
    const service = await this.getAdminProviderService(serviceId);
    if (!service) {
      return null;
    }

    const submittedVersionId = input?.submittedVersionId ?? service.latestReview?.submittedVersionId ?? null;
    if (!submittedVersionId) {
      return null;
    }

    const versionResult = await this.pool.query(
      `
      SELECT slug, api_namespace
      FROM published_service_versions
      WHERE service_id = $1 AND version_id = $2
      LIMIT 1
      `,
      [serviceId, submittedVersionId]
    );
    if (!versionResult.rowCount) {
      return null;
    }

    await this.assertServiceUniqueness(
      versionResult.rows[0].slug as string,
      (versionResult.rows[0].api_namespace as string | null) ?? null,
      serviceId
    );

    const settlementMode = service.service.serviceType === "marketplace_proxy"
      ? normalizeSettlementMode(
        input?.settlementMode ?? service.service.settlementMode,
        service.service.settlementMode ?? "verified_escrow"
      )
      : null;

    await this.pool.query(
      `
      UPDATE provider_reviews
      SET status = 'published', reviewer_identity = COALESCE($3, reviewer_identity), updated_at = NOW()
      WHERE service_id = $1 AND submitted_version_id = $2
      `,
      [serviceId, submittedVersionId, input?.reviewerIdentity ?? null]
    );
    await this.pool.query(
      `
      UPDATE published_service_versions
      SET status = 'published', settlement_mode = $3, published_at = NOW(), updated_at = NOW()
      WHERE service_id = $1 AND version_id = $2
      `,
      [serviceId, submittedVersionId, settlementMode]
    );
    if (settlementMode) {
      await this.pool.query(
        `
        UPDATE published_endpoint_versions
        SET settlement_mode = $3, updated_at = NOW()
        WHERE service_id = $1 AND service_version_id = $2
        `,
        [serviceId, submittedVersionId, settlementMode]
      );
    }
    await this.pool.query(
      `
      UPDATE provider_services
      SET status = 'published', settlement_mode = $2, latest_published_version_id = $3, updated_at = NOW()
      WHERE id = $1
      `,
      [serviceId, settlementMode, submittedVersionId]
    );

    return this.getProviderServiceDetailById(serviceId);
  }

  async updateProviderServiceSettlementMode(
    serviceId: string,
    input: {
      settlementMode: SettlementMode;
      reviewerIdentity?: string | null;
      submittedVersionId?: string | null;
      publishedVersionId?: string | null;
    }
  ): Promise<ProviderServiceDetailRecord | null> {
    const service = await this.getAdminProviderService(serviceId);
    if (!service) {
      return null;
    }

    if (service.service.serviceType === "external_registry") {
      return this.getProviderServiceDetailById(serviceId);
    }

    const settlementMode = normalizeSettlementMode(input.settlementMode, service.service.settlementMode ?? "verified_escrow");
    const versionIds = Array.from(
      new Set(
        [
          input.submittedVersionId ?? service.latestReview?.submittedVersionId ?? null,
          input.publishedVersionId ?? service.latestPublishedVersionId ?? null
        ].filter((value): value is string => Boolean(value))
      )
    );
    const client = await this.pool.connect();

    try {
      await client.query("BEGIN");
      await client.query(
        `
        UPDATE provider_services
        SET settlement_mode = $2, updated_at = NOW()
        WHERE id = $1
        `,
        [serviceId, settlementMode]
      );

      if (versionIds.length > 0) {
        await client.query(
          `
          UPDATE published_service_versions
          SET settlement_mode = $2, updated_at = NOW()
          WHERE version_id = ANY($1::text[])
          `,
          [versionIds, settlementMode]
        );

        await client.query(
          `
          UPDATE published_endpoint_versions
          SET settlement_mode = $2, updated_at = NOW()
          WHERE service_version_id = ANY($1::text[])
          `,
          [versionIds, settlementMode]
        );
      }

      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

    return this.getProviderServiceDetailById(serviceId);
  }

  async suspendProviderService(
    serviceId: string,
    input?: { reviewNotes?: string | null; reviewerIdentity?: string | null }
  ): Promise<ProviderServiceDetailRecord | null> {
    const service = await this.getAdminProviderService(serviceId);
    if (!service) {
      return null;
    }

    await this.pool.query(
      `
      UPDATE provider_services
      SET status = 'suspended', updated_at = NOW()
      WHERE id = $1
      `,
      [serviceId]
    );

    if (service.latestReview) {
      await this.pool.query(
        `
        UPDATE provider_reviews
        SET status = 'suspended', review_notes = COALESCE($2, review_notes), reviewer_identity = COALESCE($3, reviewer_identity), updated_at = NOW()
        WHERE id = $1
        `,
        [service.latestReview.id, input?.reviewNotes ?? null, input?.reviewerIdentity ?? null]
      );
      await this.pool.query(
        `
        UPDATE published_service_versions
        SET status = 'suspended', updated_at = NOW()
        WHERE version_id = $1
        `,
        [service.latestReview.submittedVersionId]
      );
    }

    return this.getProviderServiceDetailById(serviceId);
  }

  async getProviderSecret(secretId: string): Promise<ProviderSecretRecord | null> {
    const result = await this.pool.query("SELECT * FROM provider_secrets WHERE id = $1", [secretId]);
    return result.rowCount ? mapProviderSecretRow(result.rows[0]) : null;
  }

  async createSuggestion(input: CreateSuggestionInput): Promise<SuggestionRecord> {
    const result = await this.pool.query(
      `
      INSERT INTO service_suggestions (
        id, type, service_slug, title, description, source_url, requester_name, requester_email, status, internal_notes
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'submitted', NULL)
      RETURNING *
      `,
      [
        randomUUID(),
        input.type,
        input.serviceSlug ?? null,
        input.title,
        input.description,
        input.sourceUrl ?? null,
        input.requesterName ?? null,
        input.requesterEmail ?? null
      ]
    );

    return mapSuggestionRow(result.rows[0]);
  }

  async listSuggestions(filter?: { status?: SuggestionStatus }): Promise<SuggestionRecord[]> {
    const hasStatus = Boolean(filter?.status);
    const result = await this.pool.query(
      `
      SELECT * FROM service_suggestions
      WHERE ($1::text IS NULL OR status = $1)
      ORDER BY created_at DESC
      `,
      [hasStatus ? filter?.status ?? null : null]
    );

    return result.rows.map(mapSuggestionRow);
  }

  async updateSuggestion(id: string, input: UpdateSuggestionInput): Promise<SuggestionRecord | null> {
    const result = await this.pool.query(
      `
      UPDATE service_suggestions
      SET
        status = COALESCE($2, status),
        internal_notes = CASE
          WHEN $3::boolean THEN $4
          ELSE internal_notes
        END,
        claimed_provider_account_id = CASE
          WHEN COALESCE($2, status) = 'submitted' THEN NULL
          ELSE claimed_provider_account_id
        END,
        claimed_provider_name = CASE
          WHEN COALESCE($2, status) = 'submitted' THEN NULL
          ELSE claimed_provider_name
        END,
        claimed_at = CASE
          WHEN COALESCE($2, status) = 'submitted' THEN NULL
          ELSE claimed_at
        END,
        updated_at = NOW()
      WHERE id = $1
      RETURNING *
      `,
      [
        id,
        input.status ?? null,
        input.internalNotes !== undefined,
        input.internalNotes ?? null
      ]
    );

    return result.rowCount ? mapSuggestionRow(result.rows[0]) : null;
  }

  async listProviderRequests(wallet: string): Promise<SuggestionRecord[]> {
    const account = await this.getProviderAccountByWallet(wallet);
    if (!account) {
      return [];
    }

    const result = await this.pool.query(
      `
      SELECT *
      FROM service_suggestions
      WHERE status <> 'rejected'
        AND status <> 'shipped'
      ORDER BY
        CASE
          WHEN claimed_provider_account_id = $1 THEN 0
          WHEN claimed_provider_account_id IS NULL THEN 1
          ELSE 2
        END,
        updated_at DESC
      `,
      [account.id]
    );

    return result.rows.map(mapSuggestionRow);
  }

  async claimProviderRequest(id: string, wallet: string): Promise<SuggestionRecord | null> {
    const account = await this.getProviderAccountByWallet(wallet);
    if (!account) {
      throw new Error("Provider account not found.");
    }

    const existingResult = await this.pool.query(
      `
      SELECT *
      FROM service_suggestions
      WHERE id = $1
      LIMIT 1
      `,
      [id]
    );

    if (!existingResult.rowCount) {
      return null;
    }

    const existing = mapSuggestionRow(existingResult.rows[0]);
    if (!isSuggestionProviderVisible(existing.status) || existing.status === "shipped") {
      throw new Error("Request is not claimable.");
    }

    if (existing.claimedByProviderAccountId && existing.claimedByProviderAccountId !== account.id) {
      throw new Error(`Request already claimed by ${existing.claimedByProviderName ?? "another provider"}.`);
    }

    if (existing.claimedByProviderAccountId === account.id) {
      return existing;
    }

    const result = await this.pool.query(
      `
      UPDATE service_suggestions
      SET
        status = CASE
          WHEN status = 'submitted' THEN 'reviewing'
          ELSE status
        END,
        claimed_provider_account_id = $2,
        claimed_provider_name = $3,
        claimed_at = NOW(),
        updated_at = NOW()
      WHERE id = $1
        AND status <> 'rejected'
        AND status <> 'shipped'
        AND (claimed_provider_account_id IS NULL OR claimed_provider_account_id = $2)
      RETURNING *
      `,
      [id, account.id, account.displayName]
    );

    if (!result.rowCount) {
      throw new Error(`Request already claimed by ${existing.claimedByProviderName ?? "another provider"}.`);
    }

    return mapSuggestionRow(result.rows[0]);
  }

  private async assertServiceUniqueness(slug: string, apiNamespace: string | null, serviceId?: string) {
    const result = await this.pool.query(
      `
      SELECT
        EXISTS (
          SELECT 1
          FROM provider_services s
          LEFT JOIN published_service_versions v
            ON v.version_id = s.latest_published_version_id
            AND s.status = 'published'
          WHERE (s.slug = $1 OR v.slug = $1)
            AND ($3::text IS NULL OR s.id <> $3)
        ) AS slug_conflict,
        EXISTS (
          SELECT 1
          FROM provider_services s
          LEFT JOIN published_service_versions v
            ON v.version_id = s.latest_published_version_id
            AND s.status = 'published'
          WHERE $2::text IS NOT NULL
            AND (s.api_namespace = $2 OR v.api_namespace = $2)
            AND ($3::text IS NULL OR s.id <> $3)
        ) AS namespace_conflict
      `,
      [slug, apiNamespace, serviceId ?? null]
    );

    if (result.rows[0]?.slug_conflict) {
      throw new Error(`Service slug already exists: ${slug}`);
    }

    if (result.rows[0]?.namespace_conflict) {
      throw new Error(`API namespace already exists: ${apiNamespace ?? ""}`);
    }
  }

  private async getProviderServiceDetailById(serviceId: string): Promise<ProviderServiceDetailRecord> {
    const serviceResult = await this.pool.query("SELECT * FROM provider_services WHERE id = $1", [serviceId]);
    if (!serviceResult.rowCount) {
      throw new Error(`Provider service not found: ${serviceId}`);
    }

    const service = mapProviderServiceRow(serviceResult.rows[0]);
    const accountResult = await this.pool.query("SELECT * FROM provider_accounts WHERE id = $1", [service.providerAccountId]);
    if (!accountResult.rowCount) {
      throw new Error(`Provider account not found: ${service.providerAccountId}`);
    }
    const account = mapProviderAccountRow(accountResult.rows[0]);

    const [endpointsResult, externalEndpointsResult, verificationResult, reviewResult] = await Promise.all([
      this.pool.query(
        `
        SELECT * FROM provider_endpoint_drafts
        WHERE service_id = $1
        ORDER BY updated_at DESC
        `,
        [serviceId]
      ),
      this.pool.query(
        `
        SELECT * FROM provider_external_endpoint_drafts
        WHERE service_id = $1
        ORDER BY updated_at DESC
        `,
        [serviceId]
      ),
      this.pool.query(
        `
        SELECT * FROM provider_verifications
        WHERE service_id = $1
        ORDER BY created_at DESC
        LIMIT 1
        `,
        [serviceId]
      ),
      this.pool.query(
        `
        SELECT * FROM provider_reviews
        WHERE service_id = $1
        ORDER BY created_at DESC
        LIMIT 1
        `,
        [serviceId]
      )
    ]);

    return buildProviderServiceDetail({
      service,
      account,
      endpoints: [
        ...endpointsResult.rows.map(mapProviderEndpointDraftRow),
        ...externalEndpointsResult.rows.map(mapProviderExternalEndpointDraftRow)
      ],
      verification: verificationResult.rowCount ? mapProviderVerificationRow(verificationResult.rows[0]) : null,
      latestReview: reviewResult.rowCount ? mapProviderReviewRow(reviewResult.rows[0]) : null,
      latestPublishedVersionId:
        (serviceResult.rows[0].latest_published_version_id as string | null) ?? null
    });
  }
}

function mapIdempotencyRow(row: Record<string, unknown>): IdempotencyRecord {
  return {
    paymentId: row.payment_id as string,
    normalizedRequestHash: row.normalized_request_hash as string,
    buyerWallet: row.buyer_wallet as string,
    routeId: row.route_id as string,
    routeVersion: row.route_version as string,
    pendingRecoveryAction: (row.pending_recovery_action as IdempotencyRecord["pendingRecoveryAction"]) ?? "retry",
    quotedPrice: row.quoted_price as string,
    payoutSplit: normalizePersistedPayoutSplit(row.payout_split as IdempotencyRecord["payoutSplit"]),
    paymentPayload: row.payment_payload as string,
    facilitatorResponse: row.facilitator_response,
    responseKind: row.response_kind as "sync" | "job",
    responseStatusCode: row.response_status_code as number,
    responseBody: row.response_body,
    responseHeaders: (row.response_headers as Record<string, string>) ?? {},
    providerPayoutSourceKind: (row.provider_payout_source_kind as IdempotencyRecord["providerPayoutSourceKind"]) ?? null,
    executionStatus: (row.execution_status as IdempotencyRecord["executionStatus"]) ?? "completed",
    requestId: (row.request_id as string | null) ?? null,
    jobToken: (row.job_token as string | null) ?? undefined,
    createdAt: new Date(row.created_at as string | Date).toISOString(),
    updatedAt: new Date(row.updated_at as string | Date).toISOString()
  };
}

function mapProviderPayoutInputRow(row: Record<string, unknown>): ProviderPayoutInput {
  return {
    sourceKind: row.source_kind as ProviderPayoutInput["sourceKind"],
    sourceId: row.source_id as string,
    providerAccountId: row.provider_account_id as string,
    providerWallet: row.provider_wallet as string,
    currency: row.currency as ProviderPayoutInput["currency"],
    amount: row.amount as string
  };
}

function mapJobRow(row: Record<string, unknown>): JobRecord {
  return {
    jobToken: row.job_token as string,
    paymentId: (row.payment_id as string | null) ?? null,
    routeId: row.route_id as string,
    serviceId: (row.service_id as string | null) ?? null,
    provider: row.provider as string,
    operation: row.operation as string,
    buyerWallet: row.buyer_wallet as string,
    quotedPrice: row.quoted_price as string,
    payoutSplit: normalizePersistedPayoutSplit(row.payout_split as JobRecord["payoutSplit"]),
    requestId: row.request_id as string,
    providerJobId: (row.provider_job_id as string | null) ?? null,
    requestBody: row.request_body,
    routeSnapshot: row.route_snapshot as MarketplaceRoute,
    providerState: (row.provider_state as Record<string, unknown> | null) ?? null,
    nextPollAt: row.next_poll_at ? new Date(row.next_poll_at as string | Date).toISOString() : null,
    timeoutAt: row.timeout_at ? new Date(row.timeout_at as string | Date).toISOString() : null,
    status: row.status as JobRecord["status"],
    resultBody: row.result_body,
    errorMessage: (row.error_message as string | null) ?? null,
    refundStatus: row.refund_status as JobRecord["refundStatus"],
    refundId: (row.refund_id as string | null) ?? null,
    createdAt: new Date(row.created_at as string | Date).toISOString(),
    updatedAt: new Date(row.updated_at as string | Date).toISOString()
  };
}

function mapAttemptRow(row: Record<string, unknown>): ProviderAttemptRecord {
  return {
    id: row.id as string,
    jobToken: (row.job_token as string | null) ?? null,
    paymentId: (row.payment_id as string | null) ?? null,
    routeId: row.route_id as string,
    requestId: (row.request_id as string | null) ?? null,
    responseStatusCode: (row.response_status_code as number | null) ?? null,
    phase: row.phase as ProviderAttemptRecord["phase"],
    status: row.status as ProviderAttemptRecord["status"],
    requestPayload: row.request_payload,
    responsePayload: row.response_payload,
    errorMessage: (row.error_message as string | null) ?? null,
    createdAt: new Date(row.created_at as string | Date).toISOString()
  };
}

function mapAccessGrantRow(row: Record<string, unknown>): AccessGrantRecord {
  return {
    id: row.id as string,
    resourceType: row.resource_type as ResourceType,
    resourceId: row.resource_id as string,
    wallet: row.wallet as string,
    paymentId: row.payment_id as string,
    metadata: (row.metadata as Record<string, unknown>) ?? {},
    createdAt: new Date(row.created_at as string | Date).toISOString()
  };
}

function mapRefundRow(row: Record<string, unknown>): RefundRecord {
  return {
    id: row.id as string,
    jobToken: (row.job_token as string | null) ?? null,
    paymentId: row.payment_id as string,
    wallet: row.wallet as string,
    amount: row.amount as string,
    status: row.status as RefundRecord["status"],
    txHash: (row.tx_hash as string | null) ?? null,
    errorMessage: (row.error_message as string | null) ?? null,
    createdAt: new Date(row.created_at as string | Date).toISOString(),
    updatedAt: new Date(row.updated_at as string | Date).toISOString()
  };
}

function mapSuggestionRow(row: Record<string, unknown>): SuggestionRecord {
  return {
    id: row.id as string,
    type: row.type as SuggestionRecord["type"],
    serviceSlug: (row.service_slug as string | null) ?? null,
    title: row.title as string,
    description: row.description as string,
    sourceUrl: (row.source_url as string | null) ?? null,
    requesterName: (row.requester_name as string | null) ?? null,
    requesterEmail: (row.requester_email as string | null) ?? null,
    status: row.status as SuggestionRecord["status"],
    internalNotes: (row.internal_notes as string | null) ?? null,
    claimedByProviderAccountId: (row.claimed_provider_account_id as string | null) ?? null,
    claimedByProviderName: (row.claimed_provider_name as string | null) ?? null,
    claimedAt: row.claimed_at ? new Date(row.claimed_at as string | Date).toISOString() : null,
    createdAt: new Date(row.created_at as string | Date).toISOString(),
    updatedAt: new Date(row.updated_at as string | Date).toISOString()
  };
}

function mapProviderAccountRow(row: Record<string, unknown>): ProviderAccountRecord {
  return {
    id: row.id as string,
    ownerWallet: row.owner_wallet as string,
    displayName: row.display_name as string,
    bio: (row.bio as string | null) ?? null,
    websiteUrl: (row.website_url as string | null) ?? null,
    contactEmail: (row.contact_email as string | null) ?? null,
    createdAt: new Date(row.created_at as string | Date).toISOString(),
    updatedAt: new Date(row.updated_at as string | Date).toISOString()
  };
}

function mapProviderServiceRow(row: Record<string, unknown>): ProviderServiceRecord {
  return {
    id: row.id as string,
    providerAccountId: row.provider_account_id as string,
    serviceType: ((row.service_type as ProviderServiceType | null) ?? "marketplace_proxy"),
    settlementMode: row.settlement_mode
      ? normalizeSettlementMode(row.settlement_mode as SettlementMode | null | undefined, "verified_escrow")
      : null,
    slug: row.slug as string,
    apiNamespace: (row.api_namespace as string | null) ?? null,
    name: row.name as string,
    tagline: row.tagline as string,
    about: row.about as string,
    categories: (row.categories as string[]) ?? [],
    promptIntro: row.prompt_intro as string,
    setupInstructions: (row.setup_instructions as string[]) ?? [],
    websiteUrl: (row.website_url as string | null) ?? null,
    payoutWallet: (row.payout_wallet as string | null) ?? null,
    featured: Boolean(row.featured),
    status: row.status as ProviderServiceStatus,
    createdAt: new Date(row.created_at as string | Date).toISOString(),
    updatedAt: new Date(row.updated_at as string | Date).toISOString()
  };
}

function mapProviderEndpointDraftRow(row: Record<string, unknown>): MarketplaceProviderEndpointDraftRecord {
  const billing = normalizeRouteBilling(row.price as string, row.billing as MarketplaceProviderEndpointDraftRecord["billing"]);
  return {
    endpointType: "marketplace_proxy",
    id: row.id as string,
    serviceId: row.service_id as string,
    routeId: row.route_id as string,
    operation: row.operation as string,
    method: ((row.method as MarketplaceProviderEndpointDraftRecord["method"] | null) ?? "POST"),
    title: row.title as string,
    description: row.description as string,
    price: row.price as string,
    billing,
    mode: row.mode as MarketplaceProviderEndpointDraftRecord["mode"],
    asyncConfig: normalizeAsyncConfig(row.async_config),
    requestSchemaJson: row.request_schema_json as MarketplaceProviderEndpointDraftRecord["requestSchemaJson"],
    responseSchemaJson: row.response_schema_json as MarketplaceProviderEndpointDraftRecord["responseSchemaJson"],
    requestExample: row.request_example,
    responseExample: row.response_example,
    usageNotes: (row.usage_notes as string | null) ?? null,
    executorKind: row.executor_kind as MarketplaceProviderEndpointDraftRecord["executorKind"],
    upstreamBaseUrl: (row.upstream_base_url as string | null) ?? null,
    upstreamPath: (row.upstream_path as string | null) ?? null,
    upstreamAuthMode: (row.upstream_auth_mode as MarketplaceProviderEndpointDraftRecord["upstreamAuthMode"]) ?? null,
    upstreamAuthHeaderName: (row.upstream_auth_header_name as string | null) ?? null,
    upstreamSecretRef: (row.upstream_secret_ref as string | null) ?? null,
    hasUpstreamSecret: Boolean(row.upstream_secret_ref),
    payout: row.payout as MarketplaceProviderEndpointDraftRecord["payout"],
    createdAt: new Date(row.created_at as string | Date).toISOString(),
    updatedAt: new Date(row.updated_at as string | Date).toISOString()
  };
}

function mapProviderExternalEndpointDraftRow(row: Record<string, unknown>): ExternalProviderEndpointDraftRecord {
  return {
    endpointType: "external_registry",
    id: row.id as string,
    serviceId: row.service_id as string,
    routeId: null,
    operation: null,
    title: row.title as string,
    description: row.description as string,
    price: null,
    billing: null,
    mode: null,
    requestSchemaJson: null,
    responseSchemaJson: null,
    method: row.method as ExternalProviderEndpointDraftRecord["method"],
    publicUrl: row.public_url as string,
    docsUrl: row.docs_url as string,
    authNotes: (row.auth_notes as string | null) ?? null,
    requestExample: row.request_example,
    responseExample: row.response_example,
    usageNotes: (row.usage_notes as string | null) ?? null,
    executorKind: null,
    upstreamBaseUrl: null,
    upstreamPath: null,
    upstreamAuthMode: null,
    upstreamAuthHeaderName: null,
    upstreamSecretRef: null,
    hasUpstreamSecret: false,
    payout: null,
    createdAt: new Date(row.created_at as string | Date).toISOString(),
    updatedAt: new Date(row.updated_at as string | Date).toISOString()
  };
}

function mapProviderVerificationRow(row: Record<string, unknown>): ProviderVerificationRecord {
  return {
    id: row.id as string,
    serviceId: row.service_id as string,
    token: row.token as string,
    status: row.status as ProviderVerificationStatus,
    verifiedHost: (row.verified_host as string | null) ?? null,
    failureReason: (row.failure_reason as string | null) ?? null,
    createdAt: new Date(row.created_at as string | Date).toISOString(),
    updatedAt: new Date(row.updated_at as string | Date).toISOString()
  };
}

function mapProviderReviewRow(row: Record<string, unknown>): ProviderReviewRecord {
  return {
    id: row.id as string,
    serviceId: row.service_id as string,
    submittedVersionId: row.submitted_version_id as string,
    status: row.status as ProviderReviewRecord["status"],
    reviewNotes: (row.review_notes as string | null) ?? null,
    reviewerIdentity: (row.reviewer_identity as string | null) ?? null,
    createdAt: new Date(row.created_at as string | Date).toISOString(),
    updatedAt: new Date(row.updated_at as string | Date).toISOString()
  };
}

function mapPublishedServiceVersionRow(row: Record<string, unknown>): PublishedServiceVersionRecord {
  return {
    versionId: row.version_id as string,
    serviceId: row.service_id as string,
    providerAccountId: row.provider_account_id as string,
    serviceType: ((row.service_type as ProviderServiceType | null) ?? "marketplace_proxy"),
    settlementMode: row.settlement_mode
      ? normalizeSettlementMode(row.settlement_mode as SettlementMode | null | undefined)
      : null,
    slug: row.slug as string,
    apiNamespace: (row.api_namespace as string | null) ?? null,
    name: row.name as string,
    ownerName: row.owner_name as string,
    tagline: row.tagline as string,
    about: row.about as string,
    categories: (row.categories as string[]) ?? [],
    routeIds: (row.route_ids as string[]) ?? [],
    featured: Boolean(row.featured),
    promptIntro: row.prompt_intro as string,
    setupInstructions: (row.setup_instructions as string[]) ?? [],
    websiteUrl: (row.website_url as string | null) ?? null,
    contactEmail: (row.contact_email as string | null) ?? null,
    payoutWallet: (row.payout_wallet as string | null) ?? null,
    status: row.status as ProviderServiceStatus,
    submittedReviewId: (row.submitted_review_id as string | null) ?? null,
    publishedAt: new Date(row.published_at as string | Date).toISOString(),
    createdAt: new Date(row.created_at as string | Date).toISOString(),
    updatedAt: new Date(row.updated_at as string | Date).toISOString()
  };
}

function mapPublishedEndpointVersionRow(row: Record<string, unknown>): PublishedEndpointVersionRecord {
  const billing = normalizeRouteBilling(row.price as string, row.billing as PublishedEndpointVersionRecord["billing"]);
  return {
    endpointType: "marketplace_proxy",
    endpointVersionId: row.endpoint_version_id as string,
    serviceId: row.service_id as string,
    serviceVersionId: row.service_version_id as string,
    endpointDraftId: (row.endpoint_draft_id as string | null) ?? null,
    routeId: row.route_id as string,
    provider: row.provider as string,
    operation: row.operation as string,
    version: row.version as string,
    method: ((row.method as PublishedEndpointVersionRecord["method"] | null) ?? "POST"),
    settlementMode: normalizeSettlementMode(row.settlement_mode as SettlementMode | null | undefined),
    mode: row.mode as PublishedEndpointVersionRecord["mode"],
    network: row.network as PublishedEndpointVersionRecord["network"],
    price: row.price as string,
    billing,
    asyncConfig: normalizeAsyncConfig(row.async_config),
    title: row.title as string,
    description: row.description as string,
    payout: row.payout as PublishedEndpointVersionRecord["payout"],
    requestExample: row.request_example,
    responseExample: row.response_example,
    usageNotes: (row.usage_notes as string | null) ?? undefined,
    requestSchemaJson: row.request_schema_json as PublishedEndpointVersionRecord["requestSchemaJson"],
    responseSchemaJson: row.response_schema_json as PublishedEndpointVersionRecord["responseSchemaJson"],
    executorKind: row.executor_kind as PublishedEndpointVersionRecord["executorKind"],
    upstreamBaseUrl: (row.upstream_base_url as string | null) ?? null,
    upstreamPath: (row.upstream_path as string | null) ?? null,
    upstreamAuthMode: (row.upstream_auth_mode as PublishedEndpointVersionRecord["upstreamAuthMode"]) ?? null,
    upstreamAuthHeaderName: (row.upstream_auth_header_name as string | null) ?? null,
    upstreamSecretRef: (row.upstream_secret_ref as string | null) ?? null,
    createdAt: new Date(row.created_at as string | Date).toISOString(),
    updatedAt: new Date(row.updated_at as string | Date).toISOString()
  };
}

function mapPublishedExternalEndpointVersionRow(row: Record<string, unknown>): PublishedExternalEndpointVersionRecord {
  return {
    endpointType: "external_registry",
    endpointVersionId: row.endpoint_version_id as string,
    serviceId: row.service_id as string,
    serviceVersionId: row.service_version_id as string,
    endpointDraftId: (row.endpoint_draft_id as string | null) ?? null,
    routeId: null,
    provider: null,
    operation: null,
    version: null,
    settlementMode: null,
    mode: null,
    network: null,
    price: null,
    billing: null,
    title: row.title as string,
    description: row.description as string,
    payout: null,
    method: row.method as PublishedExternalEndpointVersionRecord["method"],
    publicUrl: row.public_url as string,
    docsUrl: row.docs_url as string,
    authNotes: (row.auth_notes as string | null) ?? null,
    requestExample: row.request_example,
    responseExample: row.response_example,
    usageNotes: (row.usage_notes as string | null) ?? undefined,
    requestSchemaJson: null,
    responseSchemaJson: null,
    executorKind: null,
    upstreamBaseUrl: null,
    upstreamPath: null,
    upstreamAuthMode: null,
    upstreamAuthHeaderName: null,
    upstreamSecretRef: null,
    createdAt: new Date(row.created_at as string | Date).toISOString(),
    updatedAt: new Date(row.updated_at as string | Date).toISOString()
  };
}

function mapProviderSecretRow(row: Record<string, unknown>): ProviderSecretRecord {
  return {
    id: row.id as string,
    providerAccountId: row.provider_account_id as string,
    label: row.label as string,
    secretCiphertext: row.secret_ciphertext as string,
    iv: row.iv as string,
    authTag: row.auth_tag as string,
    createdAt: new Date(row.created_at as string | Date).toISOString(),
    updatedAt: new Date(row.updated_at as string | Date).toISOString()
  };
}

function mapProviderPayoutRow(row: Record<string, unknown>): ProviderPayoutRecord {
  return {
    id: row.id as string,
    sourceKind: row.source_kind as ProviderPayoutRecord["sourceKind"],
    sourceId: row.source_id as string,
    providerAccountId: row.provider_account_id as string,
    providerWallet: row.provider_wallet as string,
    currency: row.currency as ProviderPayoutRecord["currency"],
    amount: row.amount as string,
    status: row.status as ProviderPayoutRecord["status"],
    txHash: (row.tx_hash as string | null) ?? null,
    sentAt: row.sent_at ? new Date(row.sent_at as string | Date).toISOString() : null,
    attemptCount: Number(row.attempt_count),
    lastError: (row.last_error as string | null) ?? null,
    createdAt: new Date(row.created_at as string | Date).toISOString(),
    updatedAt: new Date(row.updated_at as string | Date).toISOString()
  };
}

function mapCreditAccountRow(row: Record<string, unknown>): CreditAccountRecord {
  return {
    id: row.id as string,
    serviceId: row.service_id as string,
    buyerWallet: row.buyer_wallet as string,
    currency: row.currency as CreditAccountRecord["currency"],
    availableAmount: row.available_amount as string,
    reservedAmount: row.reserved_amount as string,
    createdAt: new Date(row.created_at as string | Date).toISOString(),
    updatedAt: new Date(row.updated_at as string | Date).toISOString()
  };
}

function mapCreditLedgerEntryRow(row: Record<string, unknown>): CreditLedgerEntryRecord {
  return {
    id: row.id as string,
    accountId: row.account_id as string,
    serviceId: row.service_id as string,
    buyerWallet: row.buyer_wallet as string,
    currency: row.currency as CreditLedgerEntryRecord["currency"],
    kind: row.kind as CreditLedgerEntryRecord["kind"],
    amount: row.amount as string,
    reservationId: (row.reservation_id as string | null) ?? null,
    paymentId: (row.payment_id as string | null) ?? null,
    metadata: (row.metadata as Record<string, unknown>) ?? {},
    createdAt: new Date(row.created_at as string | Date).toISOString()
  };
}

function mapCreditReservationRow(row: Record<string, unknown>): CreditReservationRecord {
  return {
    id: row.id as string,
    accountId: row.account_id as string,
    serviceId: row.service_id as string,
    buyerWallet: row.buyer_wallet as string,
    currency: row.currency as CreditReservationRecord["currency"],
    idempotencyKey: row.idempotency_key as string,
    jobToken: (row.job_token as string | null) ?? null,
    requestId: (row.request_id as string | null) ?? null,
    paymentId: (row.payment_id as string | null) ?? null,
    providerReference: (row.provider_reference as string | null) ?? null,
    status: row.status as CreditReservationRecord["status"],
    reservedAmount: row.reserved_amount as string,
    capturedAmount: row.captured_amount as string,
    expiresAt: new Date(row.expires_at as string | Date).toISOString(),
    createdAt: new Date(row.created_at as string | Date).toISOString(),
    updatedAt: new Date(row.updated_at as string | Date).toISOString()
  };
}

function mapProviderRuntimeKeyRow(row: Record<string, unknown>): ProviderRuntimeKeyRecord {
  return {
    id: row.id as string,
    serviceId: row.service_id as string,
    keyPrefix: row.key_prefix as string,
    keyHash: row.key_hash as string,
    secretCiphertext: row.secret_ciphertext as string,
    iv: row.iv as string,
    authTag: row.auth_tag as string,
    createdAt: new Date(row.created_at as string | Date).toISOString(),
    updatedAt: new Date(row.updated_at as string | Date).toISOString()
  };
}
