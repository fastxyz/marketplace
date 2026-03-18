import { quotedPriceRaw } from "./payment.js";
import { findMarketplaceRouteById } from "./routes.js";
import { findMarketplaceServiceBySlug } from "./services.js";
import { rawToDecimalString } from "./amounts.js";
import { getDefaultMarketplaceNetworkConfig } from "./network.js";
import type {
  MarketplaceRoute,
  ServiceAnalytics,
  ServiceCatalogEndpoint,
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

export function formatRevenueLabel(rawAmount: string): string {
  return rawToDecimalString(rawAmount, 6);
}

export function buildPriceRange(routes: MarketplaceRoute[]): string {
  const tokenSymbol = getDefaultMarketplaceNetworkConfig().tokenSymbol;
  const sorted = routes
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

  const minimum = formatPriceLabelFromRaw(sorted[0] ?? "0", tokenSymbol);
  const maximum = formatPriceLabelFromRaw(sorted[sorted.length - 1] ?? "0", tokenSymbol);

  return minimum === maximum ? minimum : `${minimum} - ${maximum}`;
}

export function getRoutesForService(service: ServiceDefinition): MarketplaceRoute[] {
  return service.routeIds.map((routeId) => {
    const route = findMarketplaceRouteById(routeId);
    if (!route) {
      throw new Error(`Missing route registry entry for service ${service.slug}: ${routeId}`);
    }

    return route;
  });
}

export function buildServiceEndpoint(route: MarketplaceRoute, apiBaseUrl: string): ServiceCatalogEndpoint {
  const path = `/api/${route.provider}/${route.operation}`;
  const tokenSymbol = getDefaultMarketplaceNetworkConfig().tokenSymbol;

  return {
    routeId: route.routeId,
    title: route.title,
    description: route.description,
    price: route.price,
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

export function buildUseThisServicePrompt(input: {
  service: ServiceDefinition;
  endpoints: ServiceCatalogEndpoint[];
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
      `### ${endpoint.title} (${endpoint.price} ${endpoint.tokenSymbol})`,
      `curl -X ${endpoint.method} "${endpoint.proxyUrl}" \\`,
      '  -H "Content-Type: application/json" \\',
      `  -d '${JSON.stringify(endpoint.requestExample, null, 2)}'`
    );

    if (endpoint.usageNotes) {
      lines.push("", endpoint.usageNotes);
    }
  }

  if (input.endpoints.some((endpoint) => endpoint.price !== "$0")) {
    lines.push(
      "",
      "For paid endpoints: the first call returns 402. Authorize payment with your Fast wallet and retry with the payment signature header."
    );
  }

  return lines.join("\n");
}

export function buildServiceSummary(input: {
  service: ServiceDefinition;
  analytics: ServiceAnalytics;
}): ServiceSummary {
  const routes = getRoutesForService(input.service);

  return {
    slug: input.service.slug,
    name: input.service.name,
    ownerName: input.service.ownerName,
    tagline: input.service.tagline,
    categories: input.service.categories,
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
}

export function buildServiceDetail(input: {
  service: ServiceDefinition;
  analytics: ServiceAnalytics;
  apiBaseUrl: string;
  webBaseUrl: string;
}): ServiceDetail {
  const endpoints = getRoutesForService(input.service).map((route) => buildServiceEndpoint(route, input.apiBaseUrl));
  const skillUrl = joinUrl(input.webBaseUrl, "/skill.md");

  return {
    summary: buildServiceSummary({
      service: input.service,
      analytics: input.analytics
    }),
    about: input.service.about,
    useThisServicePrompt: buildUseThisServicePrompt({
      service: input.service,
      endpoints,
      skillUrl
    }),
    skillUrl,
    endpoints
  };
}

export function getServiceDefinition(slug: string): ServiceDefinition | undefined {
  return findMarketplaceServiceBySlug(slug);
}
