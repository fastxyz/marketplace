import type {
  ExternalProviderEndpointDraftRecord,
  MarketplaceProviderEndpointDraftRecord,
  MarketplaceRoute,
  ProviderAccountRecord,
  ProviderEndpointDraftRecord,
  PublishedExternalEndpointVersionRecord,
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

export const SHOP_FAST_SERVICE_SEED: ProviderServiceRecord = {
  id: "service_shop_fast_amazon",
  providerAccountId: MARKETPLACE_PROVIDER_ACCOUNT_SEED.id,
  serviceType: "external_registry",
  settlementMode: null,
  slug: "shop-fast-amazon",
  apiNamespace: null,
  name: "Shop Fast Amazon",
  tagline: "Amazon product discovery and quote endpoints for USDC purchases on Fast.",
  about:
    "Shop Fast Amazon is the commerce surface for buying Amazon items with USDC on the Fast network. The marketplace lists the search and quote operations as discovery-only endpoints until commerce quote, consent, order, and fulfillment records are first-class marketplace primitives.",
  categories: ["Commerce", "Shopping", "Fast"],
  featured: true,
  promptIntro: 'I want to use the "Shop Fast Amazon" service.',
  setupInstructions: [
    "Use amazon-search to find Amazon products by query.",
    "Use amazon-quote to price a selected product before purchase.",
    "Do not use amazon-buy through the marketplace until quote, consent, and order records are supported."
  ],
  websiteUrl: "https://shop.fast.xyz",
  payoutWallet: null,
  status: "published",
  createdAt: SEEDED_AT,
  updatedAt: SEEDED_AT
};

export const SHOP_FAST_EXECUTION_SERVICE_SEED: ProviderServiceRecord = {
  id: "service_shop_fast_amazon_execution",
  providerAccountId: MARKETPLACE_PROVIDER_ACCOUNT_SEED.id,
  serviceType: "marketplace_proxy",
  settlementMode: "verified_escrow",
  slug: "shop-fast-amazon-execute",
  apiNamespace: "shop-fast-amazon",
  name: "Shop Fast Amazon Execute",
  tagline: "Quote-bound Amazon purchases executed through Fast Marketplace records.",
  about:
    "Shop Fast Amazon Execute creates marketplace-held quote, consent, order, and fulfillment records around Shop Fast Amazon purchases. Use the free quote route first, then submit buyer consent and x402 payment to the buy route.",
  categories: ["Commerce", "Shopping", "Fast"],
  featured: true,
  promptIntro: 'I want to execute an Amazon purchase through "Shop Fast Amazon Execute".',
  setupInstructions: [
    "Call amazon-quote to create a marketplace-saved quote.",
    "Review the quote response and collect explicit buyer consent.",
    "Call amazon-buy with the quoteId and buyerConsent using x402 payment for the quote amount."
  ],
  websiteUrl: "https://shop.fast.xyz",
  payoutWallet: null,
  status: "published",
  createdAt: SEEDED_AT,
  updatedAt: SEEDED_AT
};

export const SHOPIFY_STOREFRONT_SERVICE_SEED: ProviderServiceRecord = {
  id: "service_shopify_storefront",
  providerAccountId: MARKETPLACE_PROVIDER_ACCOUNT_SEED.id,
  serviceType: "external_registry",
  settlementMode: null,
  slug: "shopify-storefront",
  apiNamespace: null,
  name: "Shopify Storefront",
  tagline: "Shop-specific Storefront GraphQL commerce primitives for product discovery, cart, and checkout.",
  about:
    "Shopify Storefront is a discovery-only listing for Shopify's Storefront GraphQL API. Each Shopify merchant exposes a shop-specific endpoint for querying products and collections, adding items to cart, calculating contextual pricing, and starting checkout flows.",
  categories: ["Commerce", "Shopping", "UCP", "Checkout"],
  featured: true,
  promptIntro: 'I want to use the "Shopify Storefront" commerce API.',
  setupInstructions: [
    "Replace {store_name} with the merchant's Shopify store subdomain.",
    "Use POST GraphQL requests against the Storefront API endpoint.",
    "Use a Storefront access token when the merchant requires token-based access.",
    "Do not execute checkout through the marketplace until merchant-specific quote, consent, order, and fulfillment records are wired."
  ],
  websiteUrl: "https://shopify.dev/docs/api/storefront",
  payoutWallet: null,
  status: "published",
  createdAt: SEEDED_AT,
  updatedAt: SEEDED_AT
};

export const SEEDED_PROVIDER_SERVICE_IDS = [
  MOCK_PROVIDER_SERVICE_SEED.id,
  SHOP_FAST_SERVICE_SEED.id,
  SHOP_FAST_EXECUTION_SERVICE_SEED.id,
  SHOPIFY_STOREFRONT_SERVICE_SEED.id
];

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
    price: "$0.0001",
    billing: {
      type: "fixed_x402",
      price: "$0.0001"
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
    asyncConfig: null,
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
    price: "$0.0001",
    billing: {
      type: "fixed_x402",
      price: "$0.0001"
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
    asyncConfig: {
      strategy: "poll",
      timeoutMs: 60_000,
      pollPath: "/mock/poll"
    },
    upstreamBaseUrl: null,
    upstreamPath: null,
    upstreamAuthMode: "none",
    upstreamAuthHeaderName: null,
    upstreamSecretRef: null
  };
}

function buildShopFastAmazonQuoteRoute(config: MarketplaceNetworkConfig): MarketplaceRoute {
  return {
    routeId: "shop-fast-amazon.amazon-quote.v1",
    provider: "shop-fast-amazon",
    operation: "amazon-quote",
    version: "v1",
    method: "POST",
    settlementMode: "verified_escrow",
    mode: "sync",
    network: config.paymentNetwork,
    price: "Free",
    billing: {
      type: "free"
    },
    title: "Amazon Quote",
    description: "Create and save a marketplace quote for an Amazon purchase through Shop Fast.",
    requestExample: {
      productId: "B000EXAMPLE",
      quantity: 1,
      shipToCountry: "US",
      paymentCurrency: "USDC"
    },
    responseExample: {
      quoteId: "quote_example",
      expiresAt: "2026-03-19T00:15:00.000Z",
      payment: {
        amount: "24.99",
        currency: "USDC",
        network: "fast"
      }
    },
    usageNotes: "The returned quoteId is persisted by the marketplace and required by amazon-buy.",
    requestSchemaJson: {
      type: "object",
      properties: {
        productId: { type: "string", minLength: 1 },
        quantity: { type: "integer", minimum: 1 },
        shipToCountry: { type: "string", minLength: 2, maxLength: 2 },
        paymentCurrency: { type: "string", const: "USDC" }
      },
      required: ["productId", "quantity", "shipToCountry", "paymentCurrency"],
      additionalProperties: true
    },
    responseSchemaJson: {
      type: "object",
      properties: {
        quoteId: { type: "string" },
        expiresAt: { type: "string" },
        payment: {
          type: "object",
          properties: {
            amount: { type: "string" },
            currency: { type: "string" },
            network: { type: "string" }
          },
          required: ["amount", "currency"]
        }
      },
      required: ["quoteId", "payment"],
      additionalProperties: true
    },
    payout: {
      providerAccountId: MARKETPLACE_PROVIDER_ACCOUNT_SEED.id,
      providerWallet: null,
      providerBps: 0
    },
    executorKind: "http",
    asyncConfig: null,
    upstreamBaseUrl: "https://shop.fast.xyz",
    upstreamPath: "/api/amazon/quote",
    upstreamAuthMode: "none",
    upstreamAuthHeaderName: null,
    upstreamSecretRef: null
  };
}

function buildShopFastAmazonBuyRoute(config: MarketplaceNetworkConfig): MarketplaceRoute {
  return {
    routeId: "shop-fast-amazon.amazon-buy.v1",
    provider: "shop-fast-amazon",
    operation: "amazon-buy",
    version: "v1",
    method: "POST",
    settlementMode: "verified_escrow",
    mode: "sync",
    network: config.paymentNetwork,
    price: "Quote-bound",
    billing: {
      type: "commerce_quote_x402"
    },
    title: "Amazon Buy",
    description: "Place an Amazon purchase through Shop Fast after a saved quote and explicit buyer consent.",
    requestExample: {
      quoteId: "quote_example",
      buyerConsent: {
        accepted: true,
        acceptedAt: "2026-03-19T00:10:00.000Z"
      }
    },
    responseExample: {
      orderId: "order_example",
      status: "pending",
      fulfillment: {
        status: "pending_shipment"
      }
    },
    usageNotes:
      "Requires a quote created by amazon-quote. The marketplace records consent, order, and fulfillment state around the upstream purchase request.",
    requestSchemaJson: {
      type: "object",
      properties: {
        quoteId: { type: "string", minLength: 1 },
        buyerConsent: {
          type: "object",
          properties: {
            accepted: { type: "boolean", const: true },
            acceptedAt: { type: "string" }
          },
          required: ["accepted"]
        }
      },
      required: ["quoteId", "buyerConsent"],
      additionalProperties: true
    },
    responseSchemaJson: {
      type: "object",
      properties: {
        orderId: { type: "string" },
        status: { type: "string" },
        fulfillment: { type: "object" }
      },
      required: ["orderId", "status"],
      additionalProperties: true
    },
    payout: {
      providerAccountId: MARKETPLACE_PROVIDER_ACCOUNT_SEED.id,
      providerWallet: null,
      providerBps: 0
    },
    executorKind: "http",
    asyncConfig: null,
    upstreamBaseUrl: "https://shop.fast.xyz",
    upstreamPath: "/api/amazon/buy",
    upstreamAuthMode: "none",
    upstreamAuthHeaderName: null,
    upstreamSecretRef: null
  };
}

function shouldSeedMarketplaceMocks(config: MarketplaceNetworkConfig): boolean {
  return config.deploymentNetwork === "testnet";
}

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
    asyncConfig: structuredClone(route.asyncConfig ?? null),
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

function buildShopFastExternalEndpointDrafts(): ExternalProviderEndpointDraftRecord[] {
  return [
    buildExternalEndpointDraft({
      id: "draft_shop_fast_amazon_search",
      title: "Amazon Search",
      description: "Search Amazon products through Shop Fast before requesting a purchase quote.",
      publicUrl: "https://shop.fast.xyz/api/amazon/search",
      requestExample: {
        query: "usb-c charger",
        country: "US"
      },
      responseExample: {
        products: [
          {
            id: "B000EXAMPLE",
            title: "Example USB-C Charger",
            price: {
              amount: 1999,
              currency: "USD"
            }
          }
        ]
      },
      usageNotes: "Use the returned product identifier with amazon-quote before any purchase attempt."
    }),
    buildExternalEndpointDraft({
      id: "draft_shop_fast_amazon_quote",
      title: "Amazon Quote",
      description: "Create a purchase quote for an Amazon product before buyer consent and payment.",
      publicUrl: "https://shop.fast.xyz/api/amazon/quote",
      requestExample: {
        productId: "B000EXAMPLE",
        quantity: 1,
        shipToCountry: "US",
        paymentCurrency: "USDC"
      },
      responseExample: {
        quoteId: "quote_example",
        expiresAt: "2026-03-19T00:15:00.000Z",
        total: {
          amount: 2499,
          currency: "USD"
        },
        payment: {
          amount: "24.99",
          currency: "USDC",
          network: "fast"
        }
      },
      usageNotes: "Treat the quote as provisional until Shop Fast returns a confirmed order."
    }),
    buildExternalEndpointDraft({
      id: "draft_shop_fast_amazon_buy",
      title: "Amazon Buy",
      description: "Place an Amazon purchase through Shop Fast after quote review and buyer consent.",
      publicUrl: "https://shop.fast.xyz/api/amazon/buy",
      requestExample: {
        quoteId: "quote_example",
        buyerConsent: {
          accepted: true,
          acceptedAt: "2026-03-19T00:10:00.000Z"
        }
      },
      responseExample: {
        orderId: "order_example",
        status: "pending",
        message: "Shop Fast accepted the purchase request and is placing the upstream order."
      },
      usageNotes:
        "Discovery-only endpoint. Shop Fast owns quote validation, buyer consent, purchase execution, and order records."
    }),
    buildExternalEndpointDraft({
      id: "draft_shop_fast_amazon_order_status",
      title: "Amazon Order Status",
      description: "Retrieve Shop Fast order and fulfillment status for an Amazon purchase.",
      publicUrl: "https://shop.fast.xyz/api/amazon/order-status",
      requestExample: {
        orderId: "order_example"
      },
      responseExample: {
        orderId: "order_example",
        status: "placed",
        fulfillment: {
          status: "pending_shipment"
        }
      },
      usageNotes:
        "Discovery-only endpoint. Use Shop Fast as the source of truth for order, fulfillment, cancellation, and refund state."
    })
  ];
}

function buildShopifyExternalEndpointDrafts(): ExternalProviderEndpointDraftRecord[] {
  return [
    buildExternalEndpointDraft({
      id: "draft_shopify_storefront_graphql",
      serviceId: SHOPIFY_STOREFRONT_SERVICE_SEED.id,
      title: "Storefront GraphQL",
      description:
        "Use a shop-specific Shopify Storefront GraphQL endpoint for product discovery, cart creation, pricing, and checkout primitives.",
      publicUrl: "https://{store_name}.myshopify.com/api/2026-04/graphql.json",
      docsUrl: "https://shopify.dev/docs/api/storefront/2026-04",
      authNotes:
        "Shop-specific endpoint. Tokenless requests are possible for limited public storefront queries; merchant-provided Storefront access tokens are required for token-based access.",
      requestExample: {
        query: "query Products($first: Int!) { products(first: $first) { nodes { id title handle } } }",
        variables: {
          first: 3
        }
      },
      responseExample: {
        data: {
          products: {
            nodes: [
              {
                id: "gid://shopify/Product/123",
                title: "Example Product",
                handle: "example-product"
              }
            ]
          }
        }
      },
      usageNotes:
        "Discovery-only listing. Endpoint host is merchant-specific and checkout execution should remain merchant-controlled until marketplace quote, consent, order, and fulfillment records are implemented for that shop."
    })
  ];
}

function buildExternalEndpointDraft(input: {
  id: string;
  serviceId?: string;
  title: string;
  description: string;
  publicUrl: string;
  docsUrl?: string;
  authNotes?: string;
  requestExample: unknown;
  responseExample: unknown;
  usageNotes: string;
}): ExternalProviderEndpointDraftRecord {
  return {
    endpointType: "external_registry",
    id: input.id,
    serviceId: input.serviceId ?? SHOP_FAST_SERVICE_SEED.id,
    routeId: null,
    operation: null,
    title: input.title,
    description: input.description,
    price: null,
    billing: null,
    mode: null,
    requestSchemaJson: null,
    responseSchemaJson: null,
    method: "POST",
    publicUrl: input.publicUrl,
    docsUrl: input.docsUrl ?? "https://shop.fast.xyz/.well-known/ucp",
    authNotes: input.authNotes ?? "Discovery-only listing. Marketplace execution is not enabled yet.",
    requestExample: input.requestExample,
    responseExample: input.responseExample,
    usageNotes: input.usageNotes,
    executorKind: null,
    upstreamBaseUrl: null,
    upstreamPath: null,
    upstreamAuthMode: null,
    upstreamAuthHeaderName: null,
    upstreamSecretRef: null,
    hasUpstreamSecret: false,
    payout: null,
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
  const shopFastExecutionRoutes = [
    buildShopFastAmazonQuoteRoute(config),
    buildShopFastAmazonBuyRoute(config)
  ];
  const groups = [
    {
      service: SHOP_FAST_SERVICE_SEED,
      publishedService: buildPublishedServiceVersion({
        service: SHOP_FAST_SERVICE_SEED,
        routeIds: [],
        versionId: "published_service_shop_fast_amazon_v1"
      }),
      routes: [],
      externalEndpoints: buildShopFastExternalEndpointDrafts()
    },
    {
      service: SHOPIFY_STOREFRONT_SERVICE_SEED,
      publishedService: buildPublishedServiceVersion({
        service: SHOPIFY_STOREFRONT_SERVICE_SEED,
        routeIds: [],
        versionId: "published_service_shopify_storefront_v1"
      }),
      routes: [],
      externalEndpoints: buildShopifyExternalEndpointDrafts()
    },
    {
      service: SHOP_FAST_EXECUTION_SERVICE_SEED,
      publishedService: buildPublishedServiceVersion({
        service: SHOP_FAST_EXECUTION_SERVICE_SEED,
        routeIds: shopFastExecutionRoutes.map((route) => route.routeId),
        versionId: "published_service_shop_fast_amazon_execution_v1"
      }),
      routes: shopFastExecutionRoutes,
      externalEndpoints: []
    }
  ];

  if (!shouldSeedMarketplaceMocks(config)) {
    return groups;
  }

  const mockRoutes = [buildQuickInsightRoute(config), buildAsyncReportRoute(config)];

  return [
    ...groups,
    {
      service: MOCK_PROVIDER_SERVICE_SEED,
      publishedService: buildPublishedServiceVersion({
        service: MOCK_PROVIDER_SERVICE_SEED,
        routeIds: mockRoutes.map((route) => route.routeId),
        versionId: "published_service_mock_research_signals_v1"
      }),
      routes: mockRoutes,
      externalEndpoints: []
    }
  ];
}

export function buildSeededProviderServices(
  config: MarketplaceNetworkConfig = getDefaultMarketplaceNetworkConfig()
): ProviderServiceRecord[] {
  return buildSeededServiceGroups(config).map((group) => structuredClone(group.service));
}

export const MARKETPLACE_PROVIDER_SERVICE_SEEDS: ProviderServiceRecord[] = buildSeededProviderServices();

export function buildSeededMarketplaceRoutes(
  config: MarketplaceNetworkConfig = getDefaultMarketplaceNetworkConfig()
): MarketplaceRoute[] {
  return buildSeededServiceGroups(config).flatMap((group) => group.routes.map((route) => structuredClone(route)));
}

export function buildSeededProviderEndpointDrafts(
  config: MarketplaceNetworkConfig = getDefaultMarketplaceNetworkConfig()
): ProviderEndpointDraftRecord[] {
  return buildSeededServiceGroups(config).flatMap((group) =>
    [
      ...group.routes.map((route) => buildProviderEndpointDraft(group.service.id, route)),
      ...group.externalEndpoints.map((endpoint) => structuredClone(endpoint))
    ]
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
        asyncConfig: structuredClone(draft.asyncConfig),
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

export function buildSeededPublishedExternalEndpointVersions(
  config: MarketplaceNetworkConfig = getDefaultMarketplaceNetworkConfig()
): PublishedExternalEndpointVersionRecord[] {
  return buildSeededServiceGroups(config).flatMap((group) =>
    group.externalEndpoints.map((endpoint) => ({
      endpointType: "external_registry",
      endpointVersionId: `published_${endpoint.id}`,
      serviceId: endpoint.serviceId,
      serviceVersionId: group.publishedService.versionId,
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
      requestExample: structuredClone(endpoint.requestExample),
      responseExample: structuredClone(endpoint.responseExample),
      usageNotes: endpoint.usageNotes ?? undefined,
      requestSchemaJson: null,
      responseSchemaJson: null,
      executorKind: null,
      upstreamBaseUrl: null,
      upstreamPath: null,
      upstreamAuthMode: null,
      upstreamAuthHeaderName: null,
      upstreamSecretRef: null,
      createdAt: SEEDED_AT,
      updatedAt: SEEDED_AT
    }))
  );
}
