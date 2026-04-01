// @vitest-environment jsdom

import React from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import { ServicePage } from "./service-page";

const { useSearchParamsMock } = vi.hoisted(() => ({
  useSearchParamsMock: vi.fn()
}));

vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: { href: string; children: ReactNode }) => (
    <a href={href} {...props}>
      {children}
    </a>
  )
}));

vi.mock("next/navigation", () => ({
  useSearchParams: () => useSearchParamsMock()
}));

describe("ServicePage", () => {
  it("renders service stats, prompt copy, and simplified endpoint examples", async () => {
    const user = userEvent.setup();
    useSearchParamsMock.mockReturnValue({
      get: () => null
    });

    render(
      <ServicePage
        deploymentNetwork="mainnet"
        service={{
          serviceType: "marketplace_proxy",
          summary: {
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
            totalCalls: 18,
            revenue: "0.42",
            successRate30d: 75,
            volume30d: [{ date: "2026-03-18", amount: "0.15" }]
          },
          about: "A mock service for wallet and x402 smoke tests.",
          useThisServicePrompt: "I want to use the Mock Research Signals service.",
          skillUrl: "https://marketplace.example.com/skill.md",
          endpoints: [
            {
              endpointType: "marketplace_proxy",
              routeId: "mock.quick-insight.v1",
              title: "Quick Insight",
              description: "Instant paid insight.",
              price: "$0.0001",
              billingType: "fixed_x402",
              tokenSymbol: "USDC",
              mode: "sync",
              method: "POST",
              path: "/api/mock/quick-insight",
              proxyUrl: "https://api.marketplace.example.com/api/mock/quick-insight",
              requestSchemaJson: {
                type: "object",
                properties: {
                  query: { type: "string" }
                },
                required: ["query"],
                additionalProperties: false
              },
              responseSchemaJson: {
                type: "object",
                properties: {
                  summary: { type: "string" }
                },
                required: ["summary"],
                additionalProperties: false
              },
              requestExample: { query: "alpha" },
              responseExample: { summary: "alpha" },
              usageNotes: "Low-latency single request."
            }
          ]
        }}
      />
    );

    expect(screen.getByRole("heading", { name: "Mock Research Signals" })).toBeTruthy();
    expect(screen.getByText("A mock service for wallet and x402 smoke tests.")).toBeTruthy();
    expect(screen.getByText(/available endpoints \(1\)/i)).toBeTruthy();
    expect(screen.getByText("Suggest an endpoint")).toBeTruthy();
    expect(screen.getByText("Suggest a source")).toBeTruthy();
    expect(screen.getByText("Open canonical SKILL.md")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /quick insight/i }));
    expect(screen.getByText("Proxy URL")).toBeTruthy();
    expect(screen.getByText("https://api.marketplace.example.com/api/mock/quick-insight")).toBeTruthy();
    expect(screen.getByText("Request example")).toBeTruthy();
    expect(screen.getByText("Response example")).toBeTruthy();
    expect(screen.queryByText("Pay and run this endpoint with the Fast extension")).toBeNull();
    expect(screen.queryByText("Request body")).toBeNull();
  });

  it("opens the requested endpoint from the query string", () => {
    useSearchParamsMock.mockReturnValue({
      get: (key: string) => (key === "endpoint" ? "mock.quick-insight.v1" : null)
    });

    render(
      <ServicePage
        deploymentNetwork="mainnet"
        service={{
          serviceType: "marketplace_proxy",
          summary: {
            serviceType: "marketplace_proxy",
            slug: "mock-research-signals",
            name: "Mock Research Signals",
            ownerName: "Fast Marketplace",
            tagline: "Synthetic paid research endpoints.",
            categories: ["Research"],
            settlementMode: "verified_escrow",
            settlementLabel: "Verified",
            settlementDescription: "Marketplace escrow, refunds, and payout reconciliation.",
            priceRange: "$0.0001 USDC",
            settlementToken: "USDC",
            endpointCount: 1,
            totalCalls: 18,
            revenue: "0.42",
            successRate30d: 75,
            volume30d: []
          },
          about: "A mock service for wallet and x402 smoke tests.",
          useThisServicePrompt: "I want to use the Mock Research Signals service.",
          skillUrl: "https://marketplace.example.com/skill.md",
          endpoints: [
            {
              endpointType: "marketplace_proxy",
              routeId: "mock.quick-insight.v1",
              title: "Quick Insight",
              description: "Instant paid insight.",
              price: "$0.0001",
              billingType: "fixed_x402",
              tokenSymbol: "USDC",
              mode: "sync",
              method: "POST",
              path: "/api/mock/quick-insight",
              proxyUrl: "https://api.marketplace.example.com/api/mock/quick-insight",
              requestSchemaJson: { type: "object" },
              responseSchemaJson: { type: "object" },
              requestExample: { query: "alpha" },
              responseExample: { summary: "alpha" }
            }
          ]
        }}
      />
    );

    expect(screen.getAllByText("Proxy URL").length).toBeGreaterThan(0);
    expect(screen.getAllByText("https://api.marketplace.example.com/api/mock/quick-insight").length).toBeGreaterThan(0);
  });
});
