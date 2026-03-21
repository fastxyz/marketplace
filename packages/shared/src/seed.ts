import type {
  MarketplaceProviderEndpointDraftRecord,
  MarketplaceRoute,
  ProviderAccountRecord,
  ProviderEndpointDraftRecord,
  ProviderServiceRecord,
  PublishedEndpointVersionRecord,
  PublishedServiceVersionRecord
} from "./types.js";
import type { MarketplaceNetworkConfig } from "./network.js";
import { getDefaultMarketplaceNetworkConfig } from "./network.js";

const SEEDED_AT = "2026-03-19T00:00:00.000Z";

export const MARKETPLACE_PROVIDER_ACCOUNT_SEED: ProviderAccountRecord = {
  id: "provider_marketplace",
  ownerWallet: "fast1marketplaceowner000000000000000000000000000000000000000000",
  displayName: "Fast Marketplace",
  bio: "Marketplace-owned sandbox services for testing x402 payment flows.",
  websiteUrl: "https://marketplace.example.com",
  contactEmail: "contact@example.com",
  createdAt: SEEDED_AT,
  updatedAt: SEEDED_AT
};

export const MOCK_PROVIDER_SERVICE_SEED: ProviderServiceRecord = {
  id: "service_mock_research_signals",
  providerAccountId: MARKETPLACE_PROVIDER_ACCOUNT_SEED.id,
  serviceType: "marketplace_proxy",
  settlementMode: "verified_escrow",
  slug: "mock-research-signals",
  apiNamespace: "mock",
  name: "Mock Research Signals",
  tagline: "Synthetic paid research endpoints for testing Fast-native agent purchases.",
  about:
    "Mock Research Signals is the sandbox service for the Fast Marketplace. It gives buyers a paid sync endpoint for instant insights and a paid async endpoint for longer-running reports, so wallets, x402 retries, polling, and refunds can all be tested against a stable surface.",
  categories: ["Research", "Testing", "Developer Tools"],
  promptIntro: 'I want to use the "Mock Research Signals" service on Fast Marketplace.',
  setupInstructions: [
    "Review the Fast Marketplace skill and wallet setup instructions.",
    "Use the x402-paid trigger routes below from a funded Fast wallet.",
    "For async routes, keep the returned job token and poll the result later from the same wallet."
  ],
  websiteUrl: "https://marketplace.example.com",
  payoutWallet: null,
  featured: true,
  status: "published",
  createdAt: SEEDED_AT,
  updatedAt: SEEDED_AT
};

function buildQuickInsightRoute(config: MarketplaceNetworkConfig): MarketplaceRoute {
  return {
    routeId: "mock.quick-insight.v1",
    provider: "mock",
    operation: "quick-insight",
    version: "v1",
    method: "POST",
    settlementMode: "verified_escrow",
    mode: "sync",
    network: config.paymentNetwork,
    price: "$0.05",
    billing: {
      type: "fixed_x402",
      price: "$0.05"
    },
    title: "Quick Insight",
    description: "Return a paid single-shot mock insight response.",
    requestExample: {
      query: "fast-native data marketplaces"
    },
    responseExample: {
      provider: "mock",
      operation: "quick-insight",
      query: "fast-native data marketplaces",
      summary: "Mock alpha signal for fast-native data marketplaces.",
      generatedAt: "2026-03-18T00:00:00.000Z"
    },
    usageNotes: "Use this for low-latency paid lookups that should resolve in a single round trip.",
    requestSchemaJson: {
      type: "object",
      properties: {
        query: {
          type: "string",
          minLength: 1,
          maxLength: 240
        }
      },
      required: ["query"],
      additionalProperties: false
    },
    responseSchemaJson: {
      type: "object",
      properties: {
        provider: { type: "string", const: "mock" },
        operation: { type: "string", const: "quick-insight" },
        query: { type: "string" },
        summary: { type: "string" },
        generatedAt: { type: "string" }
      },
      required: ["provider", "operation", "query", "summary", "generatedAt"],
      additionalProperties: false
    },
    payout: {
      providerAccountId: MARKETPLACE_PROVIDER_ACCOUNT_SEED.id,
      providerWallet: null,
      providerBps: 0
    },
    executorKind: "mock",
    upstreamBaseUrl: null,
    upstreamPath: null,
    upstreamAuthMode: "none",
    upstreamAuthHeaderName: null,
    upstreamSecretRef: null
  };
}

