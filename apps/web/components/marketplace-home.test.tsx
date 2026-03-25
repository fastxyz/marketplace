// @vitest-environment jsdom

import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import { MarketplaceHome } from "./marketplace-home";

vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: { href: string; children: ReactNode }) => (
    <a href={href} {...props}>
      {children}
    </a>
  )
}));

describe("MarketplaceHome", () => {
  it("renders services and filters them by search", async () => {
    const user = userEvent.setup();

    render(
      <MarketplaceHome
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

    expect(screen.getByRole("heading", { name: "Data APIs for agents" })).toBeTruthy();
    expect(screen.queryByText("Explore marketplace")).toBeNull();
    expect(screen.queryByText("Suggest supply")).toBeNull();
    expect(screen.queryByText("FAST-native supply snapshot")).toBeNull();
    expect(screen.getByText("Mock Research Signals")).toBeTruthy();
    expect(screen.getByText("Weather Wire")).toBeTruthy();

    await user.type(screen.getByPlaceholderText("Search services, owners, or categories"), "weather");

    await waitFor(() => {
      expect(screen.queryByText("Mock Research Signals")).toBeNull();
    });

    expect(screen.getByText("Weather Wire")).toBeTruthy();
  });
});
