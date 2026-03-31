import { rawToDecimalString } from "./amounts.js";
import {
  isFixedX402Billing,
  isFreeBilling,
  isPrepaidCreditBilling,
  isTopupX402Billing,
  quotedPriceRaw,
  requiresWalletSession,
  requiresX402Payment,
  routePriceLabel
} from "./billing.js";
import {
  PAYMENT_IDENTIFIER_HEADER,
  PAYMENT_REQUIRED_HEADER,
  PAYMENT_RESPONSE_HEADER,
  PAYMENT_SIGNATURE_HEADER
} from "./constants.js";
import { getDefaultMarketplaceNetworkConfig, getMarketplaceTokenSymbol } from "./network.js";
import { serializeQueryInput } from "./request-input.js";
import { settlementModeDescription, settlementModeLabel } from "./settlement.js";
import type {
  CatalogSearchFilters,
  CatalogSearchResult,
  ExternalRegistryServiceSummary,
  ExternalServiceCatalogEndpoint,
  MarketplaceRoute,
  MarketplaceRouteAuthRequirement,
  MarketplaceRouteDetail,
  MarketplaceRouteSearchSummary,
  MarketplaceServiceCatalogEndpoint,
  MarketplaceServiceSummary,
  PublishedExternalEndpointVersionRecord,
  PublishedEndpointVersionRecord,
  PublishedServiceEndpointVersionRecord,
  RouteSearchResult,
  ServiceAnalytics,
  ServiceDefinition,
  ServiceDetail,
  ServiceSearchResult,
  ServiceSummary
} from "./types.js";

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/$/, "")}${path.startsWith("/") ? path : `/${path}`}`;
}

type PublishedCatalogService = {
  service: ServiceDefinition;
  endpoints: PublishedServiceEndpointVersionRecord[];
};

type PublishedCatalogServiceWithAnalytics = PublishedCatalogService & {
  analytics: ServiceAnalytics;
};

function roundToSingleDecimal(value: number): number {
  return Math.round(value * 10) / 10;
}

function formatPriceLabelFromRaw(rawAmount: string, tokenSymbol: MarketplaceServiceCatalogEndpoint["tokenSymbol"]): string {
  return `$${rawToDecimalString(rawAmount, 6)} ${tokenSymbol}`;
}

function billingTypeUsesTokenPrice(billingType: MarketplaceServiceCatalogEndpoint["billingType"]): boolean {
  return billingType === "fixed_x402" || billingType === "topup_x402_variable";
}

function isMarketplaceEndpoint(
  endpoint: PublishedServiceEndpointVersionRecord
): endpoint is PublishedEndpointVersionRecord {
  return endpoint.endpointType === "marketplace_proxy";
}

function isExternalEndpoint(
  endpoint: PublishedServiceEndpointVersionRecord
): endpoint is PublishedExternalEndpointVersionRecord {
  return endpoint.endpointType === "external_registry";
}

function normalizeSearchText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function tokenizeSearchQuery(query?: string): string[] {
  const normalized = normalizeSearchText(query ?? "");
  return normalized ? normalized.split(/\s+/).filter(Boolean) : [];
}

function scoreTextMatch(tokens: string[], fields: Array<string | null | undefined>): number {
  if (tokens.length === 0) {
    return 0;
  }

  const normalizedFields = fields
    .map((field) => normalizeSearchText(field ?? ""))
    .filter((field) => field.length > 0);
  if (normalizedFields.length === 0) {
    return -1;
  }

  let matchedTokens = 0;
  let score = 0;
  for (const token of tokens) {
    let tokenScore = 0;
    for (const field of normalizedFields) {
      const words = field.split(/\s+/);
      if (field === token) {
        tokenScore = Math.max(tokenScore, 12);
        continue;
      }
      if (words.includes(token)) {
        tokenScore = Math.max(tokenScore, 8);
        continue;
      }
      if (field.includes(token)) {
        tokenScore = Math.max(tokenScore, 4);
      }
    }

    if (tokenScore > 0) {
      matchedTokens += 1;
      score += tokenScore;
    }
  }

  return matchedTokens > 0 ? score : -1;
}

function matchesCategory(categories: string[], category?: string): boolean {
  if (!category) {
    return true;
  }

  const normalizedCategory = normalizeSearchText(category);
  return categories.some((candidate) => normalizeSearchText(candidate) === normalizedCategory);
}

function compareSearchResultIdentity(left: CatalogSearchResult, right: CatalogSearchResult): number {
  const leftIdentity = left.kind === "route" ? left.summary.ref : left.summary.slug;
  const rightIdentity = right.kind === "route" ? right.summary.ref : right.summary.slug;
  return leftIdentity.localeCompare(rightIdentity);
}

function buildServiceSearchResult(input: {
  summary: ServiceSummary;
  routeRefs: string[];
}): ServiceSearchResult {
  return {
    kind: "service",
    summary: input.summary,
    executableByMarketplace: input.summary.serviceType === "marketplace_proxy",
    routeRefs: input.routeRefs
  };
}

function buildRouteSearchResult(input: {
  summary: MarketplaceRouteSearchSummary;
}): RouteSearchResult {
  return {
    kind: "route",
    summary: input.summary
  };
}

export function buildRouteRef(input: Pick<MarketplaceRoute, "provider" | "operation">): string {
  return `${input.provider}.${input.operation}`;
}

export function buildRouteAuthRequirement(route: MarketplaceRoute): MarketplaceRouteAuthRequirement {
  if (requiresX402Payment(route)) {
    return {
      type: "x402",
      description: "Requires x402 payment headers and Fast wallet authorization.",
      paymentProtocol: "x402",
      paymentHeaders: {
        required: PAYMENT_REQUIRED_HEADER,
        signature: PAYMENT_SIGNATURE_HEADER,
        response: PAYMENT_RESPONSE_HEADER,
        paymentIdentifier: PAYMENT_IDENTIFIER_HEADER
      }
    };
  }

  if (requiresWalletSession(route)) {
    return {
      type: "wallet_session",
      description: "Requires a wallet-bound bearer token scoped to the route.",
      authorizationScheme: "Bearer",
      challengeEndpoint: "/auth/challenge",
      sessionEndpoint: "/auth/session",
      resourceType: "api"
    };
  }

  return {
    type: "none",
    description: "No payment headers or bearer token required."
  };
}

export function formatRevenueLabel(rawAmount: string): string {
  return rawToDecimalString(rawAmount, 6);
}

function getRouteTokenSymbol(route: Pick<MarketplaceRoute, "network">): MarketplaceServiceCatalogEndpoint["tokenSymbol"] {
  return getMarketplaceTokenSymbol(route.network);
}

function getRoutesTokenSymbol(routes: Array<Pick<MarketplaceRoute, "network">>): MarketplaceServiceCatalogEndpoint["tokenSymbol"] {
  return routes[0] ? getRouteTokenSymbol(routes[0]) : getDefaultMarketplaceNetworkConfig().tokenSymbol;
}

export function buildPriceRange(routes: MarketplaceRoute[]): string {
  const tokenSymbol = getRoutesTokenSymbol(routes);
  const fixedRoutes = routes
    .filter(isFixedX402Billing)
    .map((route) => quotedPriceRaw(route))
    .sort((left, right) => {
      const leftAmount = BigInt(left);
      const rightAmount = BigInt(right);

      if (leftAmount < rightAmount) {
        return -1;
      }

      if (leftAmount > rightAmount) {
        return 1;
      }

      return 0;
    });

  const labels: string[] = [];
  if (fixedRoutes.length > 0) {
    const minimum = formatPriceLabelFromRaw(fixedRoutes[0] ?? "0", tokenSymbol);
    const maximum = formatPriceLabelFromRaw(fixedRoutes[fixedRoutes.length - 1] ?? "0", tokenSymbol);
    labels.push(minimum === maximum ? minimum : `${minimum} - ${maximum}`);
  }
  if (routes.some(isTopupX402Billing)) {
    labels.push("Variable top-up");
  }
  if (routes.some(isFreeBilling)) {
    labels.push("Free");
  }
  if (routes.some(isPrepaidCreditBilling)) {
    labels.push("Prepaid credit");
  }

  return labels.join(" + ") || "Free";
}

export function buildMarketplaceServiceEndpoint(
  route: MarketplaceRoute & { endpointType?: "marketplace_proxy" },
  apiBaseUrl: string
): MarketplaceServiceCatalogEndpoint {
  const path = `/api/${route.provider}/${route.operation}`;
  const tokenSymbol = getRouteTokenSymbol(route);

  return {
    endpointType: "marketplace_proxy",
    routeId: route.routeId,
    ref: buildRouteRef(route),
    title: route.title,
    description: route.description,
    price: routePriceLabel(route),
    billingType: route.billing.type,
    tokenSymbol,
    mode: route.mode,
    method: route.method,
    path,
    proxyUrl: joinUrl(apiBaseUrl, path),
    authRequirement: buildRouteAuthRequirement(route),
    requestSchemaJson: route.requestSchemaJson,
    responseSchemaJson: route.responseSchemaJson,
    requestExample: route.requestExample,
    responseExample: route.responseExample,
    usageNotes: route.usageNotes
  };
}

export function buildMarketplaceRouteSearchSummary(input: {
  route: MarketplaceRoute;
  service: ServiceDefinition;
  apiBaseUrl: string;
}): MarketplaceRouteSearchSummary {
  const endpoint = buildMarketplaceServiceEndpoint(input.route, input.apiBaseUrl);
  const settlementMode = input.route.settlementMode;

  return {
    ref: buildRouteRef(input.route),
    routeId: input.route.routeId,
    provider: input.route.provider,
    operation: input.route.operation,
    serviceSlug: input.service.slug,
    serviceName: input.service.name,
    ownerName: input.service.ownerName,
    categories: input.service.categories,
    title: input.route.title,
    description: input.route.description,
    price: endpoint.price,
    billingType: endpoint.billingType,
    tokenSymbol: endpoint.tokenSymbol,
    mode: endpoint.mode,
    method: endpoint.method,
    path: endpoint.path,
    proxyUrl: endpoint.proxyUrl,
    settlementMode,
    settlementLabel: settlementModeLabel(settlementMode),
    settlementDescription: settlementModeDescription(settlementMode),
    authRequirement: endpoint.authRequirement ?? buildRouteAuthRequirement(input.route),
    usageNotes: endpoint.usageNotes
  };
}

function buildMarketplaceCurlLines(endpoint: MarketplaceServiceCatalogEndpoint): string[] {
  if (endpoint.method === "GET") {
    const queryString = serializeQueryInput({
      schema: endpoint.requestSchemaJson,
      value: endpoint.requestExample,
      label: `${endpoint.routeId} request example`
    });
    return [`curl -X GET "${endpoint.proxyUrl}${queryString}"`];
  }

  return [
    `curl -X ${endpoint.method} "${endpoint.proxyUrl}" \\`,
    '  -H "Content-Type: application/json" \\',
    `  -d '${JSON.stringify(endpoint.requestExample, null, 2)}'`
  ];
}

export function buildExternalServiceEndpoint(
  endpoint: PublishedExternalEndpointVersionRecord
): ExternalServiceCatalogEndpoint {
  return {
    endpointType: "external_registry",
    endpointId: endpoint.endpointVersionId,
    title: endpoint.title,
    description: endpoint.description,
    method: endpoint.method,
    publicUrl: endpoint.publicUrl,
    docsUrl: endpoint.docsUrl,
    authNotes: endpoint.authNotes,
    requestExample: endpoint.requestExample,
    responseExample: endpoint.responseExample,
    usageNotes: endpoint.usageNotes
  };
}

function buildMarketplaceUseThisServicePrompt(input: {
  service: ServiceDefinition;
  endpoints: MarketplaceServiceCatalogEndpoint[];
  skillUrl: string;
}): string {
  const lines = [
    input.service.promptIntro,
    "",
    "## Setup (skip if you already have Fast Marketplace set up)",
    `1. Open the marketplace skill: ${input.skillUrl}`,
    ...input.service.setupInstructions.map((step, index) => `${index + 2}. ${step}`),
    "",
    "## Available Endpoints"
  ];

  for (const endpoint of input.endpoints) {
    lines.push(
      "",
      `### ${endpoint.title} (${endpoint.price}${billingTypeUsesTokenPrice(endpoint.billingType) ? ` ${endpoint.tokenSymbol}` : ""})`,
      ...buildMarketplaceCurlLines(endpoint)
    );

    if (endpoint.usageNotes) {
      lines.push("", endpoint.usageNotes);
    }
  }

  if (input.endpoints.some((endpoint) => endpoint.billingType === "fixed_x402" || endpoint.billingType === "topup_x402_variable")) {
    lines.push(
      "",
      "For paid endpoints: the first call returns 402. Authorize payment with your Fast wallet and retry with the payment signature header."
    );
  }

  if (input.endpoints.some((endpoint) => endpoint.billingType === "prepaid_credit")) {
    lines.push(
      "",
      "For prepaid-credit endpoints: buy credit first, then invoke the route with a wallet session bearer token so the marketplace can debit your stored balance."
    );
  }

  if (input.endpoints.some((endpoint) => endpoint.billingType === "free" && endpoint.mode === "async")) {
    lines.push(
      "",
      "For free async endpoints: create a route-scoped wallet session first, invoke the route with the bearer token, then create a job-scoped wallet session and poll GET /api/jobs/{jobToken} with Authorization: Bearer <accessToken>."
    );
  }

  if (input.endpoints.some((endpoint) => endpoint.billingType === "free" && endpoint.mode === "sync")) {
    lines.push(
      "",
      "For free endpoints: call the marketplace route directly with the published method and request example. No payment headers are required."
    );
  }

  return lines.join("\n");
}