function buildAsyncReportRoute(config: MarketplaceNetworkConfig): MarketplaceRoute {
  return {
    routeId: "mock.async-report.v1",
    provider: "mock",
    operation: "async-report",
    version: "v1",
    method: "POST",
    settlementMode: "verified_escrow",
    mode: "async",
    network: config.paymentNetwork,
    price: "$0.15",
    billing: {
      type: "fixed_x402",
      price: "$0.15"
    },
    title: "Async Report",
    description: "Create a paid async mock report job and return a job token.",
    requestExample: {
      topic: "consumer AI distribution shifts",
      delayMs: 5000
    },
    responseExample: {
      provider: "mock",
      operation: "async-report",
      topic: "consumer AI distribution shifts",
      report: "Mock report body for consumer AI distribution shifts.",
      completedAt: "2026-03-18T00:00:05.000Z"
    },
    usageNotes:
      "Use this when the upstream data source has variable latency and the result should be polled asynchronously.",
    requestSchemaJson: {
      type: "object",
      properties: {
        topic: {
          type: "string",
          minLength: 1,
          maxLength: 240
        },
        delayMs: {
          type: "integer",
          minimum: 1000,
          maximum: 60000
        },
        shouldFail: {
          type: "boolean"
        }
      },
      required: ["topic"],
      additionalProperties: false
    },
    responseSchemaJson: {
      type: "object",
      properties: {
        provider: { type: "string", const: "mock" },
        operation: { type: "string", const: "async-report" },
        topic: { type: "string" },
        report: { type: "string" },
        completedAt: { type: "string" }
      },
      required: ["provider", "operation", "topic", "report", "completedAt"],
      additionalProperties: false
    },
    payout: {
      providerAccountId: MARKETPLACE_PROVIDER_ACCOUNT_SEED.id,
      providerWallet: null,
      providerBps: 0
    },
    executorKind: "mock",
    upstreamBaseUrl: null,
    upstreamPath: null,
    upstreamAuthMode: "none",
    upstreamAuthHeaderName: null,
    upstreamSecretRef: null
  };
}

export const MARKETPLACE_PROVIDER_SERVICE_SEEDS: ProviderServiceRecord[] = [
  MOCK_PROVIDER_SERVICE_SEED
];

function buildProviderEndpointDraft(serviceId: string, route: MarketplaceRoute): MarketplaceProviderEndpointDraftRecord {
  return {
    endpointType: "marketplace_proxy",
    id: `draft_${route.routeId}`,
    serviceId,
    routeId: route.routeId,
    operation: route.operation,
    method: route.method,
    title: route.title,
    description: route.description,
    price: route.price,
    billing: structuredClone(route.billing),
    mode: route.mode,
    requestSchemaJson: structuredClone(route.requestSchemaJson),
    responseSchemaJson: structuredClone(route.responseSchemaJson),
    requestExample: structuredClone(route.requestExample),
    responseExample: structuredClone(route.responseExample),
    usageNotes: route.usageNotes ?? null,
    executorKind: route.executorKind,
    upstreamBaseUrl: route.upstreamBaseUrl ?? null,
    upstreamPath: route.upstreamPath ?? null,
    upstreamAuthMode: route.upstreamAuthMode ?? null,
    upstreamAuthHeaderName: route.upstreamAuthHeaderName ?? null,
    upstreamSecretRef: route.upstreamSecretRef ?? null,
    hasUpstreamSecret: false,
    payout: {
      ...route.payout
    },
    createdAt: SEEDED_AT,
    updatedAt: SEEDED_AT
  };
}

