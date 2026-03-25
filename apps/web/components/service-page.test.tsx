// @vitest-environment jsdom

import React from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import { ServicePage } from "./service-page";

vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: { href: string; children: ReactNode }) => (
    <a href={href} {...props}>
      {children}
    </a>
  )
}));

describe("ServicePage", () => {
  it("renders service stats, prompt copy, and endpoint examples", async () => {
    const user = userEvent.setup();

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
            priceRange: "$0.05 USDC - $0.15 USDC",
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
              price: "$0.05",
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
    expect(screen.getByText("Open canonical SKILL.md")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /quick insight/i }));
    expect(screen.getByText("Pay and run this endpoint with the Fast extension")).toBeTruthy();
  });
});
