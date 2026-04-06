import { FastProvider, FastWallet } from "@fastxyz/sdk";
import { describe, expect, it } from "vitest";

import {
  InMemoryMarketplaceStore,
  PostgresMarketplaceStore,
  buildCatalogSearchResults,
  buildMarketplaceRouteDetail,
  buildPriceRange,
  buildMarketplaceRoutes,
  buildPaymentRequirementForRoute,
  buildRouteAuthRequirement,
  buildServiceDetail,
  buildOpenApiDocument,
  buildPayoutSplit,
  coerceQueryInput,
  createChallenge,
  hashNormalizedRequest,
  listServiceDefinitions,
  normalizeFastWalletAddress,
  normalizePaymentHeaders,
  resolveMarketplaceNetworkConfig,
  serializeQueryInput,
  validateJsonSchema,
  verifyWalletChallenge
} from "./index.js";
import type {
  MarketplaceRoute,
  ProviderEndpointDraftRecord,
  PublishedEndpointVersionRecord,
  PublishedServiceEndpointVersionRecord
} from "./index.js";

const TEST_PRIVATE_KEY = "11".repeat(32);
const TEST_TIMESTAMP = "2026-03-20T00:00:00.000Z";
const TESTNET_NETWORK_CONFIG = resolveMarketplaceNetworkConfig({
  deploymentNetwork: "testnet"
});
const TESTNET_MARKETPLACE_ROUTES = buildMarketplaceRoutes(TESTNET_NETWORK_CONFIG);
const TESTNET_SERVICE_DEFINITIONS = listServiceDefinitions(TESTNET_NETWORK_CONFIG);

async function createTestWallet() {
  const provider = new FastProvider({
    network: "mainnet",
    networks: {
      mainnet: {
        rpc: "https://api.fast.xyz/proxy",
        explorer: "https://explorer.fast.xyz"
      }
    }
  });

  const wallet = await FastWallet.fromPrivateKey(TEST_PRIVATE_KEY, provider);
  const exported = await wallet.exportKeys();
  return {
    wallet,
    address: wallet.address,
    publicKey: exported.publicKey
  };
}

function buildEscrowSplit(input: {
  providerAccountId: string;
  providerWallet: string | null;
  marketplaceAmount: string;
  providerAmount: string;
  marketplaceBps: number;
  providerBps: number;
}) {
  return {
    currency: "USDC" as const,
    settlementMode: "verified_escrow" as const,
    paymentDestinationWallet: "fast1market",
    usesTreasurySettlement: true,
    marketplaceWallet: "fast1market",
    marketplaceBps: input.marketplaceBps,
    marketplaceAmount: input.marketplaceAmount,
    providerAccountId: input.providerAccountId,
    providerWallet: input.providerWallet,
    providerBps: input.providerBps,
    providerAmount: input.providerAmount
  };
}

function buildPublishedEndpointFromRoute(
  route: MarketplaceRoute,
  overrides: Partial<PublishedEndpointVersionRecord> = {}
): PublishedEndpointVersionRecord {
  return {
    endpointType: "marketplace_proxy",
    endpointVersionId: overrides.endpointVersionId ?? `published_${route.routeId}`,
    serviceId: overrides.serviceId ?? "service_test",
    serviceVersionId: overrides.serviceVersionId ?? "service_version_test",
    endpointDraftId: overrides.endpointDraftId ?? `draft_${route.routeId}`,
    ...route,
    createdAt: overrides.createdAt ?? TEST_TIMESTAMP,
    updatedAt: overrides.updatedAt ?? TEST_TIMESTAMP,
    ...overrides
  };
}

function expectMarketplaceCatalogEndpoint(
  endpoint: PublishedServiceEndpointVersionRecord | ProviderEndpointDraftRecord | undefined | null
) {
  expect(endpoint?.endpointType).toBe("marketplace_proxy");
  return endpoint as Extract<
    PublishedServiceEndpointVersionRecord | ProviderEndpointDraftRecord,
    { endpointType: "marketplace_proxy" }
  >;
}