function buildPublishedServiceVersion(input: {
  service: ProviderServiceRecord;
  routeIds: string[];
  versionId: string;
}): PublishedServiceVersionRecord {
  return {
    versionId: input.versionId,
    serviceId: input.service.id,
    providerAccountId: input.service.providerAccountId,
    settlementMode: input.service.settlementMode,
    serviceType: input.service.serviceType,
    slug: input.service.slug,
    apiNamespace: input.service.apiNamespace,
    name: input.service.name,
    ownerName: MARKETPLACE_PROVIDER_ACCOUNT_SEED.displayName,
    tagline: input.service.tagline,
    about: input.service.about,
    categories: [...input.service.categories],
    routeIds: [...input.routeIds],
    featured: input.service.featured,
    promptIntro: input.service.promptIntro,
    setupInstructions: [...input.service.setupInstructions],
    websiteUrl: input.service.websiteUrl,
    contactEmail: MARKETPLACE_PROVIDER_ACCOUNT_SEED.contactEmail,
    payoutWallet: input.service.payoutWallet,
    status: "published",
    submittedReviewId: null,
    publishedAt: SEEDED_AT,
    createdAt: SEEDED_AT,
    updatedAt: SEEDED_AT
  };
}

function buildSeededServiceGroups(config: MarketplaceNetworkConfig) {
  const mockRoutes = [buildQuickInsightRoute(config), buildAsyncReportRoute(config)];

  return [
    {
      service: MOCK_PROVIDER_SERVICE_SEED,
      publishedService: buildPublishedServiceVersion({
        service: MOCK_PROVIDER_SERVICE_SEED,
        routeIds: mockRoutes.map((route) => route.routeId),
        versionId: "published_service_mock_research_signals_v1"
      }),
      routes: mockRoutes
    }
  ];
}

export function buildSeededMarketplaceRoutes(
  config: MarketplaceNetworkConfig = getDefaultMarketplaceNetworkConfig()
): MarketplaceRoute[] {
  return buildSeededServiceGroups(config).flatMap((group) => group.routes.map((route) => structuredClone(route)));
}

export function buildSeededProviderEndpointDrafts(
  config: MarketplaceNetworkConfig = getDefaultMarketplaceNetworkConfig()
): ProviderEndpointDraftRecord[] {
  return buildSeededServiceGroups(config).flatMap((group) =>
    group.routes.map((route) => buildProviderEndpointDraft(group.service.id, route))
  );
}

export function buildSeededPublishedServiceVersions(
  config: MarketplaceNetworkConfig = getDefaultMarketplaceNetworkConfig()
): PublishedServiceVersionRecord[] {
  return buildSeededServiceGroups(config).map((group) => structuredClone(group.publishedService));
}

export function buildSeededPublishedEndpointVersions(
  config: MarketplaceNetworkConfig = getDefaultMarketplaceNetworkConfig()
): PublishedEndpointVersionRecord[] {
  return buildSeededServiceGroups(config).flatMap((group) =>
    group.routes.map((route) => {
      const draft = buildProviderEndpointDraft(group.service.id, route);

      return {
        endpointType: "marketplace_proxy",
        endpointVersionId: `published_${draft.routeId}`,
        serviceId: draft.serviceId,
        serviceVersionId: group.publishedService.versionId,
        endpointDraftId: draft.id,
        routeId: draft.routeId,
        provider: group.publishedService.apiNamespace ?? "unknown",
        operation: draft.operation,
        version: "v1",
        method: draft.method,
        settlementMode: group.publishedService.settlementMode ?? "verified_escrow",
        mode: draft.mode,
        network: config.paymentNetwork,
        price: draft.price,
        billing: structuredClone(draft.billing),
        title: draft.title,
        description: draft.description,
        payout: {
          ...draft.payout
        },
        requestExample: structuredClone(draft.requestExample),
        responseExample: structuredClone(draft.responseExample),
        usageNotes: draft.usageNotes ?? undefined,
        requestSchemaJson: structuredClone(draft.requestSchemaJson),
        responseSchemaJson: structuredClone(draft.responseSchemaJson),
        executorKind: draft.executorKind,
        upstreamBaseUrl: draft.upstreamBaseUrl,
        upstreamPath: draft.upstreamPath,
        upstreamAuthMode: draft.upstreamAuthMode,
        upstreamAuthHeaderName: draft.upstreamAuthHeaderName,
        upstreamSecretRef: draft.upstreamSecretRef,
        createdAt: SEEDED_AT,
        updatedAt: SEEDED_AT
      };
    })
  );
}