function buildExternalUseThisServicePrompt(input: {
  service: ServiceDefinition;
  endpoints: ExternalServiceCatalogEndpoint[];
}): string {
  const lines = [
    input.service.promptIntro,
    "",
    "## Access model",
    "This is a discovery-only external API. Calls go directly to the provider; the marketplace does not proxy, authenticate, or settle them.",
    "",
    "## Setup",
    ...input.service.setupInstructions.map((step, index) => `${index + 1}. ${step}`),
    "",
    "## External Endpoints"
  ];

  for (const endpoint of input.endpoints) {
    lines.push(
      "",
      `### ${endpoint.title}`,
      `Method: ${endpoint.method}`,
      `Direct URL: ${endpoint.publicUrl}`,
      `Docs: ${endpoint.docsUrl}`
    );

    if (endpoint.authNotes) {
      lines.push(`Auth: ${endpoint.authNotes}`);
    }

    if (endpoint.method === "GET") {
      lines.push(`curl -X GET "${endpoint.publicUrl}"`);
    } else {
      lines.push(
        `curl -X POST "${endpoint.publicUrl}" \\`,
        '  -H "Content-Type: application/json" \\',
        `  -d '${JSON.stringify(endpoint.requestExample, null, 2)}'`
      );
    }

    if (endpoint.usageNotes) {
      lines.push("", endpoint.usageNotes);
    }
  }

  return lines.join("\n");
}

