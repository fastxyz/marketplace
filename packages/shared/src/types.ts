import type { MarketplacePaymentNetwork, MarketplaceTokenSymbol } from "./network.js";

export type JsonSchema = Record<string, unknown>;
export type RouteMode = "sync" | "async";
export type AsyncRouteStrategy = "poll" | "webhook";
export type ResourceType = "job" | "site" | "api";
export type JobStatus = "pending" | "completed" | "failed";
export type RefundStatus = "not_required" | "pending" | "sent" | "failed";
export type SuggestionType = "endpoint" | "source";
export type SuggestionStatus = "submitted" | "reviewing" | "accepted" | "rejected" | "shipped";
export type UpstreamAuthMode = "none" | "bearer" | "header";
export type RouteExecutorKind = "mock" | "http" | "marketplace";
export type ProviderServiceStatus =
  | "draft"
  | "pending_review"
  | "changes_requested"
  | "published"
  | "suspended"
  | "archived";
export type ProviderVerificationStatus = "pending" | "verified" | "failed";
export type ProviderReviewStatus = "pending_review" | "changes_requested" | "published" | "suspended";
export type SettlementMode = "community_direct" | "verified_escrow";
export type ProviderServiceType = "marketplace_proxy" | "external_registry";
export type ServiceEndpointType = ProviderServiceType;
export type HttpMethod = "GET" | "POST";
export type ExternalEndpointMethod = HttpMethod;

export interface RoutePayoutConfig {
  providerAccountId: string;
  providerWallet: string | null;
  providerBps: number;
}

export interface PersistedPayoutSplit {
  currency: MarketplaceTokenSymbol;
  settlementMode: SettlementMode;
  paymentDestinationWallet: string;
  usesTreasurySettlement: boolean;
  marketplaceWallet: string;
  marketplaceBps: number;
  marketplaceAmount: string;
  providerAccountId: string;
  providerWallet: string | null;
  providerBps: number;
  providerAmount: string;
}

export type RouteBillingType = "fixed_x402" | "topup_x402_variable" | "prepaid_credit" | "free";

export interface FixedX402Billing {
  type: "fixed_x402";
  price: string;
}

export interface TopupX402VariableBilling {
  type: "topup_x402_variable";
  minAmount: string;
  maxAmount: string;
}

export interface PrepaidCreditBilling {
  type: "prepaid_credit";
}

export interface FreeBilling {
  type: "free";
}

export type RouteBilling = FixedX402Billing | TopupX402VariableBilling | PrepaidCreditBilling | FreeBilling;

export interface RouteAsyncConfig {
  strategy: AsyncRouteStrategy;
  timeoutMs: number;
  pollPath?: string | null;
}

export interface MarketplaceRoute {
  routeId: string;
  provider: string;
  operation: string;
  version: string;
  method: HttpMethod;
  settlementMode: SettlementMode;
  mode: RouteMode;
  network: MarketplacePaymentNetwork;
  price: string;
  billing: RouteBilling;
  title: string;
  description: string;
  payout: RoutePayoutConfig;
  requestExample: unknown;
  responseExample: unknown;
  usageNotes?: string;
  requestSchemaJson: JsonSchema;
  responseSchemaJson: JsonSchema;
  executorKind: RouteExecutorKind;
  asyncConfig?: RouteAsyncConfig | null;
  upstreamBaseUrl?: string | null;
  upstreamPath?: string | null;
  upstreamAuthMode?: UpstreamAuthMode | null;
  upstreamAuthHeaderName?: string | null;
  upstreamSecretRef?: string | null;
}

