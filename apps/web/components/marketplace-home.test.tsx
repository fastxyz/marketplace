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
            priceRange: "$0.0001 USDC",
            settlementToken: "USDC",
            endpointCount: 2,
            totalCalls: 12,
            revenue: "0.42",
            successRate30d: 66.7,
            volume30d: [],
            websiteUrl: "https://www.amazon.com"
          },
          {
            serviceType: "external_registry",
            slug: "weather-wire",
            name: "Weather Wire",
            ownerName: "Sky Data",
            tagline: "Forecast and alert APIs for agents.",
            categories: ["Weather"],
            settlementMode: null,
            settlementLabel: "External API",
            settlementDescription: "Calls go directly to the provider. The marketplace lists discovery metadata only.",
            priceRange: "See provider docs",
            settlementToken: null,
            endpointCount: 1,
            totalCalls: null,
            revenue: null,
            successRate30d: null,
            volume30d: [],
            accessModelLabel: "External API",
            accessModelDescription: "Calls go directly to the provider. The marketplace only lists docs and direct endpoints.",
            websiteUrl: "https://weather.example.com"
          }
        ]}
      />
    );

    expect(screen.getByRole("heading", { name: "APIs for agents" })).toBeTruthy();
    expect(screen.getByRole("table")).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: /service/i })).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: /pricing/i })).toBeTruthy();
    expect(screen.getByText("Mock Research Signals")).toBeTruthy();
    expect(screen.getByText("Weather Wire")).toBeTruthy();
    expect(screen.getByRole("img", { name: "Mock Research Signals favicon" }).getAttribute("src")).toBe("https://www.amazon.com/favicon.ico");
    expect(screen.getByRole("img", { name: "Weather Wire favicon" }).getAttribute("src")).toBe("https://weather.example.com/favicon.ico");

    await user.type(screen.getByPlaceholderText("Search services, owners, or categories"), "weather");

    await waitFor(() => {
      expect(screen.queryByText("Mock Research Signals")).toBeNull();
    });

    expect(screen.getByText("Weather Wire")).toBeTruthy();
  });
});