export function buildServiceSummary(input: {
  service: ServiceDefinition;
  endpoints: PublishedServiceEndpointVersionRecord[];
  analytics: ServiceAnalytics;
}): ServiceSummary {
  if (input.service.serviceType === "external_registry") {
    const summary: ExternalRegistryServiceSummary = {
      serviceType: "external_registry",
      slug: input.service.slug,
      name: input.service.name,
      ownerName: input.service.ownerName,
      tagline: input.service.tagline,
      categories: input.service.categories,
      settlementMode: null,
      settlementLabel: "External API",
      settlementDescription: "Calls go directly to the provider. The marketplace lists discovery metadata only.",
      priceRange: "See provider docs",
      settlementToken: null,
      totalCalls: null,
      revenue: null,
      successRate30d: null,
      volume30d: [],
      accessModelLabel: "External API",
      accessModelDescription: "Calls go directly to the provider. The marketplace only lists docs and direct endpoints.",
      endpointCount: input.endpoints.filter(isExternalEndpoint).length,
      websiteUrl: input.service.websiteUrl
    };

    return summary;
  }

  const routes = input.endpoints.filter(isMarketplaceEndpoint);
  const settlementMode = input.service.settlementMode ?? "verified_escrow";
  const settlementToken = getRoutesTokenSymbol(routes);

  const summary: MarketplaceServiceSummary = {
    serviceType: "marketplace_proxy",
    slug: input.service.slug,
    name: input.service.name,
    ownerName: input.service.ownerName,
    tagline: input.service.tagline,
    categories: input.service.categories,
    settlementMode,
    settlementLabel: settlementModeLabel(settlementMode),
    settlementDescription: settlementModeDescription(settlementMode),
    priceRange: buildPriceRange(routes),
    settlementToken,
    endpointCount: routes.length,
    totalCalls: input.analytics.totalCalls,
    revenue: formatRevenueLabel(input.analytics.revenueRaw),
    successRate30d: roundToSingleDecimal(input.analytics.successRate30d),
    websiteUrl: input.service.websiteUrl,
    volume30d: input.analytics.volume30d.map((point) => ({
      date: point.date,
      amount: rawToDecimalString(point.amountRaw, 6)
    }))
  };

  return summary;
}

