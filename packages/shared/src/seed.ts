import type {
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
  websiteUrl: "https://fast.8o.vc",
  contactEmail: "operators@fast.8o.vc",
  createdAt: SEEDED_AT,
  updatedAt: SEEDED_AT
};

export const MOCK_PROVIDER_SERVICE_SEED: ProviderServiceRecord = {
  id: "service_mock_research_signals",
  providerAccountId: MARKETPLACE_PROVIDER_ACCOUNT_SEED.id,
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
  websiteUrl: "https://fast.8o.vc",
  payoutWallet: null,
  featured: true,
  status: "published",
  createdAt: SEEDED_AT,
  updatedAt: SEEDED_AT
};

export const TAVILY_PROVIDER_SERVICE_SEED: ProviderServiceRecord = {
  id: "service_tavily_search",
  providerAccountId: MARKETPLACE_PROVIDER_ACCOUNT_SEED.id,
  slug: "tavily-search",
  apiNamespace: "tavily",
  name: "Tavily Search",
  tagline: "Marketplace-operated Tavily web search with Fast-native payment rails.",
  about:
    "Tavily Search is a marketplace-operated paid web search endpoint backed by Tavily. It returns Tavily search results through the Fast Marketplace so agents can buy current web research with the same x402 flow used across the catalog.",
  categories: ["Search", "Research", "Developer Tools"],
  promptIntro: 'I want to use the "Tavily Search" service on Fast Marketplace.',
  setupInstructions: [
    "Review the Fast Marketplace skill and wallet setup instructions.",
    "Use the x402-paid trigger route below from a funded Fast wallet.",
    "Send Tavily-compatible JSON to the marketplace route and the response body will mirror Tavily's search API."
  ],
  websiteUrl: "https://fast.8o.vc",
  payoutWallet: null,
  featured: true,
  status: "published",
  createdAt: SEEDED_AT,
  updatedAt: SEEDED_AT
};

const TAVILY_COUNTRY_OPTIONS = [
  "afghanistan",
  "albania",
  "algeria",
  "andorra",
  "angola",
  "argentina",
  "armenia",
  "australia",
  "austria",
  "azerbaijan",
  "bahamas",
  "bahrain",
  "bangladesh",
  "barbados",
  "belarus",
  "belgium",
  "belize",
  "benin",
  "bhutan",
  "bolivia",
  "bosnia and herzegovina",
  "botswana",
  "brazil",
  "brunei",
  "bulgaria",
  "burkina faso",
  "burundi",
  "cambodia",
  "cameroon",
  "canada",
  "cape verde",
  "central african republic",
  "chad",
  "chile",
  "china",
  "colombia",
  "comoros",
  "congo",
  "costa rica",
  "croatia",
  "cuba",
  "cyprus",
  "czech republic",
  "denmark",
  "djibouti",
  "dominican republic",
  "ecuador",
  "egypt",
  "el salvador",
  "equatorial guinea",
  "eritrea",
  "estonia",
  "ethiopia",
  "fiji",
  "finland",
  "france",
  "gabon",
  "gambia",
  "georgia",
  "germany",
  "ghana",
  "greece",
  "guatemala",
  "guinea",
  "haiti",
  "honduras",
  "hungary",
  "iceland",
  "india",
  "indonesia",
  "iran",
  "iraq",
  "ireland",
  "israel",
  "italy",
  "jamaica",
  "japan",
  "jordan",
  "kazakhstan",
  "kenya",
  "kuwait",
  "kyrgyzstan",
  "latvia",
  "lebanon",
  "lesotho",
  "liberia",
  "libya",
  "liechtenstein",
  "lithuania",
  "luxembourg",
  "madagascar",
  "malawi",
  "malaysia",
  "maldives",
  "mali",
  "malta",
  "mauritania",
  "mauritius",
  "mexico",
  "moldova",
  "monaco",
  "mongolia",
  "montenegro",
  "morocco",
  "mozambique",
  "myanmar",
  "namibia",
  "nepal",
  "netherlands",
  "new zealand",
  "nicaragua",
  "niger",
  "nigeria",
  "north korea",
  "north macedonia",
  "norway",
  "oman",
  "pakistan",
  "panama",
  "papua new guinea",
  "paraguay",
  "peru",
  "philippines",
  "poland",
  "portugal",
  "qatar",
  "romania",
  "russia",
  "rwanda",
  "saudi arabia",
  "senegal",
  "serbia",
  "singapore",
  "slovakia",
  "slovenia",
  "somalia",
  "south africa",
  "south korea",
  "south sudan",
  "spain",
  "sri lanka",
  "sudan",
  "sweden",
  "switzerland",
  "syria",
  "taiwan",
  "tajikistan",
  "tanzania",
  "thailand",
  "togo",
  "trinidad and tobago",
  "tunisia",
  "turkey",
  "turkmenistan",
  "uganda",
  "ukraine",
  "united arab emirates",
  "united kingdom",
  "united states",
  "uruguay",
  "uzbekistan",
  "venezuela",
  "vietnam",
  "yemen",
  "zambia",
  "zimbabwe"
] as const;

