import { rawToDecimalString } from "./amounts.js";
import { isFixedX402Billing, isFreeBilling, isPrepaidCreditBilling, isTopupX402Billing, quotedPriceRaw, routePriceLabel } from "./billing.js";
import { getDefaultMarketplaceNetworkConfig } from "./network.js";
import { settlementModeDescription, settlementModeLabel } from "./settlement.js";
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

function billingTypeUsesTokenPrice(billingType: ServiceCatalogEndpoint["billingType"]): boolean {
  return billingType === "fixed_x402" || billingType === "topup_x402_variable";
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

export function buildServiceEndpoint(route: MarketplaceRoute, apiBaseUrl: string): ServiceCatalogEndpoint {
  const path = `/api/${route.provider}/${route.operation}`;
  const tokenSymbol = getDefaultMarketplaceNetworkConfig().tokenSymbol;

  return {
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

export function buildServiceSummary(input: {
  service: ServiceDefinition;
  endpoints: MarketplaceRoute[];
  analytics: ServiceAnalytics;
}): ServiceSummary {
  return {
    slug: input.service.slug,
    name: input.service.name,
    ownerName: input.service.ownerName,
    tagline: input.service.tagline,
    categories: input.service.categories,
    settlementMode: input.service.settlementMode,
    settlementLabel: settlementModeLabel(input.service.settlementMode),
    settlementDescription: settlementModeDescription(input.service.settlementMode),
    priceRange: buildPriceRange(input.endpoints),
    settlementToken: getDefaultMarketplaceNetworkConfig().tokenSymbol,
    endpointCount: input.endpoints.length,
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
  endpoints: MarketplaceRoute[];
  analytics: ServiceAnalytics;
  apiBaseUrl: string;
  webBaseUrl: string;
}): ServiceDetail {
  const endpoints = input.endpoints.map((route) => buildServiceEndpoint(route, input.apiBaseUrl));
  const skillUrl = joinUrl(input.webBaseUrl, "/skill.md");

  return {
    summary: buildServiceSummary({
      service: input.service,
      endpoints: input.endpoints,
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