export function buildMarketplaceRouteDetail(input: {
  route: PublishedEndpointVersionRecord;
  service: ServiceDefinition;
  serviceEndpoints: PublishedServiceEndpointVersionRecord[];
  analytics: ServiceAnalytics;
  apiBaseUrl: string;
}): MarketplaceRouteDetail {
  const endpoint = buildMarketplaceServiceEndpoint(input.route, input.apiBaseUrl);
  const serviceSummary = buildServiceSummary({
    service: input.service,
    endpoints: input.serviceEndpoints,
    analytics: input.analytics
  });
  if (serviceSummary.serviceType !== "marketplace_proxy") {
    throw new Error("Expected a marketplace proxy service summary.");
  }

  return {
    kind: "route",
    ref: buildRouteRef(input.route),
    routeId: input.route.routeId,
    provider: input.route.provider,
    operation: input.route.operation,
    serviceSlug: input.service.slug,
    serviceName: input.service.name,
    ownerName: input.service.ownerName,
    categories: input.service.categories,
    title: input.route.title,
    description: input.route.description,
    price: endpoint.price,
    billingType: endpoint.billingType,
    tokenSymbol: endpoint.tokenSymbol,
    mode: endpoint.mode,
    method: endpoint.method,
    path: endpoint.path,
    proxyUrl: endpoint.proxyUrl,
    settlementMode: input.route.settlementMode,
    settlementLabel: settlementModeLabel(input.route.settlementMode),
    settlementDescription: settlementModeDescription(input.route.settlementMode),
    authRequirement: endpoint.authRequirement ?? buildRouteAuthRequirement(input.route),
    requestSchemaJson: endpoint.requestSchemaJson,
    responseSchemaJson: endpoint.responseSchemaJson,
    requestExample: endpoint.requestExample,
    responseExample: endpoint.responseExample,
    usageNotes: endpoint.usageNotes,
    asyncConfig: input.route.asyncConfig ?? null,
    serviceSummary
  };
}