function buildQuickInsightRoute(config: MarketplaceNetworkConfig): MarketplaceRoute {
  return {
    routeId: "mock.quick-insight.v1",
    provider: "mock",
    operation: "quick-insight",
    version: "v1",
    mode: "sync",
    network: config.paymentNetwork,
    price: "$0.05",
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
    mode: "async",
    network: config.paymentNetwork,
    price: "$0.15",
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

function buildTavilySearchRoute(config: MarketplaceNetworkConfig): MarketplaceRoute {
  return {
    routeId: "tavily.search.v1",
    provider: "tavily",
    operation: "search",
    version: "v1",
    mode: "sync",
    network: config.paymentNetwork,
    price: "$0.05",
    title: "Search",
    description: "Run a paid Tavily web search and return Tavily-formatted results.",
    requestExample: {
      query: "latest Fast blockchain updates",
      topic: "general",
      search_depth: "basic",
      max_results: 5,
      country: "united states",
      include_answer: "basic",
      auto_parameters: false,
      exact_match: false,
      include_usage: true
    },
    responseExample: {
      query: "latest Fast blockchain updates",
      answer: "Recent Fast updates center on ecosystem launches and marketplace tooling progress.",
      images: [],
      results: [
        {
          title: "Fast ecosystem update",
          url: "https://fast.8o.vc/blog/ecosystem-update",
          content: "Fast shipped new marketplace and wallet tooling for agent-native payments.",
          score: 0.91,
          favicon: "https://fast.8o.vc/favicon.ico"
        }
      ],
      response_time: 1.12,
      auto_parameters: {
        topic: "news",
        search_depth: "basic"
      },
      usage: {
        credits: 1
      },
      request_id: "123e4567-e89b-12d3-a456-426614174111"
    },
    usageNotes:
      "This route forwards the documented Tavily Search body fields. Enterprise-only flags such as safe_search are passed through as-is and may be rejected by Tavily depending on your account tier.",
    requestSchemaJson: {
      type: "object",
      properties: {
        query: {
          type: "string",
          minLength: 1,
          maxLength: 400
        },
        search_depth: {
          type: "string",
          enum: ["advanced", "basic", "fast", "ultra-fast"]
        },
        chunks_per_source: {
          type: "integer",
          minimum: 1,
          maximum: 3
        },
        max_results: {
          type: "integer",
          minimum: 0,
          maximum: 20
        },
        topic: {
          type: "string",
          enum: ["general", "news", "finance"]
        },
        time_range: {
          type: "string",
          enum: ["day", "week", "month", "year", "d", "w", "m", "y"]
        },
        start_date: {
          type: "string",
          pattern: "^\\d{4}-\\d{2}-\\d{2}$"
        },
        end_date: {
          type: "string",
          pattern: "^\\d{4}-\\d{2}-\\d{2}$"
        },
        include_answer: {
          oneOf: [{ type: "boolean" }, { type: "string", enum: ["basic", "advanced"] }]
        },
        include_raw_content: {
          oneOf: [{ type: "boolean" }, { type: "string", enum: ["markdown", "text"] }]
        },
        include_images: {
          type: "boolean"
        },
        include_image_descriptions: {
          type: "boolean"
        },
        include_favicon: {
          type: "boolean"
        },
        include_domains: {
          type: "array",
          items: {
            type: "string",
            minLength: 1
          },
          maxItems: 300
        },
        exclude_domains: {
          type: "array",
          items: {
            type: "string",
            minLength: 1
          },
          maxItems: 150
        },
        country: {
          type: "string",
          enum: TAVILY_COUNTRY_OPTIONS
        },
        auto_parameters: {
          type: "boolean"
        },
        exact_match: {
          type: "boolean"
        },
        include_usage: {
          type: "boolean"
        },
        safe_search: {
          type: "boolean"
        }
      },
      allOf: [
        {
          if: {
            required: ["country"]
          },
          then: {
            not: {
              properties: {
                topic: {
                  not: {
                    const: "general"
                  }
                }
              },
              required: ["topic"]
            }
          }
        },
        {
          if: {
            required: ["chunks_per_source"]
          },
          then: {
            properties: {
              search_depth: {
                const: "advanced"
              }
            },
            required: ["search_depth"]
          }
        },
        {
          if: {
            properties: {
              include_image_descriptions: {
                const: true
              }
            },
            required: ["include_image_descriptions"]
          },
          then: {
            properties: {
              include_images: {
                const: true
              }
            },
            required: ["include_images"]
          }
        },
        {
          if: {
            properties: {
              safe_search: {
                const: true
              }
            },
            required: ["safe_search"]
          },
          then: {
            not: {
              properties: {
                search_depth: {
                  enum: ["fast", "ultra-fast"]
                }
              },
              required: ["search_depth"]
            }
          }
        }
      ],
      required: ["query"],
      additionalProperties: false
    },
    responseSchemaJson: {
      type: "object",
      properties: {
        query: { type: "string" },
        answer: { type: "string" },
        images: {
          type: "array",
          items: {
            type: "object",
            properties: {
              url: { type: "string" },
              description: { type: "string" }
            },
            additionalProperties: true
          }
        },
        results: {
          type: "array",
          items: {
            type: "object",
            properties: {
              title: { type: "string" },
              url: { type: "string" },
              content: { type: "string" },
              score: { type: "number" },
              raw_content: { type: ["string", "null"] },
              favicon: { type: ["string", "null"] }
            },
            required: ["title", "url"],
            additionalProperties: true
          }
        },
        response_time: {
          oneOf: [{ type: "number" }, { type: "string" }]
        },
        auto_parameters: {
          type: "object",
          additionalProperties: true
        },
        usage: {
          type: "object",
          additionalProperties: true
        },
        request_id: { type: "string" }
      },
      required: ["query", "results"],
      additionalProperties: true
    },
    payout: {
      providerAccountId: MARKETPLACE_PROVIDER_ACCOUNT_SEED.id,
      providerWallet: null,
      providerBps: 0
    },
    executorKind: "tavily",
    upstreamBaseUrl: null,
    upstreamPath: null,
    upstreamAuthMode: "none",
    upstreamAuthHeaderName: null,
    upstreamSecretRef: null
  };
}

export const MARKETPLACE_PROVIDER_SERVICE_SEEDS: ProviderServiceRecord[] = [
  MOCK_PROVIDER_SERVICE_SEED,
  TAVILY_PROVIDER_SERVICE_SEED
];

function buildProviderEndpointDraft(serviceId: string, route: MarketplaceRoute): ProviderEndpointDraftRecord {
  return {
    id: `draft_${route.routeId}`,
    serviceId,
    routeId: route.routeId,
    operation: route.operation,
    title: route.title,
    description: route.description,
    price: route.price,
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
  const tavilyRoutes = [buildTavilySearchRoute(config)];

  return [
    {
      service: MOCK_PROVIDER_SERVICE_SEED,
      publishedService: buildPublishedServiceVersion({
        service: MOCK_PROVIDER_SERVICE_SEED,
        routeIds: mockRoutes.map((route) => route.routeId),
        versionId: "published_service_mock_research_signals_v1"
      }),
      routes: mockRoutes
    },
    {
      service: TAVILY_PROVIDER_SERVICE_SEED,
      publishedService: buildPublishedServiceVersion({
        service: TAVILY_PROVIDER_SERVICE_SEED,
        routeIds: tavilyRoutes.map((route) => route.routeId),
        versionId: "published_service_tavily_search_v1"
      }),
      routes: tavilyRoutes
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
        endpointVersionId: `published_${draft.routeId}`,
        serviceId: draft.serviceId,
        serviceVersionId: group.publishedService.versionId,
        endpointDraftId: draft.id,
        routeId: draft.routeId,
        provider: group.publishedService.apiNamespace,
        operation: draft.operation,
        version: "v1",
        mode: draft.mode,
        network: config.paymentNetwork,
        price: draft.price,
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
