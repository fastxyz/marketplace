import { randomUUID } from "node:crypto";

import { Pool } from "pg";

import { getDefaultMarketplaceNetworkConfig } from "./network.js";
import {
  MARKETPLACE_PROVIDER_SERVICE_SEEDS,
  MARKETPLACE_PROVIDER_ACCOUNT_SEED,
  buildSeededProviderEndpointDrafts,
  buildSeededPublishedEndpointVersions,
  buildSeededPublishedServiceVersions
} from "./seed.js";
import type {
  AccessGrantRecord,
  CreateProviderEndpointDraftInput,
  CreateProviderServiceInput,
  CreateSuggestionInput,
  IdempotencyRecord,
  JobRecord,
  MarketplaceRoute,
  MarketplaceStore,
  ProviderAccountRecord,
  ProviderAttemptRecord,
  ProviderEndpointDraftRecord,
  ProviderReviewRecord,
  ProviderSecretRecord,
  ProviderServiceDetailRecord,
  ProviderServiceRecord,
  ProviderServiceStatus,
  ProviderVerificationRecord,
  ProviderVerificationStatus,
  PublishedEndpointVersionRecord,
  PublishedServiceVersionRecord,
  ResourceType,
  RefundRecord,
  SaveAsyncAcceptanceInput,
  SaveSyncIdempotencyInput,
  ServiceAnalytics,
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

function buildRouteId(apiNamespace: string, operation: string): string {
  return `${apiNamespace}.${operation}.v1`;
}

function sortByUpdatedDesc<T extends { updatedAt: string }>(records: T[]): T[] {
  return [...records].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

function latestByCreatedAt<T extends { createdAt: string }>(records: T[]): T | null {
  return (
    [...records].sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0] ?? null
  );
}

function isSameOrSubdomain(input: { rootHost: string; candidateHost: string }): boolean {
  const root = input.rootHost.toLowerCase();
  const candidate = input.candidateHost.toLowerCase();

  return candidate === root || candidate.endsWith(`.${root}`);
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

function computeServiceAnalytics(input: {
  routeIds: string[];
  idempotencyRecords: IdempotencyRecord[];
  jobs: JobRecord[];
}): ServiceAnalytics {
  const routeIds = new Set(input.routeIds);
  const acceptedCalls = input.idempotencyRecords.filter((record) => {
    if (!routeIds.has(record.routeId)) {
      return false;
    }

    if (record.responseKind === "job") {
      return true;
    }

    return record.responseStatusCode >= 200 && record.responseStatusCode < 400;
  });
  const jobs = input.jobs.filter((job) => routeIds.has(job.routeId));
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

  return {
    totalCalls: acceptedCalls.length,
    revenueRaw: revenueRaw.toString(),
    successRate30d: resolvedCalls30d === 0 ? 0 : (successfulCalls30d / resolvedCalls30d) * 100,
    volume30d: Array.from(volumeMap.entries()).map(([date, amountRaw]) => ({
      date,
      amountRaw: amountRaw.toString()
    }))
  };
}

export class InMemoryMarketplaceStore implements MarketplaceStore {
  private readonly idempotencyByPaymentId = new Map<string, IdempotencyRecord>();
  private readonly jobsByToken = new Map<string, JobRecord>();
  private readonly accessGrants = new Map<string, AccessGrantRecord>();
  private readonly refundsById = new Map<string, RefundRecord>();
  private readonly refundsByJobToken = new Map<string, RefundRecord>();
  private readonly refundsByPaymentId = new Map<string, RefundRecord>();
  private readonly suggestionsById = new Map<string, SuggestionRecord>();
  private readonly attempts: ProviderAttemptRecord[] = [];

  private readonly providerAccountsById = new Map<string, ProviderAccountRecord>();
  private readonly providerAccountIdByWallet = new Map<string, string>();
  private readonly providerServicesById = new Map<string, ProviderServiceRecord>();
  private readonly endpointDraftsById = new Map<string, ProviderEndpointDraftRecord>();
  private readonly verificationByService = new Map<string, ProviderVerificationRecord[]>();
  private readonly reviewsByService = new Map<string, ProviderReviewRecord[]>();
  private readonly providerSecretsById = new Map<string, ProviderSecretRecord>();
  private readonly publishedServicesByVersionId = new Map<string, PublishedServiceVersionRecord>();
  private readonly publishedEndpointsByVersionId = new Map<string, PublishedEndpointVersionRecord>();
  private readonly latestSubmittedVersionByServiceId = new Map<string, string>();
  private readonly latestPublishedVersionByServiceId = new Map<string, string>();

  constructor() {
    this.seedDefaults();
  }

  async ensureSchema(): Promise<void> {
    this.seedDefaults();
  }

  private seedDefaults() {
    const network = getDefaultMarketplaceNetworkConfig();
    const account = clone(MARKETPLACE_PROVIDER_ACCOUNT_SEED);
    const services = MARKETPLACE_PROVIDER_SERVICE_SEEDS.map((service) => clone(service));
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
      this.endpointDraftsById.set(endpoint.id, endpoint);
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

  async saveSyncIdempotency(input: SaveSyncIdempotencyInput): Promise<IdempotencyRecord> {
    const now = timestamp();
    const record: IdempotencyRecord = {
      paymentId: input.paymentId,
      normalizedRequestHash: input.normalizedRequestHash,
      buyerWallet: input.buyerWallet,
      routeId: input.routeId,
      routeVersion: input.routeVersion,
      quotedPrice: input.quotedPrice,
      payoutSplit: clone(input.payoutSplit),
      paymentPayload: input.paymentPayload,
      facilitatorResponse: clone(input.facilitatorResponse),
      responseKind: "sync",
      responseStatusCode: input.statusCode,
      responseBody: clone(input.body),
      responseHeaders: clone(input.headers ?? {}),
      createdAt: now,
      updatedAt: now
    };

    this.idempotencyByPaymentId.set(record.paymentId, record);
    return clone(record);
  }

  async saveAsyncAcceptance(input: SaveAsyncAcceptanceInput): Promise<{ idempotency: IdempotencyRecord; job: JobRecord }> {
    const now = timestamp();
    const idempotency: IdempotencyRecord = {
      paymentId: input.paymentId,
      normalizedRequestHash: input.normalizedRequestHash,
      buyerWallet: input.buyerWallet,
      routeId: input.route.routeId,
      routeVersion: input.route.version,
      quotedPrice: input.quotedPrice,
      payoutSplit: clone(input.payoutSplit),
      paymentPayload: input.paymentPayload,
      facilitatorResponse: clone(input.facilitatorResponse),
      responseKind: "job",
      responseStatusCode: 202,
      responseBody: clone(input.responseBody),
      responseHeaders: clone(input.responseHeaders ?? {}),
      jobToken: input.jobToken,
      createdAt: now,
      updatedAt: now
    };

    const job: JobRecord = {
      jobToken: input.jobToken,
      paymentId: input.paymentId,
      routeId: input.route.routeId,
      provider: input.route.provider,
      operation: input.route.operation,
      buyerWallet: input.buyerWallet,
      quotedPrice: input.quotedPrice,
      payoutSplit: clone(input.payoutSplit),
      providerJobId: input.providerJobId,
      requestBody: clone(input.requestBody),
      routeSnapshot: clone(input.route),
      providerState: clone(input.providerState ?? null),
      status: "pending",
      resultBody: null,
      errorMessage: null,
      refundStatus: "not_required",
      refundId: null,
      createdAt: now,
      updatedAt: now
    };

    this.idempotencyByPaymentId.set(idempotency.paymentId, idempotency);
    this.jobsByToken.set(job.jobToken, job);

    return {
      idempotency: clone(idempotency),
      job: clone(job)
    };
  }

  async getJob(jobToken: string): Promise<JobRecord | null> {
    return clone(this.jobsByToken.get(jobToken) ?? null);
  }

  async listPendingJobs(limit: number): Promise<JobRecord[]> {
    return clone(
      Array.from(this.jobsByToken.values())
        .filter((job) => job.status === "pending")
        .slice(0, limit)
    );
  }

  async updateJobPending(jobToken: string, providerState?: Record<string, unknown>): Promise<JobRecord> {
    const existing = this.jobsByToken.get(jobToken);
    if (!existing) {
      throw new Error(`Job not found: ${jobToken}`);
    }

    const updated: JobRecord = {
      ...existing,
      providerState: clone(providerState ?? existing.providerState),
      updatedAt: timestamp()
    };

    this.jobsByToken.set(jobToken, updated);
    return clone(updated);
  }

  async completeJob(jobToken: string, body: unknown): Promise<JobRecord> {
    const existing = this.jobsByToken.get(jobToken);
    if (!existing) {
      throw new Error(`Job not found: ${jobToken}`);
    }

    const updated: JobRecord = {
      ...existing,
      status: "completed",
      resultBody: clone(body),
      errorMessage: null,
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

    const updated: JobRecord = {
      ...existing,
      status: "failed",
      errorMessage: error,
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
    jobToken: string;
    phase: "execute" | "poll" | "refund";
    status: "succeeded" | "failed";
    requestPayload?: unknown;
    responsePayload?: unknown;
    errorMessage?: string;
  }): Promise<ProviderAttemptRecord> {
    const record: ProviderAttemptRecord = {
      id: randomUUID(),
      jobToken: input.jobToken,
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

  async createRefund(input: {
    jobToken?: string | null;
    paymentId: string;
    wallet: string;
    amount: string;
  }): Promise<RefundRecord> {
    const existing = this.refundsByPaymentId.get(input.paymentId)
      ?? (input.jobToken ? this.refundsByJobToken.get(input.jobToken) : undefined);
    if (existing) {
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

  async getServiceAnalytics(routeIds: string[]): Promise<ServiceAnalytics> {
    return computeServiceAnalytics({
      routeIds,
      idempotencyRecords: Array.from(this.idempotencyByPaymentId.values()),
      jobs: Array.from(this.jobsByToken.values())
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
    endpoints: PublishedEndpointVersionRecord[];
  } | null> {
    const service = Array.from(this.providerServicesById.values()).find(
      (record) => record.slug === slug && record.status === "published"
    );
    if (!service) {
      return null;
    }

    const versionId = this.latestPublishedVersionByServiceId.get(service.id);
    if (!versionId) {
      return null;
    }

    const version = this.publishedServicesByVersionId.get(versionId);
    if (!version) {
      return null;
    }

    const endpoints = Array.from(this.publishedEndpointsByVersionId.values()).filter(
      (endpoint) => endpoint.serviceVersionId === versionId
    );

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

    this.assertServiceUniqueness(input.slug, input.apiNamespace);

    const record: ProviderServiceRecord = {
      id: randomUUID(),
      providerAccountId: account.id,
      slug: input.slug,
      apiNamespace: input.apiNamespace,
      name: input.name,
      tagline: input.tagline,
      about: input.about,
      categories: clone(input.categories),
      promptIntro: input.promptIntro,
      setupInstructions: clone(input.setupInstructions),
      websiteUrl: input.websiteUrl ?? account.websiteUrl ?? null,
      payoutWallet: input.payoutWallet,
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

    const updated: ProviderServiceRecord = {
      ...detail.service,
      slug: input.slug ?? detail.service.slug,
      apiNamespace: input.apiNamespace ?? detail.service.apiNamespace,
      name: input.name ?? detail.service.name,
      tagline: input.tagline ?? detail.service.tagline,
      about: input.about ?? detail.service.about,
      categories: input.categories ? clone(input.categories) : detail.service.categories,
      promptIntro: input.promptIntro ?? detail.service.promptIntro,
      setupInstructions: input.setupInstructions ? clone(input.setupInstructions) : detail.service.setupInstructions,
      websiteUrl: input.websiteUrl === undefined ? detail.service.websiteUrl : input.websiteUrl,
      payoutWallet: input.payoutWallet === undefined ? detail.service.payoutWallet : input.payoutWallet,
      featured: input.featured ?? detail.service.featured,
      updatedAt: timestamp()
    };

    this.assertServiceUniqueness(updated.slug, updated.apiNamespace, updated.id);
    this.providerServicesById.set(updated.id, updated);
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

    if (detail.endpoints.some((endpoint) => endpoint.operation === input.operation)) {
      throw new Error(`Operation already exists: ${input.operation}`);
    }

    const secretRef = secretMaterial
      ? this.createProviderSecretRecord(detail.account.id, secretMaterial).id
      : null;

    const record: ProviderEndpointDraftRecord = {
      id: randomUUID(),
      serviceId,
      routeId: buildRouteId(detail.service.apiNamespace, input.operation),
      operation: input.operation,
      title: input.title,
      description: input.description,
      price: input.price,
      mode: input.mode,
      requestSchemaJson: clone(input.requestSchemaJson),
      responseSchemaJson: clone(input.responseSchemaJson),
      requestExample: clone(input.requestExample),
      responseExample: clone(input.responseExample),
      usageNotes: input.usageNotes ?? null,
      executorKind: "http",
      upstreamBaseUrl: input.upstreamBaseUrl,
      upstreamPath: input.upstreamPath,
      upstreamAuthMode: input.upstreamAuthMode,
      upstreamAuthHeaderName: input.upstreamAuthHeaderName ?? null,
      upstreamSecretRef: secretRef,
      hasUpstreamSecret: Boolean(secretRef),
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

    const existing = this.endpointDraftsById.get(endpointId);
    if (!existing || existing.serviceId !== serviceId) {
      return null;
    }

    const nextOperation = input.operation ?? existing.operation;
    if (
      nextOperation !== existing.operation &&
      detail.endpoints.some((endpoint) => endpoint.id !== endpointId && endpoint.operation === nextOperation)
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

    const updated: ProviderEndpointDraftRecord = {
      ...existing,
      routeId: buildRouteId(detail.service.apiNamespace, nextOperation),
      operation: nextOperation,
      title: input.title ?? existing.title,
      description: input.description ?? existing.description,
      price: input.price ?? existing.price,
      requestSchemaJson: input.requestSchemaJson ? clone(input.requestSchemaJson) : existing.requestSchemaJson,
      responseSchemaJson: input.responseSchemaJson ? clone(input.responseSchemaJson) : existing.responseSchemaJson,
      requestExample: input.requestExample === undefined ? existing.requestExample : clone(input.requestExample),
      responseExample: input.responseExample === undefined ? existing.responseExample : clone(input.responseExample),
      usageNotes: input.usageNotes === undefined ? existing.usageNotes : input.usageNotes,
      upstreamBaseUrl: input.upstreamBaseUrl ?? existing.upstreamBaseUrl,
      upstreamPath: input.upstreamPath ?? existing.upstreamPath,
      upstreamAuthMode: input.upstreamAuthMode ?? existing.upstreamAuthMode,
      upstreamAuthHeaderName:
        input.upstreamAuthHeaderName === undefined
          ? existing.upstreamAuthHeaderName
          : input.upstreamAuthHeaderName,
      upstreamSecretRef: secretRef,
      hasUpstreamSecret: Boolean(secretRef),
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

    const existing = this.endpointDraftsById.get(endpointId);
    if (!existing || existing.serviceId !== serviceId) {
      return false;
    }

    this.endpointDraftsById.delete(endpointId);
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
      slug: detail.service.slug,
      apiNamespace: detail.service.apiNamespace,
      name: detail.service.name,
      ownerName: detail.account.displayName,
      tagline: detail.service.tagline,
      about: detail.service.about,
      categories: clone(detail.service.categories),
      routeIds: detail.endpoints.map((endpoint) => endpoint.routeId),
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

    const network = getDefaultMarketplaceNetworkConfig();
    const publishedEndpoints = detail.endpoints.map<PublishedEndpointVersionRecord>((endpoint) => ({
      endpointVersionId: randomUUID(),
      serviceId,
      serviceVersionId,
      endpointDraftId: endpoint.id,
      routeId: endpoint.routeId,
      provider: detail.service.apiNamespace,
      operation: endpoint.operation,
      version: versionTag,
      mode: endpoint.mode,
      network: network.paymentNetwork,
      price: endpoint.price,
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
    input?: { reviewerIdentity?: string | null }
  ): Promise<ProviderServiceDetailRecord | null> {
    const service = this.providerServicesById.get(serviceId);
    const latestReview = latestByCreatedAt(this.reviewsByService.get(serviceId) ?? []);
    if (!service || !latestReview) {
      return null;
    }

    const version = this.publishedServicesByVersionId.get(latestReview.submittedVersionId);
    if (!version) {
      return null;
    }

    this.latestPublishedVersionByServiceId.set(serviceId, version.versionId);
    this.providerServicesById.set(serviceId, {
      ...service,
      status: "published",
      updatedAt: timestamp()
    });
    this.publishedServicesByVersionId.set(version.versionId, {
      ...version,
      status: "published",
      publishedAt: timestamp(),
      updatedAt: timestamp()
    });
    this.reviewsByService.set(
      serviceId,
      (this.reviewsByService.get(serviceId) ?? []).map((record) =>
        record.id === latestReview.id
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

  private assertServiceUniqueness(slug: string, apiNamespace: string, serviceId?: string) {
    for (const service of this.providerServicesById.values()) {
      if (service.id === serviceId) {
        continue;
      }

      if (service.slug === slug) {
        throw new Error(`Service slug already exists: ${slug}`);
      }

      if (service.apiNamespace === apiNamespace) {
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

    const endpoints = Array.from(this.endpointDraftsById.values()).filter((endpoint) => endpoint.serviceId === serviceId);
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
  constructor(private readonly pool: Pool) {}

  async ensureSchema(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS idempotency_records (
        payment_id TEXT PRIMARY KEY,
        normalized_request_hash TEXT NOT NULL,
        buyer_wallet TEXT NOT NULL,
        route_id TEXT NOT NULL,
        route_version TEXT NOT NULL,
        quoted_price TEXT NOT NULL,
        payout_split JSONB NOT NULL DEFAULT '{}'::jsonb,
        payment_payload TEXT NOT NULL,
        facilitator_response JSONB NOT NULL,
        response_kind TEXT NOT NULL,
        response_status_code INTEGER NOT NULL,
        response_body JSONB NOT NULL,
        response_headers JSONB NOT NULL DEFAULT '{}'::jsonb,
        job_token TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS jobs (
        job_token TEXT PRIMARY KEY,
        payment_id TEXT NOT NULL REFERENCES idempotency_records(payment_id),
        route_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        operation TEXT NOT NULL,
        buyer_wallet TEXT NOT NULL,
        quoted_price TEXT NOT NULL,
        payout_split JSONB NOT NULL DEFAULT '{}'::jsonb,
        provider_job_id TEXT NOT NULL,
        request_body JSONB NOT NULL,
        route_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
        provider_state JSONB,
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
        job_token TEXT NOT NULL REFERENCES jobs(job_token),
        phase TEXT NOT NULL,
        status TEXT NOT NULL,
        request_payload JSONB,
        response_payload JSONB,
        error_message TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

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
        slug TEXT NOT NULL UNIQUE,
        api_namespace TEXT NOT NULL UNIQUE,
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
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        price TEXT NOT NULL,
        mode TEXT NOT NULL,
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
        slug TEXT NOT NULL,
        api_namespace TEXT NOT NULL,
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
        mode TEXT NOT NULL,
        network TEXT NOT NULL,
        price TEXT NOT NULL,
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

      ALTER TABLE jobs
      ADD COLUMN IF NOT EXISTS route_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb;

      ALTER TABLE service_suggestions
      ADD COLUMN IF NOT EXISTS claimed_provider_account_id TEXT;

      ALTER TABLE service_suggestions
      ADD COLUMN IF NOT EXISTS claimed_provider_name TEXT;

      ALTER TABLE service_suggestions
      ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ;

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
      ["provider_services", "slug"],
      ["provider_services", "api_namespace"],
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
      ["provider_verifications", "token"],
      ["provider_verifications", "status"],
      ["provider_verifications", "verified_host"],
      ["provider_verifications", "failure_reason"],
      ["provider_reviews", "status"],
      ["provider_reviews", "review_notes"],
      ["provider_reviews", "reviewer_identity"],
      ["published_service_versions", "slug"],
      ["published_service_versions", "api_namespace"],
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
    const network = getDefaultMarketplaceNetworkConfig();
    const account = MARKETPLACE_PROVIDER_ACCOUNT_SEED;
    const services = MARKETPLACE_PROVIDER_SERVICE_SEEDS;
    const draftEndpoints = buildSeededProviderEndpointDrafts(network);
    const publishedServices = buildSeededPublishedServiceVersions(network);
    const publishedEndpoints = buildSeededPublishedEndpointVersions(network);
    const publishedServiceByServiceId = new Map(publishedServices.map((service) => [service.serviceId, service]));

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
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
            id, provider_account_id, slug, api_namespace, name, tagline, about, categories, prompt_intro,
            setup_instructions, website_url, payout_wallet, featured, status, latest_submitted_version_id,
            latest_published_version_id, latest_review_id, created_at, updated_at
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10::jsonb, $11, $12, $13, $14, $15, $16, NULL, $17, $18
          )
          ON CONFLICT (id) DO UPDATE SET
            provider_account_id = EXCLUDED.provider_account_id,
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

      for (const endpoint of draftEndpoints) {
        await client.query(
          `
          INSERT INTO provider_endpoint_drafts (
            id, service_id, route_id, operation, title, description, price, mode, request_schema_json, response_schema_json,
            request_example, response_example, usage_notes, executor_kind, upstream_base_url, upstream_path,
            upstream_auth_mode, upstream_auth_header_name, upstream_secret_ref, payout, created_at, updated_at
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11::jsonb, $12::jsonb, $13, $14, $15, $16,
            $17, $18, $19, $20::jsonb, $21, $22
          )
          ON CONFLICT (id) DO UPDATE SET
            route_id = EXCLUDED.route_id,
            operation = EXCLUDED.operation,
            title = EXCLUDED.title,
            description = EXCLUDED.description,
            price = EXCLUDED.price,
            mode = EXCLUDED.mode,
            request_schema_json = EXCLUDED.request_schema_json,
            response_schema_json = EXCLUDED.response_schema_json,
            request_example = EXCLUDED.request_example,
            response_example = EXCLUDED.response_example,
            usage_notes = EXCLUDED.usage_notes,
            executor_kind = EXCLUDED.executor_kind,
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
            endpoint.title,
            endpoint.description,
            endpoint.price,
            endpoint.mode,
            JSON.stringify(endpoint.requestSchemaJson),
            JSON.stringify(endpoint.responseSchemaJson),
            JSON.stringify(endpoint.requestExample),
            JSON.stringify(endpoint.responseExample),
            endpoint.usageNotes,
            endpoint.executorKind,
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
            version_id, service_id, provider_account_id, slug, api_namespace, name, owner_name, tagline, about,
            categories, route_ids, featured, prompt_intro, setup_instructions, website_url, contact_email,
            payout_wallet, status, submitted_review_id, published_at, created_at, updated_at
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb, $12, $13, $14::jsonb, $15, $16,
            $17, $18, $19, $20, $21, $22
          )
          ON CONFLICT (version_id) DO UPDATE SET
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
            version, mode, network, price, title, description, payout, request_example, response_example, usage_notes,
            request_schema_json, response_schema_json, executor_kind, upstream_base_url, upstream_path, upstream_auth_mode,
            upstream_auth_header_name, upstream_secret_ref, created_at, updated_at
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, $15::jsonb, $16::jsonb, $17,
            $18::jsonb, $19::jsonb, $20, $21, $22, $23, $24, $25, $26, $27
          )
          ON CONFLICT (endpoint_version_id) DO UPDATE SET
            route_id = EXCLUDED.route_id,
            provider = EXCLUDED.provider,
            operation = EXCLUDED.operation,
            version = EXCLUDED.version,
            mode = EXCLUDED.mode,
            network = EXCLUDED.network,
            price = EXCLUDED.price,
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
            endpoint.mode,
            endpoint.network,
            endpoint.price,
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

  async saveSyncIdempotency(input: SaveSyncIdempotencyInput): Promise<IdempotencyRecord> {
    const result = await this.pool.query(
      `
      INSERT INTO idempotency_records (
        payment_id, normalized_request_hash, buyer_wallet, route_id, route_version,
        quoted_price, payout_split, payment_payload, facilitator_response, response_kind,
        response_status_code, response_body, response_headers
      ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9::jsonb, 'sync', $10, $11::jsonb, $12::jsonb)
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
        JSON.stringify(input.headers ?? {})
      ]
    );

    return mapIdempotencyRow(result.rows[0]);
  }

  async saveAsyncAcceptance(input: SaveAsyncAcceptanceInput): Promise<{ idempotency: IdempotencyRecord; job: JobRecord }> {
    const client = await this.pool.connect();

    try {
      await client.query("BEGIN");
      const idempotencyResult = await client.query(
        `
        INSERT INTO idempotency_records (
          payment_id, normalized_request_hash, buyer_wallet, route_id, route_version,
          quoted_price, payout_split, payment_payload, facilitator_response, response_kind,
          response_status_code, response_body, response_headers, job_token
        ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9::jsonb, 'job', 202, $10::jsonb, $11::jsonb, $12)
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
          input.jobToken
        ]
      );

      const jobResult = await client.query(
        `
        INSERT INTO jobs (
          job_token, payment_id, route_id, provider, operation, buyer_wallet, quoted_price,
          payout_split, provider_job_id, request_body, route_snapshot, provider_state, status, result_body, error_message,
          refund_status, refund_id
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10::jsonb, $11::jsonb, $12::jsonb, 'pending', NULL, NULL, 'not_required', NULL)
        RETURNING *
        `,
        [
          input.jobToken,
          input.paymentId,
          input.route.routeId,
          input.route.provider,
          input.route.operation,
          input.buyerWallet,
          input.quotedPrice,
          JSON.stringify(input.payoutSplit),
          input.providerJobId,
          JSON.stringify(input.requestBody),
          JSON.stringify(input.route),
          JSON.stringify(input.providerState ?? null)
        ]
      );

      await client.query("COMMIT");
      return {
        idempotency: mapIdempotencyRow(idempotencyResult.rows[0]),
        job: mapJobRow(jobResult.rows[0])
      };
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

  async listPendingJobs(limit: number): Promise<JobRecord[]> {
    const result = await this.pool.query(
      "SELECT * FROM jobs WHERE status = 'pending' ORDER BY created_at ASC LIMIT $1",
      [limit]
    );
    return result.rows.map(mapJobRow);
  }

  async updateJobPending(jobToken: string, providerState?: Record<string, unknown>): Promise<JobRecord> {
    const result = await this.pool.query(
      `
      UPDATE jobs
      SET provider_state = $2::jsonb, updated_at = NOW()
      WHERE job_token = $1
      RETURNING *
      `,
      [jobToken, JSON.stringify(providerState ?? null)]
    );

    return mapJobRow(result.rows[0]);
  }

  async completeJob(jobToken: string, body: unknown): Promise<JobRecord> {
    const result = await this.pool.query(
      `
      UPDATE jobs
      SET status = 'completed', result_body = $2::jsonb, error_message = NULL, updated_at = NOW()
      WHERE job_token = $1
      RETURNING *
      `,
      [jobToken, JSON.stringify(body)]
    );

    return mapJobRow(result.rows[0]);
  }

  async failJob(jobToken: string, error: string): Promise<JobRecord> {
    const result = await this.pool.query(
      `
      UPDATE jobs
      SET status = 'failed', error_message = $2, updated_at = NOW()
      WHERE job_token = $1
      RETURNING *
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
    jobToken: string;
    phase: "execute" | "poll" | "refund";
    status: "succeeded" | "failed";
    requestPayload?: unknown;
    responsePayload?: unknown;
    errorMessage?: string;
  }): Promise<ProviderAttemptRecord> {
    const result = await this.pool.query(
      `
      INSERT INTO provider_attempts (id, job_token, phase, status, request_payload, response_payload, error_message)
      VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7)
      RETURNING *
      `,
      [
        randomUUID(),
        input.jobToken,
        input.phase,
        input.status,
        JSON.stringify(input.requestPayload ?? null),
        JSON.stringify(input.responsePayload ?? null),
        input.errorMessage ?? null
      ]
    );

    return mapAttemptRow(result.rows[0]);
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
      return mapRefundRow(existingResult.rows[0]);
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

  async getServiceAnalytics(routeIds: string[]): Promise<ServiceAnalytics> {
    const [idempotencyResult, jobsResult] = await Promise.all([
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
      )
    ]);

    return computeServiceAnalytics({
      routeIds,
      idempotencyRecords: idempotencyResult.rows.map(mapIdempotencyRow),
      jobs: jobsResult.rows.map(mapJobRow)
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

  async getPublishedServiceBySlug(slug: string): Promise<{ service: PublishedServiceVersionRecord; endpoints: PublishedEndpointVersionRecord[] } | null> {
    const serviceResult = await this.pool.query(
      `
      SELECT v.*
      FROM provider_services s
      JOIN published_service_versions v
        ON v.version_id = s.latest_published_version_id
      WHERE s.slug = $1 AND s.status = 'published'
      `,
      [slug]
    );

    if (!serviceResult.rowCount) {
      return null;
    }

    const service = mapPublishedServiceVersionRow(serviceResult.rows[0]);
    const endpointsResult = await this.pool.query(
      `
      SELECT * FROM published_endpoint_versions
      WHERE service_version_id = $1
      ORDER BY operation ASC
      `,
      [service.versionId]
    );

    return {
      service,
      endpoints: endpointsResult.rows.map(mapPublishedEndpointVersionRow)
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

    await this.assertServiceUniqueness(input.slug, input.apiNamespace);
    const id = randomUUID();
    await this.pool.query(
      `
      INSERT INTO provider_services (
        id, provider_account_id, slug, api_namespace, name, tagline, about, categories,
        prompt_intro, setup_instructions, website_url, payout_wallet, featured, status
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10::jsonb, $11, $12, $13, 'draft')
      `,
      [
        id,
        account.id,
        input.slug,
        input.apiNamespace,
        input.name,
        input.tagline,
        input.about,
        JSON.stringify(input.categories),
        input.promptIntro,
        JSON.stringify(input.setupInstructions),
        input.websiteUrl ?? account.websiteUrl ?? null,
        input.payoutWallet,
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

    const nextSlug = input.slug ?? detail.service.slug;
    const nextNamespace = input.apiNamespace ?? detail.service.apiNamespace;
    await this.assertServiceUniqueness(nextSlug, nextNamespace, serviceId);

    const result = await this.pool.query(
      `
      UPDATE provider_services
      SET
        slug = $2,
        api_namespace = $3,
        name = $4,
        tagline = $5,
        about = $6,
        categories = $7::jsonb,
        prompt_intro = $8,
        setup_instructions = $9::jsonb,
        website_url = $10,
        payout_wallet = $11,
        featured = $12,
        updated_at = NOW()
      WHERE id = $1
      RETURNING *
      `,
      [
        serviceId,
        nextSlug,
        nextNamespace,
        input.name ?? detail.service.name,
        input.tagline ?? detail.service.tagline,
        input.about ?? detail.service.about,
        JSON.stringify(input.categories ?? detail.service.categories),
        input.promptIntro ?? detail.service.promptIntro,
        JSON.stringify(input.setupInstructions ?? detail.service.setupInstructions),
        input.websiteUrl === undefined ? detail.service.websiteUrl : input.websiteUrl,
        input.payoutWallet === undefined ? detail.service.payoutWallet : input.payoutWallet,
        input.featured ?? detail.service.featured
      ]
    );

    return result.rowCount ? mapProviderServiceRow(result.rows[0]) : null;
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

    const result = await this.pool.query(
      `
      INSERT INTO provider_endpoint_drafts (
        id, service_id, route_id, operation, title, description, price, mode, request_schema_json, response_schema_json,
        request_example, response_example, usage_notes, executor_kind, upstream_base_url, upstream_path,
        upstream_auth_mode, upstream_auth_header_name, upstream_secret_ref, payout
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11::jsonb, $12::jsonb, $13, 'http', $14, $15,
        $16, $17, $18, $19::jsonb
      )
      RETURNING *
      `,
      [
        randomUUID(),
        serviceId,
        buildRouteId(detail.service.apiNamespace, input.operation),
        input.operation,
        input.title,
        input.description,
        input.price,
        input.mode,
        JSON.stringify(input.requestSchemaJson),
        JSON.stringify(input.responseSchemaJson),
        JSON.stringify(input.requestExample),
        JSON.stringify(input.responseExample),
        input.usageNotes ?? null,
        input.upstreamBaseUrl,
        input.upstreamPath,
        input.upstreamAuthMode,
        input.upstreamAuthHeaderName ?? null,
        secretRef,
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

    const existingResult = await this.pool.query(
      "SELECT * FROM provider_endpoint_drafts WHERE id = $1 AND service_id = $2",
      [endpointId, serviceId]
    );
    if (!existingResult.rowCount) {
      return null;
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
    const result = await this.pool.query(
      `
      UPDATE provider_endpoint_drafts
      SET
        route_id = $3,
        operation = $4,
        title = $5,
        description = $6,
        price = $7,
        request_schema_json = $8::jsonb,
        response_schema_json = $9::jsonb,
        request_example = $10::jsonb,
        response_example = $11::jsonb,
        usage_notes = $12,
        upstream_base_url = $13,
        upstream_path = $14,
        upstream_auth_mode = $15,
        upstream_auth_header_name = $16,
        upstream_secret_ref = $17,
        payout = $18::jsonb,
        updated_at = NOW()
      WHERE id = $1 AND service_id = $2
      RETURNING *
      `,
      [
        endpointId,
        serviceId,
        buildRouteId(detail.service.apiNamespace, operation),
        operation,
        input.title ?? existing.title,
        input.description ?? existing.description,
        input.price ?? existing.price,
        JSON.stringify(input.requestSchemaJson ?? existing.requestSchemaJson),
        JSON.stringify(input.responseSchemaJson ?? existing.responseSchemaJson),
        JSON.stringify(input.requestExample === undefined ? existing.requestExample : input.requestExample),
        JSON.stringify(input.responseExample === undefined ? existing.responseExample : input.responseExample),
        input.usageNotes === undefined ? existing.usageNotes : input.usageNotes,
        input.upstreamBaseUrl ?? existing.upstreamBaseUrl,
        input.upstreamPath ?? existing.upstreamPath,
        input.upstreamAuthMode ?? existing.upstreamAuthMode,
        input.upstreamAuthHeaderName === undefined
          ? existing.upstreamAuthHeaderName
          : input.upstreamAuthHeaderName,
        secretRef,
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

    const result = await this.pool.query(
      "DELETE FROM provider_endpoint_drafts WHERE id = $1 AND service_id = $2",
      [endpointId, serviceId]
    );
    return Boolean(result.rowCount);
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
      const network = getDefaultMarketplaceNetworkConfig();

      await client.query(
        `
        INSERT INTO published_service_versions (
          version_id, service_id, provider_account_id, slug, api_namespace, name, owner_name, tagline, about,
          categories, route_ids, featured, prompt_intro, setup_instructions, website_url, contact_email,
          payout_wallet, status, submitted_review_id
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb, $12, $13, $14::jsonb, $15, $16, $17, 'pending_review', $18
        )
        `,
        [
          serviceVersionId,
          serviceId,
          detail.account.id,
          detail.service.slug,
          detail.service.apiNamespace,
          detail.service.name,
          detail.account.displayName,
          detail.service.tagline,
          detail.service.about,
          JSON.stringify(detail.service.categories),
          JSON.stringify(detail.endpoints.map((endpoint) => endpoint.routeId)),
          detail.service.featured,
          detail.service.promptIntro,
          JSON.stringify(detail.service.setupInstructions),
          detail.service.websiteUrl,
          detail.account.contactEmail,
          detail.service.payoutWallet,
          reviewId
        ]
      );

      for (const endpoint of detail.endpoints) {
        await client.query(
          `
          INSERT INTO published_endpoint_versions (
            endpoint_version_id, service_id, service_version_id, endpoint_draft_id, route_id, provider, operation,
            version, mode, network, price, title, description, payout, request_example, response_example, usage_notes,
            request_schema_json, response_schema_json, executor_kind, upstream_base_url, upstream_path,
            upstream_auth_mode, upstream_auth_header_name, upstream_secret_ref
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, $15::jsonb, $16::jsonb, $17,
            $18::jsonb, $19::jsonb, $20, $21, $22, $23, $24, $25
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
            endpoint.mode,
            network.paymentNetwork,
            endpoint.price,
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
    input?: { reviewerIdentity?: string | null }
  ): Promise<ProviderServiceDetailRecord | null> {
    const service = await this.getAdminProviderService(serviceId);
    if (!service?.latestReview) {
      return null;
    }

    await this.pool.query(
      `
      UPDATE provider_reviews
      SET status = 'published', reviewer_identity = COALESCE($2, reviewer_identity), updated_at = NOW()
      WHERE id = $1
      `,
      [service.latestReview.id, input?.reviewerIdentity ?? null]
    );
    await this.pool.query(
      `
      UPDATE published_service_versions
      SET status = 'published', published_at = NOW(), updated_at = NOW()
      WHERE version_id = $1
      `,
      [service.latestReview.submittedVersionId]
    );
    await this.pool.query(
      `
      UPDATE provider_services
      SET status = 'published', latest_published_version_id = $2, updated_at = NOW()
      WHERE id = $1
      `,
      [serviceId, service.latestReview.submittedVersionId]
    );

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

  private async assertServiceUniqueness(slug: string, apiNamespace: string, serviceId?: string) {
    const result = await this.pool.query(
      `
      SELECT id, slug, api_namespace
      FROM provider_services
      WHERE (slug = $1 OR api_namespace = $2)
        AND ($3::text IS NULL OR id <> $3)
      LIMIT 1
      `,
      [slug, apiNamespace, serviceId ?? null]
    );

    if (!result.rowCount) {
      return;
    }

    if (result.rows[0].slug === slug) {
      throw new Error(`Service slug already exists: ${slug}`);
    }

    throw new Error(`API namespace already exists: ${apiNamespace}`);
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

    const [endpointsResult, verificationResult, reviewResult] = await Promise.all([
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
      endpoints: endpointsResult.rows.map(mapProviderEndpointDraftRow),
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
    quotedPrice: row.quoted_price as string,
    payoutSplit: row.payout_split as IdempotencyRecord["payoutSplit"],
    paymentPayload: row.payment_payload as string,
    facilitatorResponse: row.facilitator_response,
    responseKind: row.response_kind as "sync" | "job",
    responseStatusCode: row.response_status_code as number,
    responseBody: row.response_body,
    responseHeaders: (row.response_headers as Record<string, string>) ?? {},
    jobToken: (row.job_token as string | null) ?? undefined,
    createdAt: new Date(row.created_at as string | Date).toISOString(),
    updatedAt: new Date(row.updated_at as string | Date).toISOString()
  };
}

function mapJobRow(row: Record<string, unknown>): JobRecord {
  return {
    jobToken: row.job_token as string,
    paymentId: row.payment_id as string,
    routeId: row.route_id as string,
    provider: row.provider as string,
    operation: row.operation as string,
    buyerWallet: row.buyer_wallet as string,
    quotedPrice: row.quoted_price as string,
    payoutSplit: row.payout_split as JobRecord["payoutSplit"],
    providerJobId: row.provider_job_id as string,
    requestBody: row.request_body,
    routeSnapshot: row.route_snapshot as MarketplaceRoute,
    providerState: (row.provider_state as Record<string, unknown> | null) ?? null,
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
    jobToken: row.job_token as string,
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
    slug: row.slug as string,
    apiNamespace: row.api_namespace as string,
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

function mapProviderEndpointDraftRow(row: Record<string, unknown>): ProviderEndpointDraftRecord {
  return {
    id: row.id as string,
    serviceId: row.service_id as string,
    routeId: row.route_id as string,
    operation: row.operation as string,
    title: row.title as string,
    description: row.description as string,
    price: row.price as string,
    mode: row.mode as ProviderEndpointDraftRecord["mode"],
    requestSchemaJson: row.request_schema_json as ProviderEndpointDraftRecord["requestSchemaJson"],
    responseSchemaJson: row.response_schema_json as ProviderEndpointDraftRecord["responseSchemaJson"],
    requestExample: row.request_example,
    responseExample: row.response_example,
    usageNotes: (row.usage_notes as string | null) ?? null,
    executorKind: row.executor_kind as ProviderEndpointDraftRecord["executorKind"],
    upstreamBaseUrl: (row.upstream_base_url as string | null) ?? null,
    upstreamPath: (row.upstream_path as string | null) ?? null,
    upstreamAuthMode: (row.upstream_auth_mode as ProviderEndpointDraftRecord["upstreamAuthMode"]) ?? null,
    upstreamAuthHeaderName: (row.upstream_auth_header_name as string | null) ?? null,
    upstreamSecretRef: (row.upstream_secret_ref as string | null) ?? null,
    hasUpstreamSecret: Boolean(row.upstream_secret_ref),
    payout: row.payout as ProviderEndpointDraftRecord["payout"],
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
    slug: row.slug as string,
    apiNamespace: row.api_namespace as string,
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
  return {
    endpointVersionId: row.endpoint_version_id as string,
    serviceId: row.service_id as string,
    serviceVersionId: row.service_version_id as string,
    endpointDraftId: (row.endpoint_draft_id as string | null) ?? null,
    routeId: row.route_id as string,
    provider: row.provider as string,
    operation: row.operation as string,
    version: row.version as string,
    mode: row.mode as PublishedEndpointVersionRecord["mode"],
    network: row.network as PublishedEndpointVersionRecord["network"],
    price: row.price as string,
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