export function buildCatalogSearchResults(input: {
  services: PublishedCatalogServiceWithAnalytics[];
  apiBaseUrl: string;
  filters?: CatalogSearchFilters;
}): CatalogSearchResult[] {
  const filters = input.filters ?? {};
  const queryTokens = tokenizeSearchQuery(filters.q);
  const results: Array<{ score: number; result: CatalogSearchResult }> = [];

  for (const serviceDetail of input.services) {
    const summary = buildServiceSummary({
      service: serviceDetail.service,
      endpoints: serviceDetail.endpoints,
      analytics: serviceDetail.analytics
    });
    const serviceCategories = serviceDetail.service.categories;
    if (!matchesCategory(serviceCategories, filters.category)) {
      continue;
    }

    const marketplaceRoutes = serviceDetail.endpoints.filter(isMarketplaceEndpoint);
    const filteredRoutes = marketplaceRoutes.filter((route) => {
      if (filters.billingType && route.billing.type !== filters.billingType) {
        return false;
      }
      if (filters.mode && route.mode !== filters.mode) {
        return false;
      }
      if (filters.settlementMode && route.settlementMode !== filters.settlementMode) {
        return false;
      }
      return true;
    });

    if (
      (filters.billingType || filters.mode)
      && serviceDetail.service.serviceType !== "marketplace_proxy"
    ) {
      continue;
    }

    if (
      filters.settlementMode
      && serviceDetail.service.serviceType === "marketplace_proxy"
      && (serviceDetail.service.settlementMode ?? "verified_escrow") !== filters.settlementMode
      && filteredRoutes.length === 0
    ) {
      continue;
    }

    if (serviceDetail.service.serviceType === "external_registry" && filters.settlementMode) {
      continue;
    }

    if (
      serviceDetail.service.serviceType === "marketplace_proxy"
      && (filters.billingType || filters.mode || filters.settlementMode)
      && filteredRoutes.length === 0
    ) {
      continue;
    }

    const serviceScore = scoreTextMatch(queryTokens, [
      serviceDetail.service.slug,
      serviceDetail.service.name,
      serviceDetail.service.ownerName,
      serviceDetail.service.tagline,
      serviceDetail.service.about,
      serviceDetail.service.promptIntro,
      ...serviceDetail.service.categories
    ]);
    const scoredRoutes = filteredRoutes.map((route) => {
      const ref = buildRouteRef(route);
      return {
        route,
        ref,
        score: scoreTextMatch(queryTokens, [
          ref,
          route.routeId,
          route.provider,
          route.operation,
          route.title,
          route.description,
          route.usageNotes,
          serviceDetail.service.slug,
          serviceDetail.service.name,
          serviceDetail.service.ownerName,
          ...serviceDetail.service.categories
        ])
      };
    });
    const maxRouteScore = scoredRoutes.reduce((highest, candidate) => Math.max(highest, candidate.score), -1);
    const matchingRouteRefs = (queryTokens.length === 0
      ? scoredRoutes
      : scoredRoutes.filter((candidate) => candidate.score >= 0))
      .map((candidate) => candidate.ref)
      .sort((left, right) => left.localeCompare(right));
    if (queryTokens.length === 0 || serviceScore >= 0 || maxRouteScore >= 0) {
      results.push({
        score: Math.max(serviceScore, maxRouteScore > 0 ? maxRouteScore - 1 : maxRouteScore),
        result: buildServiceSearchResult({
          summary,
          routeRefs: serviceDetail.service.serviceType === "marketplace_proxy" ? matchingRouteRefs : []
        })
      });
    }

    for (const { route, score: routeScore } of scoredRoutes) {
      if (queryTokens.length > 0 && routeScore < 0) {
        continue;
      }

      results.push({
        score: routeScore,
        result: buildRouteSearchResult({
          summary: buildMarketplaceRouteSearchSummary({
            route,
            service: serviceDetail.service,
            apiBaseUrl: input.apiBaseUrl
          })
        })
      });
    }
  }

  const sorted = results
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      if (left.result.kind !== right.result.kind) {
        return left.result.kind === "route" ? -1 : 1;
      }
      return compareSearchResultIdentity(left.result, right.result);
    })
    .map((entry) => entry.result);

  return typeof filters.limit === "number" ? sorted.slice(0, filters.limit) : sorted;
}

