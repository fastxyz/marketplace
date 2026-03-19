import type { MarketplacePaymentNetwork, MarketplaceTokenSymbol } from "./network.js";

export type JsonSchema = Record<string, unknown>;
export type RouteMode = "sync" | "async";
export type ResourceType = "job" | "site";
export type JobStatus = "pending" | "completed" | "failed";
export type RefundStatus = "not_required" | "pending" | "sent" | "failed";
export type SuggestionType = "endpoint" | "source";
export type SuggestionStatus = "submitted" | "reviewing" | "accepted" | "rejected" | "shipped";
export type UpstreamAuthMode = "none" | "bearer" | "header";
export type RouteExecutorKind = "mock" | "http" | "tavily";
export type ProviderServiceStatus =
  | "draft"
  | "pending_review"
  | "changes_requested"
  | "published"
  | "suspended"
  | "archived";
export type ProviderVerificationStatus = "pending" | "verified" | "failed";
export type ProviderReviewStatus = "pending_review" | "changes_requested" | "published" | "suspended";

export interface RoutePayoutConfig {
  providerAccountId: string;
  providerWallet: string | null;
  providerBps: number;
}

export interface PersistedPayoutSplit {
  currency: MarketplaceTokenSymbol;
  marketplaceWallet: string;
  marketplaceBps: number;
  marketplaceAmount: string;
  providerAccountId: string;
  providerWallet: string | null;
  providerBps: number;
  providerAmount: string;
}

export interface MarketplaceRoute {
  routeId: string;
  provider: string;
  operation: string;
  version: string;
  mode: RouteMode;
  network: MarketplacePaymentNetwork;
  price: string;
  title: string;
  description: string;
  payout: RoutePayoutConfig;
  requestExample: unknown;
  responseExample: unknown;
  usageNotes?: string;
  requestSchemaJson: JsonSchema;
  responseSchemaJson: JsonSchema;
  executorKind: RouteExecutorKind;
  upstreamBaseUrl?: string | null;
  upstreamPath?: string | null;
  upstreamAuthMode?: UpstreamAuthMode | null;
  upstreamAuthHeaderName?: string | null;
  upstreamSecretRef?: string | null;
}

export interface ServiceDefinition {
  serviceId: string;
  providerAccountId: string;
  slug: string;
  apiNamespace: string;
  name: string;
  ownerName: string;
  tagline: string;
  about: string;
  categories: string[];
  routeIds: string[];
  featured: boolean;
  promptIntro: string;
  setupInstructions: string[];
  websiteUrl: string | null;
  contactEmail: string | null;
  payoutWallet: string | null;
  status: ProviderServiceStatus;
}

