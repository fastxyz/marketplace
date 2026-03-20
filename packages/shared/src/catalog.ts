import { rawToDecimalString } from "./amounts.js";
import { isFixedX402Billing, isFreeBilling, isPrepaidCreditBilling, isTopupX402Billing, quotedPriceRaw, routePriceLabel } from "./billing.js";
import { getDefaultMarketplaceNetworkConfig } from "./network.js";
import { settlementModeDescription, settlementModeLabel } from "./settlement.js";
import type {
  ExternalRegistryServiceSummary,
  ExternalServiceCatalogEndpoint,
  MarketplaceRoute,
  MarketplaceServiceCatalogEndpoint,
  MarketplaceServiceSummary,
  PublishedExternalEndpointVersionRecord,
  PublishedEndpointVersionRecord,
  PublishedServiceEndpointVersionRecord,
  ServiceAnalytics,
  ServiceDefinition,
  ServiceDetail,
  ServiceSummary
} from "./types.js";

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/$/, "")}${path.startsWith("/") ? path : `/${path}`}`;
}

function roundToSingleDecimal(value: number): number {
  return Math.round(value * 10) / 10;
}

function formatPriceLabelFromRaw(rawAmount: string, tokenSymbol = getDefaultMarketplaceNetworkConfig().tokenSymbol): string {
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

export function formatRevenueLabel(rawAmount: string): string {
  return rawToDecimalString(rawAmount, 6);
}

export function buildPriceRange(routes: MarketplaceRoute[]): string {
  const tokenSymbol = getDefaultMarketplaceNetworkConfig().tokenSymbol;
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
  const tokenSymbol = getDefaultMarketplaceNetworkConfig().tokenSymbol;

  return {
    endpointType: "marketplace_proxy",
    routeId: route.routeId,
    title: route.title,
    description: route.description,
    price: routePriceLabel(route),
    billingType: route.billing.type,
    tokenSymbol,
    mode: route.mode,
    method: "POST",
    path,
    proxyUrl: joinUrl(apiBaseUrl, path),
    requestExample: route.requestExample,
    responseExample: route.responseExample,
    usageNotes: route.usageNotes
  };
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
      `curl -X ${endpoint.method} "${endpoint.proxyUrl}" \\`,
      '  -H "Content-Type: application/json" \\',
      `  -d '${JSON.stringify(endpoint.requestExample, null, 2)}'`
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

  if (input.endpoints.some((endpoint) => endpoint.billingType === "free")) {
    lines.push(
      "",
      "For free endpoints: send JSON directly to the marketplace route. No payment headers are required."
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
    settlementToken: getDefaultMarketplaceNetworkConfig().tokenSymbol,
    endpointCount: routes.length,
    totalCalls: input.analytics.totalCalls,
    revenue: formatRevenueLabel(input.analytics.revenueRaw),
    successRate30d: roundToSingleDecimal(input.analytics.successRate30d),
    volume30d: input.analytics.volume30d.map((point) => ({
      date: point.date,
      amount: rawToDecimalString(point.amountRaw, 6)
    }))
  };

  return summary;
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