export function buildServiceDetail(input: {
  service: ServiceDefinition;
  endpoints: PublishedServiceEndpointVersionRecord[];
  analytics: ServiceAnalytics;
  apiBaseUrl: string;
  webBaseUrl: string;
}): ServiceDetail {
  if (input.service.serviceType === "external_registry") {
    const endpoints = input.endpoints.filter(isExternalEndpoint).map((endpoint) => buildExternalServiceEndpoint(endpoint));
    const summary = buildServiceSummary({
      service: input.service,
      endpoints: input.endpoints,
      analytics: input.analytics
    });
    if (summary.serviceType !== "external_registry") {
      throw new Error("Expected an external registry service summary.");
    }

    return {
      serviceType: "external_registry",
      summary,
      about: input.service.about,
      useThisServicePrompt: buildExternalUseThisServicePrompt({
        service: input.service,
        endpoints
      }),
      skillUrl: null,
      websiteUrl: input.service.websiteUrl,
      endpoints
    };
  }

  const endpoints = input.endpoints.filter(isMarketplaceEndpoint).map((route) => buildMarketplaceServiceEndpoint(route, input.apiBaseUrl));
  const skillUrl = joinUrl(input.webBaseUrl, "/skill.md");
  const summary = buildServiceSummary({
    service: input.service,
    endpoints: input.endpoints,
    analytics: input.analytics
  });
  if (summary.serviceType !== "marketplace_proxy") {
    throw new Error("Expected a marketplace proxy service summary.");
  }

  return {
    serviceType: "marketplace_proxy",
    summary,
    about: input.service.about,
    useThisServicePrompt: buildMarketplaceUseThisServicePrompt({
      service: input.service,
      endpoints,
      skillUrl
    }),
    skillUrl,
    endpoints
  };
}
