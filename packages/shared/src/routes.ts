import { z } from "zod";

import { getDefaultMarketplaceNetworkConfig, type MarketplaceNetworkConfig } from "./network.js";
import type { MarketplaceRoute } from "./types.js";

export const quickInsightInputSchema = z.object({
  query: z.string().min(1).max(240)
});

export const quickInsightOutputSchema = z.object({
  provider: z.literal("mock"),
  operation: z.literal("quick-insight"),
  query: z.string(),
  summary: z.string(),
  generatedAt: z.string()
});

export const asyncReportInputSchema = z.object({
  topic: z.string().min(1).max(240),
  delayMs: z.number().int().min(1_000).max(60_000).optional(),
  shouldFail: z.boolean().optional()
});

export const asyncReportOutputSchema = z.object({
  provider: z.literal("mock"),
  operation: z.literal("async-report"),
  topic: z.string(),
  report: z.string(),
  completedAt: z.string()
});

export function buildMarketplaceRoutes(config: MarketplaceNetworkConfig = getDefaultMarketplaceNetworkConfig()): MarketplaceRoute[] {
  return [
    {
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
      payout: {
        providerAccountId: "mock",
        providerWallet: null,
        providerBps: 0
      },
      inputSchema: quickInsightInputSchema,
      outputSchema: quickInsightOutputSchema
    },
    {
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
      usageNotes: "Use this when the upstream data source has variable latency and the result should be polled asynchronously.",
      payout: {
        providerAccountId: "mock",
        providerWallet: null,
        providerBps: 0
      },
      inputSchema: asyncReportInputSchema,
      outputSchema: asyncReportOutputSchema
    }
  ];
}

export const marketplaceRoutes: MarketplaceRoute[] = buildMarketplaceRoutes();

export function findMarketplaceRoute(provider: string, operation: string): MarketplaceRoute | undefined {
  return marketplaceRoutes.find(
    (route) => route.provider === provider && route.operation === operation
  );
}

export function findMarketplaceRouteById(routeId: string): MarketplaceRoute | undefined {
  return marketplaceRoutes.find((route) => route.routeId === routeId);
}