export interface ServiceDefinition {
  serviceId: string;
  providerAccountId: string;
  serviceType: ProviderServiceType;
  settlementMode: SettlementMode | null;
  slug: string;
  apiNamespace: string | null;
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
  endpointType: "marketplace_proxy";
  endpointVersionId: string;
  serviceId: string;
  serviceVersionId: string;
  endpointDraftId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PublishedExternalEndpointVersionRecord {
  endpointType: "external_registry";
  endpointVersionId: string;
  serviceId: string;
  serviceVersionId: string;
  endpointDraftId: string | null;
  routeId: null;
  provider: null;
  operation: null;
  version: null;
  settlementMode: null;
  mode: null;
  network: null;
  price: null;
  billing: null;
  title: string;
  description: string;
  payout: null;
  method: ExternalEndpointMethod;
  publicUrl: string;
  docsUrl: string;
  authNotes: string | null;
  requestExample: unknown;
  responseExample: unknown;
  usageNotes?: string;
  requestSchemaJson: null;
  responseSchemaJson: null;
  executorKind: null;
  upstreamBaseUrl: null;
  upstreamPath: null;
  upstreamAuthMode: null;
  upstreamAuthHeaderName: null;
  upstreamSecretRef: null;
  createdAt: string;
  updatedAt: string;
}

export type PublishedServiceEndpointVersionRecord =
  | PublishedEndpointVersionRecord
  | PublishedExternalEndpointVersionRecord;

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

export interface MarketplaceServiceSummary {
  serviceType: "marketplace_proxy";
  slug: string;
  name: string;
  ownerName: string;
  tagline: string;
  categories: string[];
  settlementMode: SettlementMode;
  settlementLabel: string;
  settlementDescription: string;
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

export interface ExternalRegistryServiceSummary {
  serviceType: "external_registry";
  slug: string;
  name: string;
  ownerName: string;
  tagline: string;
  categories: string[];
  settlementMode: null;
  settlementLabel: string;
  settlementDescription: string;
  priceRange: string;
  settlementToken: null;
  totalCalls: null;
  revenue: null;
  successRate30d: null;
  volume30d: Array<{
    date: string;
    amount: string;
  }>;
  accessModelLabel: string;
  accessModelDescription: string;
  endpointCount: number;
  websiteUrl: string | null;
}

export type ServiceSummary = MarketplaceServiceSummary | ExternalRegistryServiceSummary;

export interface MarketplaceServiceCatalogEndpoint {
  endpointType: "marketplace_proxy";
  routeId: string;
  title: string;
  description: string;
  price: string;
  billingType: RouteBillingType;
  tokenSymbol: MarketplaceTokenSymbol;
  mode: RouteMode;
  method: HttpMethod;
  path: string;
  proxyUrl: string;
  requestSchemaJson: JsonSchema;
  responseSchemaJson: JsonSchema;
  requestExample: unknown;
  responseExample: unknown;
  usageNotes?: string;
}

export interface ExternalServiceCatalogEndpoint {
  endpointType: "external_registry";
  endpointId: string;
  title: string;
  description: string;
  method: ExternalEndpointMethod;
  publicUrl: string;
  docsUrl: string;
  authNotes: string | null;
  requestExample: unknown;
  responseExample: unknown;
  usageNotes?: string;
}

export type ServiceCatalogEndpoint = MarketplaceServiceCatalogEndpoint | ExternalServiceCatalogEndpoint;

export interface MarketplaceServiceDetail {
  serviceType: "marketplace_proxy";
  summary: MarketplaceServiceSummary;
  about: string;
  useThisServicePrompt: string;
  skillUrl: string;
  endpoints: MarketplaceServiceCatalogEndpoint[];
}

export interface ExternalRegistryServiceDetail {
  serviceType: "external_registry";
  summary: ExternalRegistryServiceSummary;
  about: string;
  useThisServicePrompt: string;
  skillUrl: null;
  websiteUrl: string | null;
  endpoints: ExternalServiceCatalogEndpoint[];
}

export type ServiceDetail = MarketplaceServiceDetail | ExternalRegistryServiceDetail;

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
  serviceType: ProviderServiceType;
  settlementMode: SettlementMode | null;
  slug: string;
  apiNamespace: string | null;
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

export interface MarketplaceProviderEndpointDraftRecord {
  endpointType: "marketplace_proxy";
  id: string;
  serviceId: string;
  routeId: string;
  operation: string;
  method: HttpMethod;
  title: string;
  description: string;
  price: string;
  billing: RouteBilling;
  mode: RouteMode;
  requestSchemaJson: JsonSchema;
  responseSchemaJson: JsonSchema;
  requestExample: unknown;
  responseExample: unknown;
  usageNotes: string | null;
  executorKind: RouteExecutorKind;
  asyncConfig: RouteAsyncConfig | null;
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

export interface ExternalProviderEndpointDraftRecord {
  endpointType: "external_registry";
  id: string;
  serviceId: string;
  routeId: null;
  operation: null;
  title: string;
  description: string;
  price: null;
  billing: null;
  mode: null;
  requestSchemaJson: null;
  responseSchemaJson: null;
  method: ExternalEndpointMethod;
  publicUrl: string;
  docsUrl: string;
  authNotes: string | null;
  requestExample: unknown;
  responseExample: unknown;
  usageNotes: string | null;
  executorKind: null;
  upstreamBaseUrl: null;
  upstreamPath: null;
  upstreamAuthMode: null;
  upstreamAuthHeaderName: null;
  upstreamSecretRef: null;
  hasUpstreamSecret: false;
  payout: null;
  createdAt: string;
  updatedAt: string;
}

export type ProviderEndpointDraftRecord =
  | MarketplaceProviderEndpointDraftRecord
  | ExternalProviderEndpointDraftRecord;

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
  serviceType: ProviderServiceType;
  slug: string;
  apiNamespace?: string | null;
  name: string;
  tagline: string;
  about: string;
  categories: string[];
  promptIntro: string;
  setupInstructions: string[];
  websiteUrl?: string | null;
  payoutWallet?: string | null;
  featured?: boolean;
}

export interface UpdateProviderServiceInput {
  serviceType?: ProviderServiceType;
  slug?: string;
  apiNamespace?: string | null;
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

export interface CreateMarketplaceProviderEndpointDraftInput {
  endpointType: "marketplace_proxy";
  operation: string;
  method: HttpMethod;
  title: string;
  description: string;
  price?: string;
  billingType: RouteBillingType;
  minAmount?: string | null;
  maxAmount?: string | null;
  mode: RouteMode;
  asyncStrategy?: AsyncRouteStrategy | null;
  asyncTimeoutMs?: number | null;
  pollPath?: string | null;
  requestSchemaJson: JsonSchema;
  responseSchemaJson: JsonSchema;
  requestExample: unknown;
  responseExample: unknown;
  usageNotes?: string | null;
  upstreamBaseUrl?: string | null;
  upstreamPath?: string | null;
  upstreamAuthMode?: UpstreamAuthMode | null;
  upstreamAuthHeaderName?: string | null;
  upstreamSecret?: string | null;
}

export interface CreateExternalProviderEndpointDraftInput {
  endpointType: "external_registry";
  title: string;
  description: string;
  method: ExternalEndpointMethod;
  publicUrl: string;
  docsUrl: string;
  authNotes?: string | null;
  requestExample: unknown;
  responseExample: unknown;
  usageNotes?: string | null;
}

export type CreateProviderEndpointDraftInput =
  | CreateMarketplaceProviderEndpointDraftInput
  | CreateExternalProviderEndpointDraftInput;

export interface UpdateMarketplaceProviderEndpointDraftInput {
  endpointType: "marketplace_proxy";
  operation?: string;
  method?: HttpMethod;
  title?: string;
  description?: string;
  price?: string;
  billingType?: RouteBillingType;
  minAmount?: string | null;
  maxAmount?: string | null;
  mode?: RouteMode;
  asyncStrategy?: AsyncRouteStrategy | null;
  asyncTimeoutMs?: number | null;
  pollPath?: string | null;
  requestSchemaJson?: JsonSchema;
  responseSchemaJson?: JsonSchema;
  requestExample?: unknown;
  responseExample?: unknown;
  usageNotes?: string | null;
  upstreamBaseUrl?: string | null;
  upstreamPath?: string | null;
  upstreamAuthMode?: UpstreamAuthMode | null;
  upstreamAuthHeaderName?: string | null;
  upstreamSecret?: string | null;
  clearUpstreamSecret?: boolean;
}

export interface UpdateExternalProviderEndpointDraftInput {
  endpointType: "external_registry";
  title?: string;
  description?: string;
  method?: ExternalEndpointMethod;
  publicUrl?: string;
  docsUrl?: string;
  authNotes?: string | null;
  requestExample?: unknown;
  responseExample?: unknown;
  usageNotes?: string | null;
}

export type UpdateProviderEndpointDraftInput =
  | UpdateMarketplaceProviderEndpointDraftInput
  | UpdateExternalProviderEndpointDraftInput;

export interface OpenApiImportRequest {
  documentUrl: string;
}

export interface OpenApiImportCandidate {
  operation: string;
  method: HttpMethod;
  title: string;
  description: string;
  requestSchemaJson: JsonSchema;
  responseSchemaJson: JsonSchema;
  requestExample: unknown;
  responseExample: unknown;
  usageNotes: string | null;
  upstreamBaseUrl: string;
  upstreamPath: string;
  upstreamAuthMode: UpstreamAuthMode;
  upstreamAuthHeaderName: string | null;
  warnings: string[];
}

export interface OpenApiImportPreview {
  documentUrl: string;
  title: string | null;
  version: string | null;
  endpoints: OpenApiImportCandidate[];
  warnings: string[];
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
  providerState?: Record<string, unknown>;
  pollAfterMs?: number;
}

export type ExecuteResult = SyncExecuteResult | AsyncExecuteResult;

export interface PollPendingResult {
  status: "pending";
  providerState?: Record<string, unknown>;
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
  providerState?: Record<string, unknown>;
}

export type PollResult = PollPendingResult | PollCompletedResult | PollFailedResult;

export interface ProviderExecuteContext {
  route: MarketplaceRoute;
  input: unknown;
  buyerWallet: string;
  requestId: string;
  paymentId: string | null;
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

export interface PayoutReceipt {
  txHash: string;
}

export interface PayoutService {
  issuePayout(input: { wallet: string; amount: string; reason: string }): Promise<PayoutReceipt>;
}

export type ProviderPayoutSourceKind = "route_charge" | "credit_topup";
export type PendingPaymentRecoveryAction = "retry" | "refund";

export interface ProviderPayoutInput {
  sourceKind: ProviderPayoutSourceKind;
  sourceId: string;
  providerAccountId: string;
  providerWallet: string;
  currency: MarketplaceTokenSymbol;
  amount: string;
}

export type IdempotencyExecutionStatus = "pending" | "completed";

export interface IdempotencyRecord {
  paymentId: string;
  normalizedRequestHash: string;
  buyerWallet: string;
  routeId: string;
  routeVersion: string;
  pendingRecoveryAction: PendingPaymentRecoveryAction;
  quotedPrice: string;
  payoutSplit: PersistedPayoutSplit;
  paymentPayload: string;
  facilitatorResponse: unknown;
  responseKind: "sync" | "job";
  responseStatusCode: number;
  responseBody: unknown;
  responseHeaders: Record<string, string>;
  providerPayoutSourceKind?: ProviderPayoutSourceKind | null;
  executionStatus: IdempotencyExecutionStatus;
  requestId?: string | null;
  jobToken?: string;
  createdAt: string;
  updatedAt: string;
}

export interface JobRecord {
  jobToken: string;
  paymentId: string | null;
  routeId: string;
  serviceId: string | null;
  provider: string;
  operation: string;
  buyerWallet: string;
  quotedPrice: string;
  payoutSplit: PersistedPayoutSplit;
  requestId: string;
  providerJobId: string | null;
  requestBody: unknown;
  routeSnapshot: MarketplaceRoute;
  providerState: Record<string, unknown> | null;
  nextPollAt: string | null;
  timeoutAt: string | null;
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
  jobToken: string | null;
  routeId: string;
  requestId: string | null;
  responseStatusCode: number | null;
  phase: "execute" | "poll" | "callback" | "refund";
  status: "pending" | "succeeded" | "failed";
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

export interface ProviderPayoutRecord {
  id: string;
  sourceKind: ProviderPayoutSourceKind;
  sourceId: string;
  providerAccountId: string;
  providerWallet: string;
  currency: MarketplaceTokenSymbol;
  amount: string;
  status: "pending" | "sent";
  txHash: string | null;
  sentAt: string | null;
  attemptCount: number;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreditAccountRecord {
  id: string;
  serviceId: string;
  buyerWallet: string;
  currency: MarketplaceTokenSymbol;
  availableAmount: string;
  reservedAmount: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreditLedgerEntryRecord {
  id: string;
  accountId: string;
  serviceId: string;
  buyerWallet: string;
  currency: MarketplaceTokenSymbol;
  kind: "topup" | "reserve" | "capture" | "release";
  amount: string;
  reservationId: string | null;
  paymentId: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface CreditReservationRecord {
  id: string;
  accountId: string;
  serviceId: string;
  buyerWallet: string;
  currency: MarketplaceTokenSymbol;
  idempotencyKey: string;
  jobToken: string | null;
  providerReference: string | null;
  status: "reserved" | "captured" | "released" | "expired";
  reservedAmount: string;
  capturedAmount: string;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProviderRuntimeKeyRecord {
  id: string;
  serviceId: string;
  keyPrefix: string;
  keyHash: string;
  secretCiphertext: string;
  iv: string;
  authTag: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProviderRuntimeKeyWithSecret {
  record: ProviderRuntimeKeyRecord;
  plaintextKey: string;
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
  requestId?: string | null;
  providerPayoutSourceKind?: ProviderPayoutSourceKind | null;
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
  serviceId?: string | null;
  requestId: string;
  providerJobId: string;
  requestBody: unknown;
  providerState?: Record<string, unknown>;
  nextPollAt?: string | null;
  timeoutAt?: string | null;
  responseBody: unknown;
  responseHeaders?: Record<string, string>;
}

export interface SavePendingAsyncJobInput {
  jobToken: string;
  paymentId?: string | null;
  buyerWallet: string;
  route: MarketplaceRoute;
  quotedPrice: string;
  payoutSplit: PersistedPayoutSplit;
  serviceId?: string | null;
  requestId: string;
  providerJobId?: string | null;
  requestBody: unknown;
  providerState?: Record<string, unknown> | null;
  nextPollAt?: string | null;
  timeoutAt?: string | null;
}

export interface ClaimPaymentExecutionInput {
  paymentId: string;
  normalizedRequestHash: string;
  buyerWallet: string;
  routeId: string;
  routeVersion: string;
  pendingRecoveryAction: PendingPaymentRecoveryAction;
  quotedPrice: string;
  payoutSplit: PersistedPayoutSplit;
  paymentPayload: string;
  facilitatorResponse: unknown;
  responseKind: "sync" | "job";
  requestId: string;
  jobToken?: string;
  responseBody?: unknown;
  responseHeaders?: Record<string, string>;
}

export interface ClaimPaymentExecutionResult {
  record: IdempotencyRecord;
  created: boolean;
}

export interface CompleteCreditTopupChargeInput {
  paymentId: string;
  normalizedRequestHash: string;
  buyerWallet: string;
  routeId: string;
  routeVersion: string;
  quotedPrice: string;
  payoutSplit: PersistedPayoutSplit;
  paymentPayload: string;
  facilitatorResponse: unknown;
  responseHeaders?: Record<string, string>;
  requestId?: string | null;
  serviceId: string;
  metadata?: Record<string, unknown>;
}

export interface MarketplaceStore {
  ensureSchema(): Promise<void>;
  getIdempotencyByPaymentId(paymentId: string): Promise<IdempotencyRecord | null>;
  claimPaymentExecution(input: ClaimPaymentExecutionInput): Promise<ClaimPaymentExecutionResult>;
  touchPendingPaymentExecution(paymentId: string): Promise<IdempotencyRecord | null>;
  completePendingJobExecution(input: {
    paymentId: string;
    jobToken: string;
    responseBody: unknown;
    responseHeaders?: Record<string, string>;
  }): Promise<IdempotencyRecord | null>;
  listStalePendingPaymentExecutions(updatedBefore: string, limit: number): Promise<IdempotencyRecord[]>;
  saveSyncIdempotency(input: SaveSyncIdempotencyInput): Promise<IdempotencyRecord>;
  saveAsyncAcceptance(input: SaveAsyncAcceptanceInput): Promise<{ idempotency: IdempotencyRecord; job: JobRecord }>;
  savePendingAsyncJob(input: SavePendingAsyncJobInput): Promise<JobRecord>;
  getJob(jobToken: string): Promise<JobRecord | null>;
  listPendingJobs(input: { limit: number; now?: string }): Promise<JobRecord[]>;
  updateJobPending(input: { jobToken: string; providerState?: Record<string, unknown> | null; nextPollAt?: string | null }): Promise<JobRecord>;
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
    jobToken?: string | null;
    routeId: string;
    requestId?: string | null;
    responseStatusCode?: number | null;
    phase: "execute" | "poll" | "callback" | "refund";
    status: "pending" | "succeeded" | "failed";
    requestPayload?: unknown;
    responsePayload?: unknown;
    errorMessage?: string;
  }): Promise<ProviderAttemptRecord>;
  getLatestProviderExecuteAttempt(jobToken: string): Promise<ProviderAttemptRecord | null>;
  getLatestSuccessfulProviderExecuteAttempt(jobToken: string): Promise<ProviderAttemptRecord | null>;
  createRefund(input: {
    jobToken?: string | null;
    paymentId: string;
    wallet: string;
    amount: string;
  }): Promise<RefundRecord>;
  markRefundSent(refundId: string, txHash: string): Promise<RefundRecord>;
  markRefundFailed(refundId: string, errorMessage: string): Promise<RefundRecord>;
  getRefundByJobToken(jobToken: string): Promise<RefundRecord | null>;
  getRefundByPaymentId(paymentId: string): Promise<RefundRecord | null>;
  createProviderPayout(input: ProviderPayoutInput): Promise<ProviderPayoutRecord>;
  listRecoverableProviderPayouts(limit: number): Promise<ProviderPayoutInput[]>;
  listPendingProviderPayouts(limit: number): Promise<ProviderPayoutRecord[]>;
  markProviderPayoutSendFailure(payoutIds: string[], errorMessage: string): Promise<void>;
  markProviderPayoutsSent(payoutIds: string[], txHash: string): Promise<ProviderPayoutRecord[]>;
  completeCreditTopupCharge(
    input: CompleteCreditTopupChargeInput
  ): Promise<{ idempotency: IdempotencyRecord; account: CreditAccountRecord; entry: CreditLedgerEntryRecord }>;
  createCreditTopup(input: {
    serviceId: string;
    buyerWallet: string;
    currency: MarketplaceTokenSymbol;
    amount: string;
    paymentId: string;
    metadata?: Record<string, unknown>;
  }): Promise<{ account: CreditAccountRecord; entry: CreditLedgerEntryRecord }>;
  getCreditTopupByPaymentId(
    serviceId: string,
    paymentId: string
  ): Promise<{ account: CreditAccountRecord; entry: CreditLedgerEntryRecord } | null>;
  getCreditAccount(serviceId: string, buyerWallet: string, currency: MarketplaceTokenSymbol): Promise<CreditAccountRecord | null>;
  reserveCredit(input: {
    serviceId: string;
    buyerWallet: string;
    currency: MarketplaceTokenSymbol;
    amount: string;
    idempotencyKey: string;
    jobToken?: string | null;
    providerReference?: string | null;
    expiresAt: string;
    metadata?: Record<string, unknown>;
  }): Promise<{ account: CreditAccountRecord; reservation: CreditReservationRecord; entry: CreditLedgerEntryRecord }>;
  captureCreditReservation(input: {
    reservationId: string;
    amount: string;
    metadata?: Record<string, unknown>;
  }): Promise<{
    account: CreditAccountRecord;
    reservation: CreditReservationRecord;
    captureEntry: CreditLedgerEntryRecord;
    releaseEntry: CreditLedgerEntryRecord | null;
  }>;
  releaseCreditReservation(input: {
    reservationId: string;
    metadata?: Record<string, unknown>;
  }): Promise<{ account: CreditAccountRecord; reservation: CreditReservationRecord; entry: CreditLedgerEntryRecord | null }>;
  expireCreditReservation(reservationId: string): Promise<{
    account: CreditAccountRecord;
    reservation: CreditReservationRecord;
    entry: CreditLedgerEntryRecord | null;
  }>;
  getCreditReservationById(reservationId: string): Promise<CreditReservationRecord | null>;
  getCreditReservationByIdempotencyKey(serviceId: string, idempotencyKey: string): Promise<CreditReservationRecord | null>;
  getCreditReservationByJobToken(serviceId: string, jobToken: string): Promise<CreditReservationRecord | null>;
  listExpiredCreditReservations(limit: number, expiresBefore?: string): Promise<CreditReservationRecord[]>;
  extendCreditReservation(input: {
    reservationId: string;
    expiresAt: string;
  }): Promise<{ account: CreditAccountRecord; reservation: CreditReservationRecord }>;
  rotateProviderRuntimeKey(serviceId: string, wallet: string, secretMaterial: {
    keyHash: string;
    keyPrefix: string;
    ciphertext: string;
    iv: string;
    authTag: string;
  }): Promise<ProviderRuntimeKeyRecord>;
  getProviderRuntimeKeyForOwner(serviceId: string, wallet: string): Promise<ProviderRuntimeKeyRecord | null>;
  getProviderRuntimeKeyByPlaintext(plaintextKey: string): Promise<ProviderRuntimeKeyRecord | null>;
  getServiceAnalytics(routeIds: string[]): Promise<ServiceAnalytics>;
  listPublishedServices(): Promise<PublishedServiceVersionRecord[]>;
  getPublishedServiceBySlug(slug: string): Promise<{
    service: PublishedServiceVersionRecord;
    endpoints: PublishedServiceEndpointVersionRecord[];
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
  getSubmittedProviderService(serviceId: string): Promise<ProviderServiceDetailRecord | null>;
  requestProviderServiceChanges(
    serviceId: string,
    input: { reviewNotes: string; reviewerIdentity?: string | null }
  ): Promise<ProviderServiceDetailRecord | null>;
  publishProviderService(
    serviceId: string,
    input?: { reviewerIdentity?: string | null; settlementMode?: SettlementMode | null; submittedVersionId?: string | null }
  ): Promise<ProviderServiceDetailRecord | null>;
  updateProviderServiceSettlementMode(
    serviceId: string,
    input: {
      settlementMode: SettlementMode;
      reviewerIdentity?: string | null;
      submittedVersionId?: string | null;
      publishedVersionId?: string | null;
    }
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