describe("shared marketplace helpers", () => {
  it("normalizes payment headers from PAYMENT-* names", () => {
    expect(
      normalizePaymentHeaders({
        "payment-signature": "new-header",
        "payment-identifier": "new-id"
      })
    ).toEqual({
      paymentId: "new-id",
      paymentPayload: "new-header"
    });

    expect(
      normalizePaymentHeaders({
        "PAYMENT-SIGNATURE": "upper-header",
        "PAYMENT-IDENTIFIER": "upper-id"
      })
    ).toEqual({
      paymentId: "upper-id",
      paymentPayload: "upper-header"
    });

    expect(
      normalizePaymentHeaders({
        "X-PAYMENT": "legacy-header",
        "X-PAYMENT-IDENTIFIER": "legacy-id"
      })
    ).toEqual({
      paymentId: "legacy-id",
      paymentPayload: "legacy-header"
    });
  });

  it("hashes normalized requests deterministically", () => {
    const route = TESTNET_MARKETPLACE_ROUTES[0];
    const first = hashNormalizedRequest(route, {
      query: "alpha",
      nested: {
        b: 2,
        a: 1
      }
    });
    const second = hashNormalizedRequest(route, {
      nested: {
        a: 1,
        b: 2
      },
      query: "alpha"
    });

    expect(first).toBe(second);
  });

  it("serializes and coerces GET query input canonically", () => {
    const schema = {
      type: "object",
      properties: {
        enabled: { type: "boolean" },
        limit: { type: "integer" },
        query: { type: "string" },
        symbols: {
          type: "array",
          items: { type: "string" }
        }
      },
      required: ["query"],
      additionalProperties: false
    } as const;

    expect(
      serializeQueryInput({
        schema,
        value: {
          symbols: ["FAST", "BTC"],
          query: "alpha",
          limit: 5,
          enabled: true
        }
      })
    ).toBe("?enabled=true&limit=5&query=alpha&symbols=FAST&symbols=BTC");

    const first = coerceQueryInput({
      schema,
      searchParams: new URLSearchParams("query=alpha&symbols=FAST&symbols=BTC&limit=5&enabled=true")
    });
    const second = coerceQueryInput({
      schema,
      searchParams: new URLSearchParams("symbols=FAST&enabled=true&limit=5&query=alpha&symbols=BTC")
    });

    expect(first).toEqual({
      enabled: true,
      limit: 5,
      query: "alpha",
      symbols: ["FAST", "BTC"]
    });
    expect(second).toEqual(first);

    const route = {
      ...TESTNET_MARKETPLACE_ROUTES[0],
      routeId: "mock.lookup.v1",
      operation: "lookup",
      method: "GET" as const,
      requestSchemaJson: schema
    };
    expect(hashNormalizedRequest(route, first)).toBe(hashNormalizedRequest(route, second));
  });

  it("normalizes a hex Fast payer into a canonical bech32 address", async () => {
    const testWallet = await createTestWallet();
    expect(normalizeFastWalletAddress(`0x${testWallet.publicKey}`)).toBe(testWallet.address);
  });

  it("verifies a wallet challenge signature", async () => {
    const testWallet = await createTestWallet();
    const challenge = createChallenge({
      wallet: testWallet.address,
      resourceType: "job",
      resourceId: "job_123"
    });
    const signed = await testWallet.wallet.sign({ message: challenge.message });

    await expect(
      verifyWalletChallenge({
        wallet: testWallet.address,
        signature: signed.signature,
        challenge
      })
    ).resolves.toBe(true);
  });

  it("builds route entries into the OpenAPI document", () => {
    const document = buildOpenApiDocument({
      baseUrl: "http://localhost:3000",
      services: TESTNET_SERVICE_DEFINITIONS,
      routes: TESTNET_MARKETPLACE_ROUTES
    });
    expect(document.paths["/api/mock/quick-insight"]).toBeDefined();
    expect(document.paths["/api/mock/async-report"]).toBeDefined();
    expect(document.paths["/catalog/services"]).toBeDefined();

    const asyncPath = document.paths["/api/mock/async-report"] as {
      post?: {
        responses?: Record<string, unknown>;
      };
    };
    const syncPaidPath = document.paths["/api/mock/quick-insight"] as {
      post?: {
        responses?: Record<string, unknown>;
      };
    };
    expect(asyncPath.post?.responses?.["202"]).toBeDefined();
    expect(asyncPath.post?.responses?.["200"]).toBeUndefined();
    expect(syncPaidPath.post?.responses?.["200"]).toBeDefined();
    expect(syncPaidPath.post?.responses?.["202"]).toBeDefined();
  });

  it("builds GET route entries into the OpenAPI document as query parameters", () => {
    const seededService = TESTNET_SERVICE_DEFINITIONS.find((candidate) => candidate.slug === "mock-research-signals");
    const seededRoute = TESTNET_MARKETPLACE_ROUTES.find((candidate) => candidate.routeId === "mock.quick-insight.v1");
    if (!seededService || !seededRoute) {
      throw new Error("Mock seeded service is missing.");
    }

    const getRoute = {
      ...seededRoute,
      routeId: "mock.quote-get.v1",
      operation: "quote-get",
      method: "GET" as const,
      billing: {
        type: "free" as const
      },
      price: "Free",
      requestSchemaJson: {
        type: "object",
        properties: {
          includeMeta: { type: "boolean" },
          symbol: { type: "string" }
        },
        required: ["symbol"],
        additionalProperties: false
      }
    };
    const service = {
      ...seededService,
      slug: "mock-get-signals",
      routeIds: [getRoute.routeId]
    };

    const document = buildOpenApiDocument({
      baseUrl: "https://api.marketplace.example.com",
      services: [service],
      routes: [getRoute]
    });
    const getPath = document.paths["/api/mock/quote-get"] as {
      get?: {
        parameters?: Array<{ name?: string; in?: string; required?: boolean }>;
        requestBody?: unknown;
      };
    };

    expect(getPath.get?.requestBody).toBeUndefined();
    expect(getPath.get?.parameters).toEqual([
      expect.objectContaining({
        name: "includeMeta",
        in: "query",
        required: false
      }),
      expect.objectContaining({
        name: "symbol",
        in: "query",
        required: true
      })
    ]);
  });

  it("describes free routes without x402 headers or token pricing", () => {
    const seededService = TESTNET_SERVICE_DEFINITIONS.find((candidate) => candidate.slug === "mock-research-signals");
    const seededRoute = TESTNET_MARKETPLACE_ROUTES.find((candidate) => candidate.routeId === "mock.quick-insight.v1");
    if (!seededService || !seededRoute) {
      throw new Error("Mock seeded service is missing.");
    }

    const freeRoute = {
      ...seededRoute,
      routeId: "mock.free-insight.v1",
      operation: "free-insight",
      billing: {
        type: "free" as const
      },
      price: "Free"
    };
    const freeService = {
      ...seededService,
      slug: "mock-free-signals",
      routeIds: [freeRoute.routeId]
    };

    const document = buildOpenApiDocument({
      baseUrl: "https://api.marketplace.example.com",
      services: [freeService],
      routes: [freeRoute]
    });
    const freePath = document.paths["/api/mock/free-insight"] as {
      post?: {
        responses?: Record<string, unknown>;
        parameters?: unknown[];
      };
    };

    expect(freePath.post?.responses?.["402"]).toBeUndefined();
    expect(freePath.post?.responses?.["202"]).toBeUndefined();
    expect(freePath.post?.parameters).toEqual([]);

    const detail = buildServiceDetail({
      service: freeService,
      endpoints: [buildPublishedEndpointFromRoute(freeRoute)],
      analytics: {
        totalCalls: 0,
        revenueRaw: "0",
        successRate30d: 0,
        volume30d: []
      },
      apiBaseUrl: "https://api.marketplace.example.com",
      webBaseUrl: "https://marketplace.example.com"
    });

    expect(detail.summary.priceRange).toBe("Free");
    expect(detail.useThisServicePrompt).toContain("(Free)");
    expect(detail.useThisServicePrompt).not.toContain("(Free USDC)");
    expect(detail.useThisServicePrompt).toContain("No payment headers are required.");
  });

  it("describes prepaid-credit routes with bearer auth instead of x402 headers", () => {
    const seededService = TESTNET_SERVICE_DEFINITIONS.find((candidate) => candidate.slug === "mock-research-signals");
    const seededRoute = TESTNET_MARKETPLACE_ROUTES.find((candidate) => candidate.routeId === "mock.quick-insight.v1");
    if (!seededService || !seededRoute) {
      throw new Error("Mock seeded service is missing.");
    }

    const prepaidRoute = {
      ...seededRoute,
      routeId: "mock.prepaid-insight.v1",
      operation: "prepaid-insight",
      billing: {
        type: "prepaid_credit" as const
      },
      price: "Prepaid credit"
    };
    const prepaidService = {
      ...seededService,
      slug: "mock-prepaid-signals",
      routeIds: [prepaidRoute.routeId]
    };

    const document = buildOpenApiDocument({
      baseUrl: "https://api.marketplace.example.com",
      services: [prepaidService],
      routes: [prepaidRoute]
    });
    const prepaidPath = document.paths["/api/mock/prepaid-insight"] as {
      post?: {
        responses?: Record<string, unknown>;
        parameters?: Array<{ name?: string; in?: string; required?: boolean }>;
      };
    };

    expect(prepaidPath.post?.responses?.["401"]).toBeDefined();
    expect(prepaidPath.post?.responses?.["403"]).toBeDefined();
    expect(prepaidPath.post?.responses?.["402"]).toBeUndefined();
    expect(prepaidPath.post?.parameters).toEqual([
      expect.objectContaining({
        name: "Authorization",
        in: "header",
        required: true
      })
    ]);
  });

  it("describes async free routes with wallet-session auth and runtime callback docs", () => {
    const seededService = TESTNET_SERVICE_DEFINITIONS.find((candidate) => candidate.slug === "mock-research-signals");
    const seededRoute = TESTNET_MARKETPLACE_ROUTES.find((candidate) => candidate.routeId === "mock.async-report.v1");
    if (!seededService || !seededRoute) {
      throw new Error("Mock seeded service is missing.");
    }

    const freeAsyncRoute = {
      ...seededRoute,
      routeId: "mock.free-async-insight.v1",
      operation: "free-async-insight",
      billing: {
        type: "free" as const
      },
      price: "Free",
      asyncConfig: {
        strategy: "webhook" as const,
        timeoutMs: 300000,
        pollPath: null
      }
    };
    const freeAsyncService = {
      ...seededService,
      slug: "mock-free-async-signals",
      routeIds: [freeAsyncRoute.routeId]
    };

    const document = buildOpenApiDocument({
      baseUrl: "https://api.marketplace.example.com",
      services: [freeAsyncService],
      routes: [freeAsyncRoute]
    });
    const freeAsyncPath = document.paths["/api/mock/free-async-insight"] as {
      post?: {
        responses?: Record<string, unknown>;
        parameters?: Array<{ name?: string; in?: string; required?: boolean }>;
      };
    };

    expect(freeAsyncPath.post?.responses?.["202"]).toBeDefined();
    expect(freeAsyncPath.post?.responses?.["401"]).toBeDefined();
    expect(freeAsyncPath.post?.responses?.["403"]).toBeDefined();
    expect(freeAsyncPath.post?.responses?.["402"]).toBeUndefined();
    expect(freeAsyncPath.post?.parameters).toEqual([
      expect.objectContaining({
        name: "Authorization",
        in: "header",
        required: true
      })
    ]);
    expect(document.paths["/provider/runtime/jobs/{jobToken}/callback"]).toBeDefined();
    expect(document.paths["/provider/runtime/credits/{reservationId}/extend"]).toBeDefined();

    const detail = buildServiceDetail({
      service: freeAsyncService,
      endpoints: [buildPublishedEndpointFromRoute(freeAsyncRoute)],
      analytics: {
        totalCalls: 0,
        revenueRaw: "0",
        successRate30d: 0,
        volume30d: []
      },
      apiBaseUrl: "https://api.marketplace.example.com",
      webBaseUrl: "https://marketplace.example.com"
    });

    expect(detail.useThisServicePrompt).toContain("route-scoped wallet session");
    expect(detail.useThisServicePrompt).toContain("GET /api/jobs/{jobToken}");
  });

  it("builds testnet routes when the deployment targets testnet", () => {
    const routes = buildMarketplaceRoutes(
      resolveMarketplaceNetworkConfig({
        deploymentNetwork: "testnet"
      })
    );

    expect(routes[0]?.network).toBe("fast-testnet");
  });

  it("pins Fast network asset ids in payment requirements", () => {
    const mainnetConfig = resolveMarketplaceNetworkConfig({
      deploymentNetwork: "mainnet"
    });
    const testnetConfig = resolveMarketplaceNetworkConfig({
      deploymentNetwork: "testnet"
    });
    const baseRoute = TESTNET_MARKETPLACE_ROUTES[0];
    if (!baseRoute) {
      throw new Error("Mock seeded route is missing.");
    }

    const mainnetRequirement = buildPaymentRequirementForRoute(
      {
        ...baseRoute,
        network: mainnetConfig.paymentNetwork
      },
      "fast1market"
    );
    const testnetRequirement = buildPaymentRequirementForRoute(
      {
        ...baseRoute,
        network: testnetConfig.paymentNetwork
      },
      "fast1market"
    );

    expect(mainnetConfig.tokenSymbol).toBe("USDC");
    expect(mainnetRequirement.asset).toBe("0xc655a12330da6af361d281b197996d2bc135aaed3b66278e729c2222291e9130");
    expect(testnetRequirement.asset).toBe("0xd73a0679a2be46981e2a8aedecd951c8b6690e7d5f8502b34ed3ff4cc2163b46");
  });

  it("does not seed mock marketplace services on mainnet", () => {
    const mainnetConfig = resolveMarketplaceNetworkConfig({
      deploymentNetwork: "mainnet"
    });

    expect(buildMarketplaceRoutes(mainnetConfig)).toEqual([]);
    expect(listServiceDefinitions(mainnetConfig)).toEqual([]);
  });

  it("freezes payout split amounts from the quoted price", () => {
    const split = buildPayoutSplit({
      route: TESTNET_MARKETPLACE_ROUTES[0],
      treasuryWallet: "fast1marketplacetreasury000000000000000000000000000000000000",
      paymentDestinationWallet: "fast1marketplacetreasury000000000000000000000000000000000000",
      quotedPrice: "50000"
    });

    expect(split.providerBps).toBe(0);
    expect(split.marketplaceAmount).toBe("50000");
    expect(split.providerAmount).toBe("0");
  });

  it("builds service catalog summaries and prompts from the shared registry", () => {
    const service = TESTNET_SERVICE_DEFINITIONS.find((candidate) => candidate.slug === "mock-research-signals");
    if (!service) {
      throw new Error("Mock seeded service is missing.");
    }

    const endpoints = TESTNET_MARKETPLACE_ROUTES.filter((route) => service.routeIds.includes(route.routeId));
    const publishedEndpoints = endpoints.map((endpoint) => buildPublishedEndpointFromRoute(endpoint));
    const detail = buildServiceDetail({
      service,
      endpoints: publishedEndpoints,
      analytics: {
        totalCalls: 12,
        revenueRaw: "420000",
        successRate30d: 66.666,
        volume30d: [{ date: "2026-03-18", amountRaw: "150000" }]
      },
      apiBaseUrl: "https://api.marketplace.example.com",
      webBaseUrl: "https://marketplace.example.com"
    });

    expect(buildPriceRange(endpoints)).toBe("$0.0001 testUSDC");
    expect(detail.skillUrl).toBe("https://marketplace.example.com/skill.md");
    expect(detail.summary.endpointCount).toBe(2);
    expect(detail.summary.settlementToken).toBe("testUSDC");
    expect(detail.useThisServicePrompt).toContain('I want to use the "Mock Research Signals" service');
    expect(detail.useThisServicePrompt).toContain("https://api.marketplace.example.com/api/mock/quick-insight");
    expect(detail.useThisServicePrompt).toContain("($0.0001 testUSDC)");
  });

  it("derives explicit auth requirements for marketplace routes", () => {
    const fixedRoute = TESTNET_MARKETPLACE_ROUTES.find((candidate) => candidate.routeId === "mock.quick-insight.v1");
    const asyncRoute = TESTNET_MARKETPLACE_ROUTES.find((candidate) => candidate.routeId === "mock.async-report.v1");
    if (!fixedRoute || !asyncRoute) {
      throw new Error("Mock seeded routes are missing.");
    }

    expect(buildRouteAuthRequirement(fixedRoute)).toMatchObject({
      type: "x402"
    });
    expect(buildRouteAuthRequirement({
      ...fixedRoute,
      routeId: "mock.prepaid-insight.v1",
      operation: "prepaid-insight",
      billing: {
        type: "prepaid_credit" as const
      },
      price: "Prepaid credit"
    })).toMatchObject({
      type: "wallet_session"
    });
    expect(buildRouteAuthRequirement({
      ...fixedRoute,
      routeId: "mock.free-sync.v1",
      operation: "free-sync",
      billing: {
        type: "free" as const
      },
      price: "Free"
    })).toMatchObject({
      type: "none"
    });
    expect(buildRouteAuthRequirement({
      ...asyncRoute,
      routeId: "mock.free-async.v1",
      operation: "free-async",
      billing: {
        type: "free" as const
      },
      price: "Free"
    })).toMatchObject({
      type: "wallet_session"
    });
  });

  it("builds marketplace route detail from the shared catalog", () => {
    const service = TESTNET_SERVICE_DEFINITIONS.find((candidate) => candidate.slug === "mock-research-signals");
    const route = TESTNET_MARKETPLACE_ROUTES.find((candidate) => candidate.routeId === "mock.quick-insight.v1");
    if (!service || !route) {
      throw new Error("Mock seeded service is missing.");
    }

    const publishedEndpoints = TESTNET_MARKETPLACE_ROUTES
      .filter((candidate) => service.routeIds.includes(candidate.routeId))
      .map((candidate) => buildPublishedEndpointFromRoute(candidate));
    const detail = buildMarketplaceRouteDetail({
      route: buildPublishedEndpointFromRoute(route),
      service,
      serviceEndpoints: publishedEndpoints,
      analytics: {
        totalCalls: 12,
        revenueRaw: "420000",
        successRate30d: 66.666,
        volume30d: [{ date: "2026-03-18", amountRaw: "150000" }]
      },
      apiBaseUrl: "https://api.marketplace.example.com"
    });

    expect(detail).toMatchObject({
      kind: "route",
      ref: "mock.quick-insight",
      routeId: "mock.quick-insight.v1",
      billingType: "fixed_x402",
      method: "POST"
    });
    expect(detail.authRequirement).toMatchObject({
      type: "x402"
    });
    expect(detail.tokenSymbol).toBe("testUSDC");
    expect(detail.serviceSummary.slug).toBe("mock-research-signals");
    expect(detail.serviceSummary.settlementToken).toBe("testUSDC");
  });

  it("builds mixed search results with deterministic ordering and filters", () => {
    const service = TESTNET_SERVICE_DEFINITIONS.find((candidate) => candidate.slug === "mock-research-signals");
    const fixedRoute = TESTNET_MARKETPLACE_ROUTES.find((candidate) => candidate.routeId === "mock.quick-insight.v1");
    const asyncRoute = TESTNET_MARKETPLACE_ROUTES.find((candidate) => candidate.routeId === "mock.async-report.v1");
    if (!service || !fixedRoute || !asyncRoute) {
      throw new Error("Mock seeded service is missing.");
    }

    const searchableService = {
      service,
      endpoints: [
        buildPublishedEndpointFromRoute(fixedRoute),
        buildPublishedEndpointFromRoute({
          ...asyncRoute,
          routeId: "mock.free-async-search.v1",
          operation: "free-async-search",
          billing: {
            type: "free" as const
          },
          price: "Free"
        })
      ],
      analytics: {
        totalCalls: 1,
        revenueRaw: "50000",
        successRate30d: 100,
        volume30d: []
      }
    };

    const fixedSearch = buildCatalogSearchResults({
      services: [searchableService],
      apiBaseUrl: "https://api.marketplace.example.com",
      filters: {
        q: "quick insight"
      }
    });
    const asyncSearch = buildCatalogSearchResults({
      services: [searchableService],
      apiBaseUrl: "https://api.marketplace.example.com",
      filters: {
        mode: "async",
        billingType: "free",
        settlementMode: "verified_escrow"
      }
    });
    const unfilteredSearch = buildCatalogSearchResults({
      services: [searchableService],
      apiBaseUrl: "https://api.marketplace.example.com"
    });

    expect(fixedSearch[0]).toMatchObject({
      kind: "route",
      summary: {
        ref: "mock.quick-insight",
        tokenSymbol: "testUSDC"
      }
    });
    expect(fixedSearch[1]).toMatchObject({
      kind: "service",
      routeRefs: ["mock.quick-insight"]
    });
    expect(asyncSearch).toEqual([
      expect.objectContaining({
        kind: "route",
        summary: expect.objectContaining({
          ref: "mock.free-async-search",
          tokenSymbol: "testUSDC",
          authRequirement: expect.objectContaining({
            type: "wallet_session"
          })
        })
      }),
      expect.objectContaining({
        kind: "service",
        routeRefs: ["mock.free-async-search"]
      })
    ]);
    expect(unfilteredSearch.find((result) => result.kind === "service")).toMatchObject({
      kind: "service",
      routeRefs: ["mock.free-async-search", "mock.quick-insight"]
    });
  });

  it("computes service analytics and provider request queue state in the in-memory store", async () => {
    const store = new InMemoryMarketplaceStore(TESTNET_NETWORK_CONFIG);

    await store.saveSyncIdempotency({
      paymentId: "payment_sync_catalog_1",
      normalizedRequestHash: "hash_sync",
      buyerWallet: "fast1buyer00000000000000000000000000000000000000000000000000000000",
      routeId: "mock.quick-insight.v1",
      routeVersion: "v1",
      quotedPrice: "50000",
      payoutSplit: buildEscrowSplit({
        providerAccountId: "mock",
        providerWallet: null,
        marketplaceBps: 6000,
        marketplaceAmount: "30000",
        providerBps: 4000,
        providerAmount: "20000"
      }),
      paymentPayload: "payload",
      facilitatorResponse: { isValid: true },
      statusCode: 200,
      body: { ok: true }
    });

    await store.saveAsyncAcceptance({
      paymentId: "payment_async_catalog_1",
      normalizedRequestHash: "hash_async",
      buyerWallet: "fast1buyer00000000000000000000000000000000000000000000000000000000",
      route: TESTNET_MARKETPLACE_ROUTES[1],
      quotedPrice: "150000",
      payoutSplit: buildEscrowSplit({
        providerAccountId: "mock",
        providerWallet: null,
        marketplaceBps: 7334,
        marketplaceAmount: "110000",
        providerBps: 2666,
        providerAmount: "40000"
      }),
      paymentPayload: "payload",
      facilitatorResponse: { isValid: true },
      jobToken: "job_catalog_1",
      requestId: "request_catalog_1",
      providerJobId: "provider_catalog_1",
      requestBody: { topic: "catalog analytics" },
      responseBody: { jobToken: "job_catalog_1", status: "pending" },
      responseHeaders: {}
    });

    expect(
      await store.getAccessGrant(
        "job",
        "job_catalog_1",
        "fast1buyer00000000000000000000000000000000000000000000000000000000"
      )
    ).not.toBeNull();

    await store.completeJob("job_catalog_1", { report: "done" });

    await store.saveSyncIdempotency({
      paymentId: "payment_sync_catalog_failed_1",
      normalizedRequestHash: "hash_sync_failed",
      buyerWallet: "fast1buyer00000000000000000000000000000000000000000000000000000000",
      routeId: "mock.quick-insight.v1",
      routeVersion: "v1",
      quotedPrice: "50000",
      payoutSplit: buildEscrowSplit({
        providerAccountId: "provider_marketplace",
        providerWallet: null,
        marketplaceBps: 6000,
        marketplaceAmount: "30000",
        providerBps: 4000,
        providerAmount: "20000"
      }),
      paymentPayload: "payload",
      facilitatorResponse: { isValid: true },
      statusCode: 502,
      body: { error: "refunded" }
    });

    await store.recordProviderAttempt({
      routeId: "mock.quick-insight.v1",
      requestId: "free_request_catalog_1",
      responseStatusCode: 200,
      phase: "execute",
      status: "succeeded",
      requestPayload: { symbol: "FAST" },
      responsePayload: { ok: true }
    });

    await store.recordProviderAttempt({
      routeId: "mock.quick-insight.v1",
      requestId: "free_request_catalog_2",
      responseStatusCode: 502,
      phase: "execute",
      status: "failed",
      requestPayload: { symbol: "FAIL" },
      responsePayload: { error: "upstream failed" }
    });

    const pendingAttempt = await store.recordProviderAttempt({
      routeId: "mock.quick-insight.v1",
      requestId: "free_request_catalog_3",
      phase: "execute",
      status: "pending",
      requestPayload: { symbol: "LATE" }
    });
    const completedAttempt = await store.recordProviderAttempt({
      routeId: "mock.quick-insight.v1",
      requestId: "free_request_catalog_3",
      responseStatusCode: 200,
      phase: "execute",
      status: "succeeded",
      requestPayload: { symbol: "LATE" },
      responsePayload: { ok: true }
    });
    await store.recordProviderAttempt({
      routeId: "mock.quick-insight.v1",
      requestId: "free_request_catalog_4",
      phase: "execute",
      status: "pending",
      requestPayload: { symbol: "PENDING" }
    });

    const internalAttempts = (store as unknown as {
      attempts: Array<{ id: string; createdAt: string }>;
    }).attempts;
    const sharedCreatedAt = completedAttempt.createdAt;
    const stalePending = internalAttempts.find((attempt) => attempt.id === pendingAttempt.id);
    const resolvedAttempt = internalAttempts.find((attempt) => attempt.id === completedAttempt.id);
    if (!stalePending || !resolvedAttempt) {
      throw new Error("Expected recorded provider attempts.");
    }
    stalePending.createdAt = sharedCreatedAt;
    resolvedAttempt.createdAt = sharedCreatedAt;
    (store as unknown as {
      attempts: Array<{ id: string; createdAt: string }>;
    }).attempts = [
      resolvedAttempt,
      stalePending,
      ...internalAttempts.filter((attempt) => attempt.id !== pendingAttempt.id && attempt.id !== completedAttempt.id)
    ];

    const analytics = await store.getServiceAnalytics(["mock.quick-insight.v1", "mock.async-report.v1"]);
    expect(analytics.totalCalls).toBe(6);
    expect(analytics.revenueRaw).toBe("60000");
    expect(analytics.successRate30d).toBe(80);

    const created = await store.createSuggestion({
      type: "endpoint",
      serviceSlug: "mock-research-signals",
      title: "Add a historical trend endpoint",
      description: "Expose a historical trend snapshot for repeated market checks."
    });
    const provider = await store.upsertProviderAccount("fast1providerwallet000000000000000000000000000000000000000000000000", {
      displayName: "Signal Labs"
    });
    await store.upsertProviderAccount("fast1otherproviderwallet00000000000000000000000000000000000000000000", {
      displayName: "Other Provider"
    });
    const claimed = await store.claimProviderRequest(
      created.id,
      "fast1providerwallet000000000000000000000000000000000000000000000000"
    );
    const updated = await store.updateSuggestion(created.id, {
      internalNotes: "Assign to provider after mock launch."
    });
    const reopened = await store.updateSuggestion(created.id, {
      status: "submitted"
    });
    const reassigned = await store.claimProviderRequest(
      created.id,
      "fast1otherproviderwallet00000000000000000000000000000000000000000000"
    );
    await store.updateSuggestion(created.id, {
      status: "shipped"
    });

    expect(claimed?.status).toBe("reviewing");
    expect(claimed?.claimedByProviderAccountId).toBe(provider.id);
    expect(claimed?.claimedByProviderName).toBe("Signal Labs");
    expect(updated?.status).toBe("reviewing");
    expect(reopened?.claimedByProviderAccountId).toBeNull();
    expect(reassigned?.claimedByProviderName).toBe("Other Provider");
    expect((await store.listSuggestions()).length).toBe(1);
    expect((await store.listProviderRequests("fast1providerwallet000000000000000000000000000000000000000000000000")).length).toBe(0);
  });

  it("deduplicates refunds by payment id and attaches the job token in the in-memory store", async () => {
    const store = new InMemoryMarketplaceStore();

    const first = await store.createRefund({
      paymentId: "payment_refund_1",
      wallet: "fast1buyer00000000000000000000000000000000000000000000000000000000",
      amount: "50000"
    });

    const second = await store.createRefund({
      jobToken: "job_refund_1",
      paymentId: "payment_refund_1",
      wallet: "fast1buyer00000000000000000000000000000000000000000000000000000000",
      amount: "50000"
    });

    expect(second.id).toBe(first.id);
    expect(second.paymentId).toBe(first.paymentId);
    expect(second.jobToken).toBe("job_refund_1");
  });

  it("does not backfill provider payouts for refunded completed jobs", async () => {
    const store = new InMemoryMarketplaceStore(TESTNET_NETWORK_CONFIG);
    const asyncRoute = TESTNET_MARKETPLACE_ROUTES.find((route) => route.routeId === "mock.async-report.v1");

    if (!asyncRoute) {
      throw new Error("Missing async seeded route.");
    }

    await store.saveAsyncAcceptance({
      paymentId: "payment_refunded_completed_job_1",
      normalizedRequestHash: "hash-refunded-completed-job-1",
      buyerWallet: "fast1buyerrefundedcompleted000000000000000000000000000000000000000",
      route: asyncRoute,
      quotedPrice: "150000",
      payoutSplit: buildEscrowSplit({
        providerAccountId: "mock",
        providerWallet: "fast1providerrefundedcompleted0000000000000000000000000000000000000",
        marketplaceBps: 5000,
        marketplaceAmount: "75000",
        providerBps: 5000,
        providerAmount: "75000"
      }),
      paymentPayload: "payload-refunded-completed-job-1",
      facilitatorResponse: { isValid: true },
      jobToken: "job_refunded_completed_1",
      requestId: "request_refunded_completed_1",
      providerJobId: "provider_refunded_completed_1",
      requestBody: { topic: "refunded completed" },
      providerState: { step: "done" },
      responseBody: {
        jobToken: "job_refunded_completed_1",
        status: "pending"
      },
      responseHeaders: {}
    });

    await store.completeJob("job_refunded_completed_1", { ok: true });
    const refund = await store.createRefund({
      jobToken: "job_refunded_completed_1",
      paymentId: "payment_refunded_completed_job_1",
      wallet: "fast1buyerrefundedcompleted000000000000000000000000000000000000000",
      amount: "150000"
    });
    await store.markRefundSent(refund.id, "0xrefunded-completed");

    expect(await store.listRecoverableProviderPayouts(10)).toEqual([]);
  });

  it("resets async job timeout metadata when acceptance is persisted after a placeholder", async () => {
    const store = new InMemoryMarketplaceStore(TESTNET_NETWORK_CONFIG);
    const asyncRoute = TESTNET_MARKETPLACE_ROUTES.find((route) => route.routeId === "mock.async-report.v1");

    if (!asyncRoute) {
      throw new Error("Missing async seeded route.");
    }

    await store.savePendingAsyncJob({
      jobToken: "job_timeout_reset_1",
      paymentId: "payment_timeout_reset_1",
      buyerWallet: "fast1buyertimeout000000000000000000000000000000000000000000000000",
      route: asyncRoute,
      quotedPrice: "150000",
      payoutSplit: buildEscrowSplit({
        providerAccountId: "mock",
        providerWallet: null,
        marketplaceBps: 10000,
        marketplaceAmount: "150000",
        providerBps: 0,
        providerAmount: "0"
      }),
      requestId: "request_timeout_reset_1",
      requestBody: { topic: "timeout reset" },
      nextPollAt: "2026-03-20T00:05:00.000Z",
      timeoutAt: null
    });

    await store.saveAsyncAcceptance({
      paymentId: "payment_timeout_reset_1",
      normalizedRequestHash: "hash_timeout_reset_1",
      buyerWallet: "fast1buyertimeout000000000000000000000000000000000000000000000000",
      route: asyncRoute,
      quotedPrice: "150000",
      payoutSplit: buildEscrowSplit({
        providerAccountId: "mock",
        providerWallet: null,
        marketplaceBps: 10000,
        marketplaceAmount: "150000",
        providerBps: 0,
        providerAmount: "0"
      }),
      paymentPayload: "payload-timeout-reset-1",
      facilitatorResponse: { isValid: true },
      jobToken: "job_timeout_reset_1",
      requestId: "request_timeout_reset_1",
      providerJobId: "provider_timeout_reset_1",
      requestBody: { topic: "timeout reset" },
      nextPollAt: "2026-03-20T00:06:00.000Z",
      timeoutAt: "2026-03-20T00:10:00.000Z",
      responseBody: {
        jobToken: "job_timeout_reset_1",
        status: "pending"
      },
      responseHeaders: {}
    });

    const job = await store.getJob("job_timeout_reset_1");
    expect(job?.nextPollAt).toBe("2026-03-20T00:06:00.000Z");
    expect(job?.timeoutAt).toBe("2026-03-20T00:10:00.000Z");
  });

  it("updates placeholder jobs with provider acceptance metadata before idempotency is completed", async () => {
    const store = new InMemoryMarketplaceStore(TESTNET_NETWORK_CONFIG);
    const asyncRoute = TESTNET_MARKETPLACE_ROUTES.find((route) => route.routeId === "mock.async-report.v1");

    if (!asyncRoute) {
      throw new Error("Missing async seeded route.");
    }

    await store.savePendingAsyncJob({
      jobToken: "job_pending_acceptance_1",
      paymentId: "payment_pending_acceptance_1",
      buyerWallet: "fast1buyeraccept000000000000000000000000000000000000000000000000",
      route: asyncRoute,
      quotedPrice: "150000",
      payoutSplit: buildEscrowSplit({
        providerAccountId: "mock",
        providerWallet: null,
        marketplaceBps: 10000,
        marketplaceAmount: "150000",
        providerBps: 0,
        providerAmount: "0"
      }),
      requestId: "request_pending_acceptance_1",
      requestBody: { topic: "placeholder" },
      nextPollAt: "2026-03-20T00:05:00.000Z",
      timeoutAt: null
    });

    await store.savePendingAsyncJob({
      jobToken: "job_pending_acceptance_1",
      paymentId: "payment_pending_acceptance_1",
      buyerWallet: "fast1buyeraccept000000000000000000000000000000000000000000000000",
      route: asyncRoute,
      quotedPrice: "150000",
      payoutSplit: buildEscrowSplit({
        providerAccountId: "mock",
        providerWallet: null,
        marketplaceBps: 10000,
        marketplaceAmount: "150000",
        providerBps: 0,
        providerAmount: "0"
      }),
      requestId: "request_pending_acceptance_1",
      providerJobId: "provider_pending_acceptance_1",
      requestBody: { topic: "placeholder" },
      providerState: { stage: "accepted" },
      nextPollAt: "2026-03-20T00:06:00.000Z",
      timeoutAt: "2026-03-20T00:10:00.000Z"
    });

    const job = await store.getJob("job_pending_acceptance_1");
    expect(job?.providerJobId).toBe("provider_pending_acceptance_1");
    expect(job?.providerState).toEqual({ stage: "accepted" });
    expect(job?.nextPollAt).toBe("2026-03-20T00:06:00.000Z");
    expect(job?.timeoutAt).toBe("2026-03-20T00:10:00.000Z");
  });

  it("does not overwrite terminal async jobs when duplicate terminal updates race", async () => {
    const store = new InMemoryMarketplaceStore(TESTNET_NETWORK_CONFIG);
    const asyncRoute = TESTNET_MARKETPLACE_ROUTES.find((route) => route.routeId === "mock.async-report.v1");

    if (!asyncRoute) {
      throw new Error("Missing async seeded route.");
    }

    await store.saveAsyncAcceptance({
      paymentId: "payment_terminal_sticky_1",
      normalizedRequestHash: "hash_terminal_sticky_1",
      buyerWallet: "fast1buyerterminalsticky0000000000000000000000000000000000000000",
      route: asyncRoute,
      quotedPrice: "150000",
      payoutSplit: buildEscrowSplit({
        providerAccountId: "mock",
        providerWallet: null,
        marketplaceBps: 10000,
        marketplaceAmount: "150000",
        providerBps: 0,
        providerAmount: "0"
      }),
      paymentPayload: "payload-terminal-sticky-1",
      facilitatorResponse: { isValid: true },
      jobToken: "job_terminal_sticky_1",
      requestId: "request_terminal_sticky_1",
      providerJobId: "provider_terminal_sticky_1",
      requestBody: { topic: "terminal sticky" },
      responseBody: {
        jobToken: "job_terminal_sticky_1",
        status: "pending"
      },
      responseHeaders: {}
    });

    await store.completeJob("job_terminal_sticky_1", { ok: true });
    const stillCompleted = await store.failJob("job_terminal_sticky_1", "late failure should not overwrite");
    expect(stillCompleted.status).toBe("completed");
    expect(stillCompleted.resultBody).toEqual({ ok: true });
    expect(stillCompleted.errorMessage).toBeNull();

    await store.saveAsyncAcceptance({
      paymentId: "payment_terminal_sticky_2",
      normalizedRequestHash: "hash_terminal_sticky_2",
      buyerWallet: "fast1buyerterminalsticky200000000000000000000000000000000000000",
      route: asyncRoute,
      quotedPrice: "150000",
      payoutSplit: buildEscrowSplit({
        providerAccountId: "mock",
        providerWallet: null,
        marketplaceBps: 10000,
        marketplaceAmount: "150000",
        providerBps: 0,
        providerAmount: "0"
      }),
      paymentPayload: "payload-terminal-sticky-2",
      facilitatorResponse: { isValid: true },
      jobToken: "job_terminal_sticky_2",
      requestId: "request_terminal_sticky_2",
      providerJobId: "provider_terminal_sticky_2",
      requestBody: { topic: "terminal sticky" },
      responseBody: {
        jobToken: "job_terminal_sticky_2",
        status: "pending"
      },
      responseHeaders: {}
    });

    await store.failJob("job_terminal_sticky_2", "permanent failure");
    const stillFailed = await store.completeJob("job_terminal_sticky_2", { ok: true });
    expect(stillFailed.status).toBe("failed");
    expect(stillFailed.errorMessage).toBe("permanent failure");
    expect(stillFailed.resultBody).toBeNull();
  });

  it("tracks prepaid credit balances across topup, reserve, capture, release, and expiry", async () => {
    const store = new InMemoryMarketplaceStore();
    const serviceId = "service_credit_1";
    const buyerWallet = "fast1buyer00000000000000000000000000000000000000000000000000000000";

    const topup = await store.createCreditTopup({
      serviceId,
      buyerWallet,
      currency: "USDC",
      amount: "1000000",
      paymentId: "payment_credit_1"
    });
    expect(topup.account.availableAmount).toBe("1000000");
    expect(topup.account.reservedAmount).toBe("0");

    const reserved = await store.reserveCredit({
      serviceId,
      buyerWallet,
      currency: "USDC",
      amount: "600000",
      idempotencyKey: "reserve_1",
      providerReference: "amazon-order-1",
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    });
    expect(reserved.account.availableAmount).toBe("400000");
    expect(reserved.account.reservedAmount).toBe("600000");

    const repeatedReserve = await store.reserveCredit({
      serviceId,
      buyerWallet,
      currency: "USDC",
      amount: "600000",
      idempotencyKey: "reserve_1",
      providerReference: "amazon-order-1",
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    });
    expect(repeatedReserve.reservation.id).toBe(reserved.reservation.id);
    expect(repeatedReserve.account.availableAmount).toBe("400000");

    const captured = await store.captureCreditReservation({
      reservationId: reserved.reservation.id,
      amount: "400000"
    });
    expect(captured.account.availableAmount).toBe("600000");
    expect(captured.account.reservedAmount).toBe("0");
    expect(captured.reservation.status).toBe("captured");
    expect(captured.captureEntry.amount).toBe("400000");
    expect(captured.releaseEntry?.amount).toBe("200000");

    const releasable = await store.reserveCredit({
      serviceId,
      buyerWallet,
      currency: "USDC",
      amount: "100000",
      idempotencyKey: "reserve_2",
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    });
    const released = await store.releaseCreditReservation({
      reservationId: releasable.reservation.id
    });
    expect(released.reservation.status).toBe("released");
    expect(released.account.availableAmount).toBe("600000");

    const expirable = await store.reserveCredit({
      serviceId,
      buyerWallet,
      currency: "USDC",
      amount: "50000",
      idempotencyKey: "reserve_3",
      expiresAt: new Date(Date.now() - 1_000).toISOString()
    });
    const expired = await store.expireCreditReservation(expirable.reservation.id);
    expect(expired.reservation.status).toBe("expired");
    expect(expired.account.availableAmount).toBe("600000");

    await expect(
      store.reserveCredit({
        serviceId,
        buyerWallet,
        currency: "USDC",
        amount: "700000",
        idempotencyKey: "reserve_4",
        expiresAt: new Date(Date.now() + 60_000).toISOString()
      })
    ).rejects.toThrow("Insufficient prepaid credit");
  });

  it("deduplicates top-up credit by payment id", async () => {
    const store = new InMemoryMarketplaceStore();
    const serviceId = "service_credit_dedupe_1";
    const buyerWallet = "fast1buyer00000000000000000000000000000000000000000000000000000000";

    const first = await store.createCreditTopup({
      serviceId,
      buyerWallet,
      currency: "USDC",
      amount: "250000",
      paymentId: "payment_credit_dedupe_1",
      metadata: {
        routeId: "orders.topup.v1"
      }
    });

    const second = await store.createCreditTopup({
      serviceId,
      buyerWallet,
      currency: "USDC",
      amount: "999999",
      paymentId: "payment_credit_dedupe_1",
      metadata: {
        routeId: "orders.topup.v1"
      }
    });

    expect(second.entry.id).toBe(first.entry.id);
    expect(second.entry.amount).toBe("250000");
    expect(second.account.availableAmount).toBe("250000");
  });

  it("publishes provider snapshots and resolves them by api namespace and operation", async () => {
    const store = new InMemoryMarketplaceStore();
    const wallet = "fast1provider000000000000000000000000000000000000000000000000000000";

    await store.upsertProviderAccount(wallet, {
      displayName: "Signal Labs",
      websiteUrl: "https://provider.example.com"
    });

    const created = await store.createProviderService(wallet, {
      serviceType: "marketplace_proxy",
      slug: "signal-labs",
      apiNamespace: "signals",
      name: "Signal Labs",
      tagline: "Short-form market signals",
      about: "Provider-authored signal endpoints.",
      categories: ["Research"],
      promptIntro: 'I want to use the "Signal Labs" service on Fast Marketplace.',
      setupInstructions: ["Use a funded Fast wallet."],
      websiteUrl: "https://provider.example.com",
      payoutWallet: wallet
    });

    await store.createProviderEndpointDraft(created.service.id, wallet, {
      endpointType: "marketplace_proxy",
      operation: "quote",
      method: "POST",
      title: "Quote",
      description: "Return a single quote snapshot.",
      billingType: "fixed_x402",
      price: "$0.0001",
      mode: "sync",
      requestSchemaJson: {
        type: "object",
        properties: {
          symbol: { type: "string" }
        },
        required: ["symbol"],
        additionalProperties: false
      },
      responseSchemaJson: {
        type: "object",
        properties: {
          symbol: { type: "string" },
          price: { type: "number" }
        },
        required: ["symbol", "price"],
        additionalProperties: false
      },
      requestExample: { symbol: "FAST" },
      responseExample: { symbol: "FAST", price: 42.5 },
      upstreamBaseUrl: "https://provider.example.com",
      upstreamPath: "/api/quote",
      upstreamAuthMode: "none"
    });

    await store.createProviderVerificationChallenge(created.service.id, wallet);
    await store.markProviderVerificationResult(created.service.id, "verified", {
      verifiedHost: "provider.example.com"
    });
    await store.submitProviderService(created.service.id, wallet);
    await store.publishProviderService(created.service.id, {
      reviewerIdentity: "ops@test"
    });

    const published = await store.findPublishedRoute("signals", "quote", "fast-mainnet");
    expect(published?.routeId).toBe("signals.quote.v1");

    const publicService = await store.getPublishedServiceBySlug("signal-labs");
    expect(publicService?.service.status).toBe("published");
    expect(publicService?.endpoints).toHaveLength(1);
  });

  it("publishes external registry services without creating executable marketplace routes", async () => {
    const store = new InMemoryMarketplaceStore();
    const wallet = "fast1provider000000000000000000000000000000000000000000000000000000";

    await store.upsertProviderAccount(wallet, {
      displayName: "Signal Labs",
      websiteUrl: "https://provider.example.com"
    });

    const created = await store.createProviderService(wallet, {
      serviceType: "external_registry",
      slug: "signal-labs-direct",
      name: "Signal Labs Direct",
      tagline: "Discovery-only external endpoints",
      about: "Direct provider APIs listed in the marketplace catalog without proxy execution.",
      categories: ["Research"],
      promptIntro: 'I want to use the "Signal Labs Direct" service.',
      setupInstructions: ["Read the provider docs before calling the API directly."],
      websiteUrl: "https://provider.example.com"
    });

    await store.createProviderEndpointDraft(created.service.id, wallet, {
      endpointType: "external_registry",
      title: "Status",
      description: "Returns service status directly from the provider.",
      method: "GET",
      publicUrl: "https://provider.example.com/api/status",
      docsUrl: "https://provider.example.com/docs/status",
      authNotes: "Bearer token required.",
      requestExample: {},
      responseExample: { status: "ok" }
    });

    await store.createProviderVerificationChallenge(created.service.id, wallet);
    await store.markProviderVerificationResult(created.service.id, "verified", {
      verifiedHost: "provider.example.com"
    });
    await store.submitProviderService(created.service.id, wallet);
    await store.publishProviderService(created.service.id, {
      reviewerIdentity: "ops@test"
    });

    const published = await store.getPublishedServiceBySlug("signal-labs-direct");
    expect(published?.service.serviceType).toBe("external_registry");
    expect(published?.service.routeIds).toEqual([]);
    expect(published?.endpoints).toHaveLength(1);
    expect(published?.endpoints[0]?.endpointType).toBe("external_registry");

    const route = await store.findPublishedRoute("signal-labs-direct", "status", "fast-mainnet");
    expect(route).toBeNull();
  });

  it("resolves published services by the published snapshot slug even after draft slug edits", async () => {
    const store = new InMemoryMarketplaceStore();
    const wallet = "fast1provider000000000000000000000000000000000000000000000000000000";

    await store.upsertProviderAccount(wallet, {
      displayName: "Signal Labs",
      websiteUrl: "https://provider.example.com"
    });

    const created = await store.createProviderService(wallet, {
      serviceType: "marketplace_proxy",
      slug: "signal-labs",
      apiNamespace: "signals",
      name: "Signal Labs",
      tagline: "Short-form market signals",
      about: "Provider-authored signal endpoints.",
      categories: ["Research"],
      promptIntro: 'I want to use the "Signal Labs" service on Fast Marketplace.',
      setupInstructions: ["Use a funded Fast wallet."],
      websiteUrl: "https://provider.example.com",
      payoutWallet: wallet
    });

    await store.createProviderEndpointDraft(created.service.id, wallet, {
      endpointType: "marketplace_proxy",
      operation: "quote",
      method: "POST",
      title: "Quote",
      description: "Return a single quote snapshot.",
      billingType: "fixed_x402",
      price: "$0.0001",
      mode: "sync",
      requestSchemaJson: {
        type: "object",
        properties: {
          symbol: { type: "string" }
        },
        required: ["symbol"],
        additionalProperties: false
      },
      responseSchemaJson: {
        type: "object",
        properties: {
          symbol: { type: "string" },
          price: { type: "number" }
        },
        required: ["symbol", "price"],
        additionalProperties: false
      },
      requestExample: { symbol: "FAST" },
      responseExample: { symbol: "FAST", price: 42.5 },
      upstreamBaseUrl: "https://provider.example.com",
      upstreamPath: "/api/quote",
      upstreamAuthMode: "none"
    });

    await store.createProviderVerificationChallenge(created.service.id, wallet);
    await store.markProviderVerificationResult(created.service.id, "verified", {
      verifiedHost: "provider.example.com"
    });
    await store.submitProviderService(created.service.id, wallet);
    await store.publishProviderService(created.service.id, {
      reviewerIdentity: "ops@test"
    });

    await store.updateProviderServiceForOwner(created.service.id, wallet, {
      slug: "signal-labs-next"
    });

    const publishedByOriginalSlug = await store.getPublishedServiceBySlug("signal-labs");
    const publishedByDraftSlug = await store.getPublishedServiceBySlug("signal-labs-next");

    expect(publishedByOriginalSlug?.service.slug).toBe("signal-labs");
    expect(publishedByOriginalSlug?.endpoints).toHaveLength(1);
    expect(publishedByDraftSlug).toBeNull();
  });

  it("keeps a live published slug reserved after the next draft slug changes", async () => {
    const store = new InMemoryMarketplaceStore();
    const wallet = "fast1provider000000000000000000000000000000000000000000000000000000";

    await store.upsertProviderAccount(wallet, {
      displayName: "Signal Labs",
      websiteUrl: "https://provider.example.com"
    });

    const created = await store.createProviderService(wallet, {
      serviceType: "marketplace_proxy",
      slug: "signal-labs",
      apiNamespace: "signals",
      name: "Signal Labs",
      tagline: "Short-form market signals",
      about: "Provider-authored signal endpoints.",
      categories: ["Research"],
      promptIntro: 'I want to use the "Signal Labs" service on Fast Marketplace.',
      setupInstructions: ["Use a funded Fast wallet."],
      websiteUrl: "https://provider.example.com",
      payoutWallet: wallet
    });

    await store.createProviderEndpointDraft(created.service.id, wallet, {
      endpointType: "marketplace_proxy",
      operation: "quote",
      method: "POST",
      title: "Quote",
      description: "Return a single quote snapshot.",
      billingType: "fixed_x402",
      price: "$0.0001",
      mode: "sync",
      requestSchemaJson: {
        type: "object",
        properties: {
          symbol: { type: "string" }
        },
        required: ["symbol"],
        additionalProperties: false
      },
      responseSchemaJson: {
        type: "object",
        properties: {
          symbol: { type: "string" },
          price: { type: "number" }
        },
        required: ["symbol", "price"],
        additionalProperties: false
      },
      requestExample: { symbol: "FAST" },
      responseExample: { symbol: "FAST", price: 42.5 },
      upstreamBaseUrl: "https://provider.example.com",
      upstreamPath: "/api/quote",
      upstreamAuthMode: "none"
    });

    await store.createProviderVerificationChallenge(created.service.id, wallet);
    await store.markProviderVerificationResult(created.service.id, "verified", {
      verifiedHost: "provider.example.com"
    });
    await store.submitProviderService(created.service.id, wallet);
    await store.publishProviderService(created.service.id, {
      reviewerIdentity: "ops@test"
    });
    await store.updateProviderServiceForOwner(created.service.id, wallet, {
      slug: "signal-labs-next"
    });

    await expect(
      store.createProviderService(wallet, {
        serviceType: "external_registry",
        slug: "signal-labs",
        name: "Signal Labs Direct",
        tagline: "Discovery-only external endpoints",
        about: "Direct provider APIs listed in the marketplace catalog without proxy execution.",
        categories: ["Research"],
        promptIntro: 'I want to use the "Signal Labs Direct" service.',
        setupInstructions: ["Read the provider docs before calling the API directly."],
        websiteUrl: "https://provider.example.com"
      })
    ).rejects.toThrow("Service slug already exists: signal-labs");
  });

  it("keeps a live published apiNamespace reserved after the next draft namespace changes", async () => {
    const store = new InMemoryMarketplaceStore();
    const wallet = "fast1provider000000000000000000000000000000000000000000000000000000";

    await store.upsertProviderAccount(wallet, {
      displayName: "Signal Labs",
      websiteUrl: "https://provider.example.com"
    });

    const created = await store.createProviderService(wallet, {
      serviceType: "marketplace_proxy",
      slug: "signal-labs-namespace",
      apiNamespace: "signals-namespace",
      name: "Signal Labs Namespace",
      tagline: "Short-form market signals",
      about: "Provider-authored signal endpoints.",
      categories: ["Research"],
      promptIntro: 'I want to use the "Signal Labs Namespace" service on Fast Marketplace.',
      setupInstructions: ["Use a funded Fast wallet."],
      websiteUrl: "https://provider.example.com",
      payoutWallet: wallet
    });

    const endpoint = await store.createProviderEndpointDraft(created.service.id, wallet, {
      endpointType: "marketplace_proxy",
      operation: "quote",
      method: "POST",
      title: "Quote",
      description: "Return a single quote snapshot.",
      billingType: "fixed_x402",
      price: "$0.0001",
      mode: "sync",
      requestSchemaJson: {
        type: "object",
        properties: {
          symbol: { type: "string" }
        },
        required: ["symbol"],
        additionalProperties: false
      },
      responseSchemaJson: {
        type: "object",
        properties: {
          symbol: { type: "string" },
          price: { type: "number" }
        },
        required: ["symbol", "price"],
        additionalProperties: false
      },
      requestExample: { symbol: "FAST" },
      responseExample: { symbol: "FAST", price: 42.5 },
      upstreamBaseUrl: "https://provider.example.com",
      upstreamPath: "/api/quote",
      upstreamAuthMode: "none"
    });

    await store.createProviderVerificationChallenge(created.service.id, wallet);
    await store.markProviderVerificationResult(created.service.id, "verified", {
      verifiedHost: "provider.example.com"
    });
    await store.submitProviderService(created.service.id, wallet);
    await store.publishProviderService(created.service.id, {
      reviewerIdentity: "ops@test"
    });
    await store.deleteProviderEndpointDraft(created.service.id, endpoint.id, wallet);
    await store.updateProviderServiceForOwner(created.service.id, wallet, {
      apiNamespace: "signals-namespace-next"
    });

    await expect(
      store.createProviderService(wallet, {
        serviceType: "marketplace_proxy",
        slug: "signal-labs-namespace-two",
        apiNamespace: "signals-namespace",
        name: "Signal Labs Namespace Two",
        tagline: "Short-form market signals",
        about: "Provider-authored signal endpoints.",
        categories: ["Research"],
        promptIntro: 'I want to use the "Signal Labs Namespace Two" service on Fast Marketplace.',
        setupInstructions: ["Use a funded Fast wallet."],
        websiteUrl: "https://provider.example.com",
        payoutWallet: wallet
      })
    ).rejects.toThrow("API namespace already exists: signals-namespace");
  });

  it("propagates service payout-wallet changes into existing endpoint drafts before submit", async () => {
    const store = new InMemoryMarketplaceStore();
    const wallet = "fast1provider000000000000000000000000000000000000000000000000000000";
    const replacementWallet = "fast1replacement00000000000000000000000000000000000000000000000000";

    await store.upsertProviderAccount(wallet, {
      displayName: "Signal Labs",
      websiteUrl: "https://provider.example.com"
    });

    const created = await store.createProviderService(wallet, {
      serviceType: "marketplace_proxy",
      slug: "signal-labs-wallet-sync",
      apiNamespace: "signals-wallet-sync",
      name: "Signal Labs Wallet Sync",
      tagline: "Provider payout wallet propagation.",
      about: "Provider-authored signal endpoints used to verify payout wallet propagation into drafts and snapshots.",
      categories: ["Research"],
      promptIntro: 'I want to use the "Signal Labs Wallet Sync" service on Fast Marketplace.',
      setupInstructions: ["Use a funded Fast wallet."],
      websiteUrl: "https://provider.example.com",
      payoutWallet: wallet
    });

    const endpoint = await store.createProviderEndpointDraft(created.service.id, wallet, {
      endpointType: "marketplace_proxy",
      operation: "quote",
      method: "POST",
      title: "Quote",
      description: "Return a single quote snapshot.",
      billingType: "fixed_x402",
      price: "$0.0001",
      mode: "sync",
      requestSchemaJson: {
        type: "object",
        properties: {
          symbol: { type: "string" }
        },
        required: ["symbol"],
        additionalProperties: false
      },
      responseSchemaJson: {
        type: "object",
        properties: {
          symbol: { type: "string" },
          price: { type: "number" }
        },
        required: ["symbol", "price"],
        additionalProperties: false
      },
      requestExample: { symbol: "FAST" },
      responseExample: { symbol: "FAST", price: 42.5 },
      upstreamBaseUrl: "https://provider.example.com",
      upstreamPath: "/api/quote",
      upstreamAuthMode: "none"
    });

    expect(expectMarketplaceCatalogEndpoint(endpoint).payout.providerWallet).toBe(wallet);

    await store.updateProviderServiceForOwner(created.service.id, wallet, {
      payoutWallet: replacementWallet
    });

    const updatedDetail = await store.getProviderServiceForOwner(created.service.id, wallet);
    expect(updatedDetail?.service.payoutWallet).toBe(replacementWallet);
    expect(expectMarketplaceCatalogEndpoint(updatedDetail?.endpoints[0]).payout.providerWallet).toBe(replacementWallet);

    await store.createProviderVerificationChallenge(created.service.id, wallet);
    await store.markProviderVerificationResult(created.service.id, "verified", {
      verifiedHost: "provider.example.com"
    });
    await store.submitProviderService(created.service.id, wallet);
    await store.publishProviderService(created.service.id, {
      reviewerIdentity: "ops@test",
      settlementMode: "verified_escrow"
    });

    const published = await store.getPublishedServiceBySlug("signal-labs-wallet-sync");
    expect(published?.service.payoutWallet).toBe(replacementWallet);
    expect(expectMarketplaceCatalogEndpoint(published?.endpoints[0]).payout.providerWallet).toBe(replacementWallet);
  });

  it("persists marketplace route methods through the Postgres store", async () => {
    const wallet = "fast1provider000000000000000000000000000000000000000000000000000000";
    const accountId = "acct_postgres";
    const serviceId = "service_postgres";
    const now = TEST_TIMESTAMP;
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    const draftRows: Record<string, unknown>[] = [];
    const publishedRows: Record<string, unknown>[] = [
      {
        endpoint_version_id: "endpoint_version_get",
        service_id: serviceId,
        service_version_id: "service_version_postgres",
        endpoint_draft_id: "draft_quote_get",
        route_id: "signals-postgres.quote-get.v1",
        provider: "signals-postgres",
        operation: "quote-get",
        version: "v1",
        method: "GET",
        settlement_mode: "verified_escrow",
        mode: "sync",
        network: "fast-mainnet",
        price: "Free",
        billing: { type: "free" },
        title: "Quote GET",
        description: "Return a single quote snapshot.",
        payout: { providerAccountId: accountId, providerWallet: wallet, providerBps: 10_000 },
        request_example: { symbol: "FAST" },
        response_example: { symbol: "FAST" },
        usage_notes: null,
        request_schema_json: {
          type: "object",
          properties: {
            symbol: { type: "string" }
          },
          required: ["symbol"],
          additionalProperties: false
        },
        response_schema_json: {
          type: "object",
          properties: {
            symbol: { type: "string" }
          },
          required: ["symbol"],
          additionalProperties: false
        },
        executor_kind: "http",
        upstream_base_url: "https://provider.example.com",
        upstream_path: "/api/quote",
        upstream_auth_mode: "none",
        upstream_auth_header_name: null,
        upstream_secret_ref: null,
        created_at: now,
        updated_at: now
      },
      {
        endpoint_version_id: "endpoint_version_post",
        service_id: serviceId,
        service_version_id: "service_version_postgres",
        endpoint_draft_id: "draft_quote_post",
        route_id: "signals-postgres.quote-post.v1",
        provider: "signals-postgres",
        operation: "quote-post",
        version: "v1",
        method: null,
        settlement_mode: "verified_escrow",
        mode: "sync",
        network: "fast-mainnet",
        price: "$0.0001",
        billing: { type: "fixed_x402" },
        title: "Quote POST",
        description: "Return a single quote snapshot.",
        payout: { providerAccountId: accountId, providerWallet: wallet, providerBps: 10_000 },
        request_example: { symbol: "FAST" },
        response_example: { symbol: "FAST" },
        usage_notes: null,
        request_schema_json: {
          type: "object",
          properties: {
            symbol: { type: "string" }
          },
          required: ["symbol"],
          additionalProperties: false
        },
        response_schema_json: {
          type: "object",
          properties: {
            symbol: { type: "string" }
          },
          required: ["symbol"],
          additionalProperties: false
        },
        executor_kind: "http",
        upstream_base_url: "https://provider.example.com",
        upstream_path: "/api/quote",
        upstream_auth_mode: "none",
        upstream_auth_header_name: null,
        upstream_secret_ref: null,
        created_at: now,
        updated_at: now
      }
    ];

    const store = new PostgresMarketplaceStore({
      query: async (sql: string, params: unknown[] = []) => {
        queries.push({ sql, params });

        if (sql.includes("SELECT * FROM provider_services WHERE id = $1")) {
          return {
            rowCount: 1,
            rows: [
              {
                id: serviceId,
                provider_account_id: accountId,
                service_type: "marketplace_proxy",
                settlement_mode: "verified_escrow",
                slug: "signal-labs-postgres",
                api_namespace: "signals-postgres",
                name: "Signal Labs Postgres",
                tagline: "Persistence coverage",
                about: "Provider-authored signal endpoints.",
                categories: ["Research"],
                prompt_intro: 'I want to use the "Signal Labs Postgres" service on Fast Marketplace.',
                setup_instructions: ["Use a funded Fast wallet."],
                website_url: "https://provider.example.com",
                payout_wallet: wallet,
                featured: false,
                status: "draft",
                created_at: now,
                updated_at: now
              }
            ]
          };
        }

        if (sql.includes("SELECT * FROM provider_accounts WHERE id = $1")) {
          return {
            rowCount: 1,
            rows: [
              {
                id: accountId,
                owner_wallet: wallet,
                display_name: "Signal Labs",
                website_url: "https://provider.example.com",
                bio: null,
                contact_email: null,
                created_at: now,
                updated_at: now
              }
            ]
          };
        }

        if (sql.includes("SELECT * FROM provider_endpoint_drafts") && sql.includes("WHERE service_id = $1")) {
          return {
            rowCount: draftRows.length,
            rows: draftRows
          };
        }

        if (sql.includes("SELECT * FROM provider_external_endpoint_drafts")) {
          return { rowCount: 0, rows: [] };
        }

        if (sql.includes("SELECT * FROM provider_verifications")) {
          return { rowCount: 0, rows: [] };
        }

        if (sql.includes("SELECT * FROM provider_reviews")) {
          return { rowCount: 0, rows: [] };
        }

        if (sql.includes("INSERT INTO provider_endpoint_drafts")) {
          const row = {
            id: params[0] as string,
            service_id: params[1] as string,
            route_id: params[2] as string,
            operation: params[3] as string,
            method: params[4] as string,
            title: params[5] as string,
            description: params[6] as string,
            price: params[7] as string,
            billing: JSON.parse(params[8] as string),
            mode: params[9] as string,
            request_schema_json: JSON.parse(params[10] as string),
            response_schema_json: JSON.parse(params[11] as string),
            request_example: JSON.parse(params[12] as string),
            response_example: JSON.parse(params[13] as string),
            usage_notes: params[14] as string | null,
            executor_kind: params[15] as string,
            upstream_base_url: params[16] as string | null,
            upstream_path: params[17] as string | null,
            upstream_auth_mode: params[18] as string | null,
            upstream_auth_header_name: params[19] as string | null,
            upstream_secret_ref: params[20] as string | null,
            payout: JSON.parse(params[21] as string),
            created_at: now,
            updated_at: now
          };
          draftRows.push(row);
          return { rowCount: 1, rows: [row] };
        }

        if (sql.includes("SELECT e.*") && sql.includes("JOIN published_endpoint_versions e")) {
          const match = publishedRows.find(
            (row) => row.provider === params[0] && row.operation === params[1] && row.network === params[2]
          );
          return {
            rowCount: match ? 1 : 0,
            rows: match ? [match] : []
          };
        }

        return { rowCount: 0, rows: [] };
      }
    } as never);

    const created = await store.createProviderEndpointDraft(serviceId, wallet, {
      endpointType: "marketplace_proxy",
      operation: "quote-get",
      method: "GET",
      title: "Quote GET",
      description: "Return a single quote snapshot.",
      billingType: "free",
      mode: "sync",
      requestSchemaJson: {
        type: "object",
        properties: {
          symbol: { type: "string" }
        },
        required: ["symbol"],
        additionalProperties: false
      },
      responseSchemaJson: {
        type: "object",
        properties: {
          symbol: { type: "string" }
        },
        required: ["symbol"],
        additionalProperties: false
      },
      requestExample: { symbol: "FAST" },
      responseExample: { symbol: "FAST" },
      upstreamBaseUrl: "https://provider.example.com",
      upstreamPath: "/api/quote",
      upstreamAuthMode: "none"
    });

    expect(created.method).toBe("GET");
    const insert = queries.find((entry) => entry.sql.includes("INSERT INTO provider_endpoint_drafts"));
    expect(insert?.params[4]).toBe("GET");

    const detail = await store.getProviderServiceForOwner(serviceId, wallet);
    expect(expectMarketplaceCatalogEndpoint(detail?.endpoints[0]).method).toBe("GET");

    const publishedGet = await store.findPublishedRoute("signals-postgres", "quote-get", "fast-mainnet");
    const publishedPost = await store.findPublishedRoute("signals-postgres", "quote-post", "fast-mainnet");

    expect(publishedGet?.method).toBe("GET");
    expect(publishedPost?.method).toBe("POST");
  });

  it("adds Postgres method defaults and backfill migrations for marketplace routes", async () => {
    const queries: string[] = [];
    const query = async (sql: string) => {
      queries.push(sql);
      return { rowCount: 0, rows: [] };
    };
    const store = new PostgresMarketplaceStore({
      query,
      connect: async () => ({
        query,
        release() {}
      })
    } as never);

    await store.ensureSchema();

    const schemaSql = queries.join("\n");
    expect(schemaSql).toContain("method TEXT NOT NULL DEFAULT 'POST'");
    expect(schemaSql).toContain("ALTER TABLE provider_endpoint_drafts");
    expect(schemaSql).toContain("ADD COLUMN IF NOT EXISTS method TEXT NOT NULL DEFAULT 'POST'");
    expect(schemaSql).toContain("ALTER TABLE published_endpoint_versions");
    expect(schemaSql).toMatch(/UPDATE provider_endpoint_drafts[\s\S]*SET method = 'POST'[\s\S]*WHERE method IS NULL/);
    expect(schemaSql).toMatch(/UPDATE published_endpoint_versions[\s\S]*SET method = 'POST'[\s\S]*WHERE method IS NULL/);
  });

  it("lists buyer activity from stored charges, jobs, refunds, and historical published routes", async () => {
    const store = new InMemoryMarketplaceStore(TESTNET_NETWORK_CONFIG);
    const quickInsight = TESTNET_MARKETPLACE_ROUTES.find((route) => route.operation === "quick-insight");
    const asyncReport = TESTNET_MARKETPLACE_ROUTES.find((route) => route.operation === "async-report");

    expect(quickInsight).toBeDefined();
    expect(asyncReport).toBeDefined();

    await store.saveSyncIdempotency({
      paymentId: "payment_buyer_sync_1",
      normalizedRequestHash: "hash_sync_1",
      buyerWallet: "fast1buyerhistory0000000000000000000000000000000000000000000000000",
      routeId: quickInsight!.routeId,
      routeVersion: quickInsight!.version,
      quotedPrice: "50000",
      payoutSplit: buildEscrowSplit({
        providerAccountId: "provider_marketplace",
        providerWallet: null,
        marketplaceAmount: "50000",
        providerAmount: "0",
        marketplaceBps: 10000,
        providerBps: 0
      }),
      paymentPayload: "payload_sync_1",
      facilitatorResponse: { isValid: true },
      statusCode: 200,
      body: { ok: true }
    });

    await store.createRefund({
      paymentId: "payment_buyer_sync_1",
      wallet: "fast1buyerhistory0000000000000000000000000000000000000000000000000",
      amount: "50000"
    });
    const pendingRefund = await store.getRefundByPaymentId("payment_buyer_sync_1");
    expect(pendingRefund).toBeTruthy();
    await store.markRefundSent(pendingRefund!.id, "0xrefundsent");

    await store.saveAsyncAcceptance({
      paymentId: "payment_buyer_async_1",
      normalizedRequestHash: "hash_async_1",
      buyerWallet: "fast1buyerhistory0000000000000000000000000000000000000000000000000",
      route: asyncReport!,
      quotedPrice: "150000",
      payoutSplit: buildEscrowSplit({
        providerAccountId: "provider_marketplace",
        providerWallet: null,
        marketplaceAmount: "150000",
        providerAmount: "0",
        marketplaceBps: 10000,
        providerBps: 0
      }),
      paymentPayload: "payload_async_1",
      facilitatorResponse: { isValid: true },
      jobToken: "job_buyer_async_1",
      requestId: "request_async_1",
      providerJobId: "provider_job_async_1",
      requestBody: { topic: "market maps" },
      responseBody: { jobToken: "job_buyer_async_1" }
    });
    await store.failJob("job_buyer_async_1", "provider timeout");

    const activity = await store.listBuyerActivity({
      wallet: "fast1buyerhistory0000000000000000000000000000000000000000000000000",
      range: "30d",
      limit: 10
    });

    expect(activity.summary).toMatchObject({
      totalSpend: "0.20",
      totalRefunded: "0.05",
      netSpend: "0.15",
      paidCallCount: 2,
      serviceCount: 1
    });
    expect(activity.items).toHaveLength(2);
    expect(activity.items).toContainEqual(expect.objectContaining({
      paymentId: "payment_buyer_async_1",
      status: "failed",
      route: expect.objectContaining({
        ref: "mock.async-report",
        billingType: "fixed_x402"
      }),
      job: expect.objectContaining({
        jobToken: "job_buyer_async_1",
        status: "failed"
      })
    }));
    expect(activity.items).toContainEqual(expect.objectContaining({
      paymentId: "payment_buyer_sync_1",
      status: "refunded",
      refund: expect.objectContaining({
        status: "sent",
        amount: "0.05",
        txHash: "0xrefundsent"
      }),
      service: expect.objectContaining({
        slug: "mock-research-signals",
        name: "Mock Research Signals"
      })
    }));
  });

  it("maps buyer activity rows from the Postgres store query", async () => {
    const store = new PostgresMarketplaceStore({
      async query(sql: string) {
        if (sql.includes("FROM idempotency_records i")) {
          return {
            rowCount: 1,
            rows: [
              {
                payment_id: "payment_pg_1",
                provider_payout_source_kind: "credit_topup",
                response_kind: "sync",
                response_status_code: 200,
                quoted_price: "25000000",
                payout_split: buildEscrowSplit({
                  providerAccountId: "provider_marketplace",
                  providerWallet: null,
                  marketplaceAmount: "25000000",
                  providerAmount: "0",
                  marketplaceBps: 10000,
                  providerBps: 0
                }),
                route_id: "orders.topup.v1",
                created_at: TEST_TIMESTAMP,
                job_token: null,
                job_status: null,
                refund_status: "sent",
                refund_amount: "25000000",
                refund_tx_hash: "0xtopuprefund",
                provider: "orders",
                operation: "topup",
                title: "Top Up",
                mode: "sync",
                billing: { type: "topup_x402_variable" },
                service_id: "service_orders",
                service_slug: "order-desk",
                service_name: "Order Desk"
              }
            ]
          };
        }

        return { rowCount: 0, rows: [] };
      },
      connect: async () => ({
        query: async () => ({ rowCount: 0, rows: [] }),
        release() {}
      })
    } as never);

    const activity = await store.listBuyerActivity({
      wallet: "fast1buyerhistory0000000000000000000000000000000000000000000000000",
      range: "all",
      limit: 10
    });

    expect(activity.items).toEqual([
      expect.objectContaining({
        paymentId: "payment_pg_1",
        kind: "credit_topup",
        status: "refunded",
        amount: "25",
        service: {
          slug: "order-desk",
          name: "Order Desk"
        },
        route: {
          ref: "orders.topup",
          title: "Top Up",
          mode: "sync",
          billingType: "topup_x402_variable"
        },
        refund: {
          status: "sent",
          amount: "25",
          txHash: "0xtopuprefund"
        }
      })
    ]);
  });
});