export interface PublishedServiceVersionRecord extends ServiceDefinition {
  versionId: string;
  submittedReviewId: string | null;
  publishedAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface PublishedEndpointVersionRecord extends MarketplaceRoute {
  endpointVersionId: string;
  serviceId: string;
  serviceVersionId: string;
  endpointDraftId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ServiceAnalyticsPoint {
  date: string;
  amountRaw: string;
}

export interface ServiceAnalytics {
  totalCalls: number;
  revenueRaw: string;
  successRate30d: number;
  volume30d: ServiceAnalyticsPoint[];
}

export interface ServiceSummary {
  slug: string;
  name: string;
  ownerName: string;
  tagline: string;
  categories: string[];
  priceRange: string;
  settlementToken: MarketplaceTokenSymbol;
  endpointCount: number;
  totalCalls: number;
  revenue: string;
  successRate30d: number;
  volume30d: Array<{
    date: string;
    amount: string;
  }>;
}

export interface ServiceCatalogEndpoint {
  routeId: string;
  title: string;
  description: string;
  price: string;
  tokenSymbol: MarketplaceTokenSymbol;
  mode: RouteMode;
  method: "POST";
  path: string;
  proxyUrl: string;
  requestExample: unknown;
  responseExample: unknown;
  usageNotes?: string;
}

export interface ServiceDetail {
  summary: ServiceSummary;
  about: string;
  useThisServicePrompt: string;
  skillUrl: string;
  endpoints: ServiceCatalogEndpoint[];
}

export interface SuggestionRecord {
  id: string;
  type: SuggestionType;
  serviceSlug: string | null;
  title: string;
  description: string;
  sourceUrl: string | null;
  requesterName: string | null;
  requesterEmail: string | null;
  status: SuggestionStatus;
  internalNotes: string | null;
  claimedByProviderAccountId: string | null;
  claimedByProviderName: string | null;
  claimedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProviderRequestRecord {
  id: string;
  type: SuggestionType;
  serviceSlug: string | null;
  title: string;
  description: string;
  sourceUrl: string | null;
  status: SuggestionStatus;
  claimedByProviderName: string | null;
  claimedAt: string | null;
  claimedByCurrentProvider: boolean;
  claimable: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CreateSuggestionInput {
  type: SuggestionType;
  serviceSlug?: string | null;
  title: string;
  description: string;
  sourceUrl?: string | null;
  requesterName?: string | null;
  requesterEmail?: string | null;
}

export interface UpdateSuggestionInput {
  status?: SuggestionStatus;
  internalNotes?: string | null;
}

export interface ProviderAccountRecord {
  id: string;
  ownerWallet: string;
  displayName: string;
  bio: string | null;
  websiteUrl: string | null;
  contactEmail: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProviderSecretRecord {
  id: string;
  providerAccountId: string;
  label: string;
  secretCiphertext: string;
  iv: string;
  authTag: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProviderServiceRecord {
  id: string;
  providerAccountId: string;
  slug: string;
  apiNamespace: string;
  name: string;
  tagline: string;
  about: string;
  categories: string[];
  promptIntro: string;
  setupInstructions: string[];
  websiteUrl: string | null;
  payoutWallet: string | null;
  featured: boolean;
  status: ProviderServiceStatus;
  createdAt: string;
  updatedAt: string;
}

export interface ProviderEndpointDraftRecord {
  id: string;
  serviceId: string;
  routeId: string;
  operation: string;
  title: string;
  description: string;
  price: string;
  mode: RouteMode;
  requestSchemaJson: JsonSchema;
  responseSchemaJson: JsonSchema;
  requestExample: unknown;
  responseExample: unknown;
  usageNotes: string | null;
  executorKind: RouteExecutorKind;
  upstreamBaseUrl: string | null;
  upstreamPath: string | null;
  upstreamAuthMode: UpstreamAuthMode | null;
  upstreamAuthHeaderName: string | null;
  upstreamSecretRef: string | null;
  hasUpstreamSecret: boolean;
  payout: RoutePayoutConfig;
  createdAt: string;
  updatedAt: string;
}

export interface ProviderVerificationRecord {
  id: string;
  serviceId: string;
  token: string;
  status: ProviderVerificationStatus;
  verifiedHost: string | null;
  failureReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProviderReviewRecord {
  id: string;
  serviceId: string;
  submittedVersionId: string;
  status: ProviderReviewStatus;
  reviewNotes: string | null;
  reviewerIdentity: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProviderServiceDetailRecord {
  service: ProviderServiceRecord;
  account: ProviderAccountRecord;
  endpoints: ProviderEndpointDraftRecord[];
  verification: ProviderVerificationRecord | null;
  latestReview: ProviderReviewRecord | null;
  latestPublishedVersionId: string | null;
}

export interface UpsertProviderAccountInput {
  displayName: string;
  bio?: string | null;
  websiteUrl?: string | null;
  contactEmail?: string | null;
}

export interface CreateProviderServiceInput {
  slug: string;
  apiNamespace: string;
  name: string;
  tagline: string;
  about: string;
  categories: string[];
  promptIntro: string;
  setupInstructions: string[];
  websiteUrl?: string | null;
  payoutWallet: string;
  featured?: boolean;
}

export interface UpdateProviderServiceInput {
  slug?: string;
  apiNamespace?: string;
  name?: string;
  tagline?: string;
  about?: string;
  categories?: string[];
  promptIntro?: string;
  setupInstructions?: string[];
  websiteUrl?: string | null;
  payoutWallet?: string | null;
  featured?: boolean;
}

export interface CreateProviderEndpointDraftInput {
  operation: string;
  title: string;
  description: string;
  price: string;
  mode: "sync";
  requestSchemaJson: JsonSchema;
  responseSchemaJson: JsonSchema;
  requestExample: unknown;
  responseExample: unknown;
  usageNotes?: string | null;
  upstreamBaseUrl: string;
  upstreamPath: string;
  upstreamAuthMode: UpstreamAuthMode;
  upstreamAuthHeaderName?: string | null;
  upstreamSecret?: string | null;
}

export interface UpdateProviderEndpointDraftInput {
  operation?: string;
  title?: string;
  description?: string;
  price?: string;
  requestSchemaJson?: JsonSchema;
  responseSchemaJson?: JsonSchema;
  requestExample?: unknown;
  responseExample?: unknown;
  usageNotes?: string | null;
  upstreamBaseUrl?: string;
  upstreamPath?: string;
  upstreamAuthMode?: UpstreamAuthMode;
  upstreamAuthHeaderName?: string | null;
  upstreamSecret?: string | null;
  clearUpstreamSecret?: boolean;
}

export interface SyncExecuteResult {
  kind: "sync";
  statusCode: number;
  body: unknown;
  headers?: Record<string, string>;
}

export interface AsyncExecuteResult {
  kind: "async";
  providerJobId: string;
  state?: Record<string, unknown>;
  pollAfterMs?: number;
}

export type ExecuteResult = SyncExecuteResult | AsyncExecuteResult;

export interface PollPendingResult {
  status: "pending";
  state?: Record<string, unknown>;
  pollAfterMs?: number;
}

export interface PollCompletedResult {
  status: "completed";
  body: unknown;
}

export interface PollFailedResult {
  status: "failed";
  error: string;
  permanent: boolean;
  state?: Record<string, unknown>;
}

export type PollResult = PollPendingResult | PollCompletedResult | PollFailedResult;

export interface ProviderExecuteContext {
  route: MarketplaceRoute;
  input: unknown;
  buyerWallet: string;
  paymentId: string;
}

export interface ProviderPollContext {
  route: MarketplaceRoute;
  job: JobRecord;
}

export interface ProviderAdapter {
  execute(context: ProviderExecuteContext): Promise<ExecuteResult>;
  poll(context: ProviderPollContext): Promise<PollResult>;
}

export type ProviderRegistry = Record<string, ProviderAdapter>;

export interface FacilitatorVerifyResult {
  isValid: boolean;
  invalidReason?: string;
  payer?: string;
  network?: string;
}

export interface FacilitatorClient {
  verify(paymentPayload: string, paymentRequirement: unknown): Promise<FacilitatorVerifyResult>;
}

export interface RefundReceipt {
  txHash: string;
}

export interface RefundService {
  issueRefund(input: { wallet: string; amount: string; reason: string }): Promise<RefundReceipt>;
}

export interface IdempotencyRecord {
  paymentId: string;
  normalizedRequestHash: string;
  buyerWallet: string;
  routeId: string;
  routeVersion: string;
  quotedPrice: string;
  payoutSplit: PersistedPayoutSplit;
  paymentPayload: string;
  facilitatorResponse: unknown;
  responseKind: "sync" | "job";
  responseStatusCode: number;
  responseBody: unknown;
  responseHeaders: Record<string, string>;
  jobToken?: string;
  createdAt: string;
  updatedAt: string;
}

export interface JobRecord {
  jobToken: string;
  paymentId: string;
  routeId: string;
  provider: string;
  operation: string;
  buyerWallet: string;
  quotedPrice: string;
  payoutSplit: PersistedPayoutSplit;
  providerJobId: string;
  requestBody: unknown;
  routeSnapshot: MarketplaceRoute;
  providerState: Record<string, unknown> | null;
  status: JobStatus;
  resultBody: unknown;
  errorMessage: string | null;
  refundStatus: RefundStatus;
  refundId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProviderAttemptRecord {
  id: string;
  jobToken: string;
  phase: "execute" | "poll" | "refund";
  status: "succeeded" | "failed";
  requestPayload: unknown;
  responsePayload: unknown;
  errorMessage: string | null;
  createdAt: string;
}

export interface AccessGrantRecord {
  id: string;
  resourceType: ResourceType;
  resourceId: string;
  wallet: string;
  paymentId: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface RefundRecord {
  id: string;
  jobToken: string | null;
  paymentId: string;
  wallet: string;
  amount: string;
  status: "pending" | "sent" | "failed";
  txHash: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SaveSyncIdempotencyInput {
  paymentId: string;
  normalizedRequestHash: string;
  buyerWallet: string;
  routeId: string;
  routeVersion: string;
  quotedPrice: string;
  payoutSplit: PersistedPayoutSplit;
  paymentPayload: string;
  facilitatorResponse: unknown;
  statusCode: number;
  body: unknown;
  headers?: Record<string, string>;
}

export interface SaveAsyncAcceptanceInput {
  paymentId: string;
  normalizedRequestHash: string;
  buyerWallet: string;
  route: MarketplaceRoute;
  quotedPrice: string;
  payoutSplit: PersistedPayoutSplit;
  paymentPayload: string;
  facilitatorResponse: unknown;
  jobToken: string;
  providerJobId: string;
  requestBody: unknown;
  providerState?: Record<string, unknown>;
  responseBody: unknown;
  responseHeaders?: Record<string, string>;
}

export interface MarketplaceStore {
  ensureSchema(): Promise<void>;
  getIdempotencyByPaymentId(paymentId: string): Promise<IdempotencyRecord | null>;
  saveSyncIdempotency(input: SaveSyncIdempotencyInput): Promise<IdempotencyRecord>;
  saveAsyncAcceptance(input: SaveAsyncAcceptanceInput): Promise<{ idempotency: IdempotencyRecord; job: JobRecord }>;
  getJob(jobToken: string): Promise<JobRecord | null>;
  listPendingJobs(limit: number): Promise<JobRecord[]>;
  updateJobPending(jobToken: string, providerState?: Record<string, unknown>): Promise<JobRecord>;
  completeJob(jobToken: string, body: unknown): Promise<JobRecord>;
  failJob(jobToken: string, error: string): Promise<JobRecord>;
  createAccessGrant(input: {
    resourceType: ResourceType;
    resourceId: string;
    wallet: string;
    paymentId: string;
    metadata?: Record<string, unknown>;
  }): Promise<AccessGrantRecord>;
  getAccessGrant(resourceType: ResourceType, resourceId: string, wallet: string): Promise<AccessGrantRecord | null>;
  recordProviderAttempt(input: {
    jobToken: string;
    phase: "execute" | "poll" | "refund";
    status: "succeeded" | "failed";
    requestPayload?: unknown;
    responsePayload?: unknown;
    errorMessage?: string;
  }): Promise<ProviderAttemptRecord>;
  createRefund(input: {
    jobToken?: string | null;
    paymentId: string;
    wallet: string;
    amount: string;
  }): Promise<RefundRecord>;
  markRefundSent(refundId: string, txHash: string): Promise<RefundRecord>;
  markRefundFailed(refundId: string, errorMessage: string): Promise<RefundRecord>;
  getRefundByJobToken(jobToken: string): Promise<RefundRecord | null>;
  getServiceAnalytics(routeIds: string[]): Promise<ServiceAnalytics>;
  listPublishedServices(): Promise<PublishedServiceVersionRecord[]>;
  getPublishedServiceBySlug(slug: string): Promise<{
    service: PublishedServiceVersionRecord;
    endpoints: PublishedEndpointVersionRecord[];
  } | null>;
  listPublishedRoutes(): Promise<PublishedEndpointVersionRecord[]>;
  findPublishedRoute(
    provider: string,
    operation: string,
    network: MarketplacePaymentNetwork
  ): Promise<PublishedEndpointVersionRecord | null>;
  getProviderAccountByWallet(wallet: string): Promise<ProviderAccountRecord | null>;
  upsertProviderAccount(wallet: string, input: UpsertProviderAccountInput): Promise<ProviderAccountRecord>;
  listProviderServices(wallet: string): Promise<ProviderServiceDetailRecord[]>;
  createProviderService(wallet: string, input: CreateProviderServiceInput): Promise<ProviderServiceDetailRecord>;
  getProviderServiceForOwner(serviceId: string, wallet: string): Promise<ProviderServiceDetailRecord | null>;
  updateProviderServiceForOwner(
    serviceId: string,
    wallet: string,
    input: UpdateProviderServiceInput
  ): Promise<ProviderServiceRecord | null>;
  createProviderEndpointDraft(
    serviceId: string,
    wallet: string,
    input: CreateProviderEndpointDraftInput,
    secretMaterial?: { label: string; ciphertext: string; iv: string; authTag: string } | null
  ): Promise<ProviderEndpointDraftRecord>;
  updateProviderEndpointDraft(
    serviceId: string,
    endpointId: string,
    wallet: string,
    input: UpdateProviderEndpointDraftInput,
    secretMaterial?: { label: string; ciphertext: string; iv: string; authTag: string } | null
  ): Promise<ProviderEndpointDraftRecord | null>;
  deleteProviderEndpointDraft(serviceId: string, endpointId: string, wallet: string): Promise<boolean>;
  createProviderVerificationChallenge(serviceId: string, wallet: string): Promise<ProviderVerificationRecord | null>;
  getLatestProviderVerification(serviceId: string): Promise<ProviderVerificationRecord | null>;
  markProviderVerificationResult(
    serviceId: string,
    status: ProviderVerificationStatus,
    input?: { verifiedHost?: string | null; failureReason?: string | null }
  ): Promise<ProviderVerificationRecord | null>;
  submitProviderService(serviceId: string, wallet: string): Promise<ProviderServiceDetailRecord | null>;
  listAdminProviderServices(status?: ProviderServiceStatus): Promise<ProviderServiceDetailRecord[]>;
  getAdminProviderService(serviceId: string): Promise<ProviderServiceDetailRecord | null>;
  requestProviderServiceChanges(
    serviceId: string,
    input: { reviewNotes: string; reviewerIdentity?: string | null }
  ): Promise<ProviderServiceDetailRecord | null>;
  publishProviderService(
    serviceId: string,
    input?: { reviewerIdentity?: string | null }
  ): Promise<ProviderServiceDetailRecord | null>;
  suspendProviderService(
    serviceId: string,
    input?: { reviewNotes?: string | null; reviewerIdentity?: string | null }
  ): Promise<ProviderServiceDetailRecord | null>;
  getProviderSecret(secretId: string): Promise<ProviderSecretRecord | null>;
  createSuggestion(input: CreateSuggestionInput): Promise<SuggestionRecord>;
  listSuggestions(filter?: { status?: SuggestionStatus }): Promise<SuggestionRecord[]>;
  updateSuggestion(id: string, input: UpdateSuggestionInput): Promise<SuggestionRecord | null>;
  listProviderRequests(wallet: string): Promise<SuggestionRecord[]>;
  claimProviderRequest(id: string, wallet: string): Promise<SuggestionRecord | null>;
}

export interface ChallengePayload {
  wallet: string;
  resourceType: ResourceType;
  resourceId: string;
  nonce: string;
  expiresAt: string;
}

export interface SessionTokenPayload {
  wallet: string;
  resourceType: ResourceType;
  resourceId: string;
  expiresAt: string;
}
