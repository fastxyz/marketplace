// @vitest-environment jsdom

import React from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { CatalogSnapshotCard } from "./catalog-snapshot-card";

describe("CatalogSnapshotCard", () => {
  it("renders aggregate marketplace totals", () => {
    render(
      <CatalogSnapshotCard
        services={[
          {
            serviceType: "marketplace_proxy",
            slug: "mock-research-signals",
            name: "Mock Research Signals",
            ownerName: "Fast Marketplace",
            tagline: "Synthetic paid research endpoints.",
            categories: ["Research", "Testing"],
            settlementMode: "verified_escrow",
            settlementLabel: "Verified",
            settlementDescription: "Marketplace escrow, refunds, and payout reconciliation.",
            priceRange: "$0.05 USDC - $0.15 USDC",
            settlementToken: "USDC",
            endpointCount: 2,
            totalCalls: 12,
            revenue: "0.42",
            successRate30d: 66.7,
            volume30d: []
          },
          {
            serviceType: "marketplace_proxy",
            slug: "weather-wire",
            name: "Weather Wire",
            ownerName: "Sky Data",
            tagline: "Forecast and alert APIs for agents.",
            categories: ["Weather"],
            settlementMode: "community_direct",
            settlementLabel: "Community",
            settlementDescription: "Direct provider payment with provider-managed refunds and support.",
            priceRange: "$0.01 USDC",
            settlementToken: "USDC",
            endpointCount: 1,
            totalCalls: 4,
            revenue: "0.04",
            successRate30d: 100,
            volume30d: []
          }
        ]}
      />
    );

    expect(screen.getByText("Marketplace totals")).toBeTruthy();
    expect(screen.getByText("Catalog snapshot")).toBeTruthy();
    expect(screen.getByText("2")).toBeTruthy();
    expect(screen.getByText("3")).toBeTruthy();
    expect(screen.getByText("16")).toBeTruthy();
    expect(screen.getByText("$0.46")).toBeTruthy();
  });
});
