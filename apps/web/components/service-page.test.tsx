// @vitest-environment jsdom

import React from "react";
import { render, screen } from "@testing-library/react";
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
  it("renders service stats, prompt copy, and endpoint examples", () => {
    render(
      <ServicePage
        service={{
          summary: {
            slug: "mock-research-signals",
            name: "Mock Research Signals",
            ownerName: "Fast Marketplace",
            tagline: "Synthetic paid research endpoints.",
            categories: ["Research", "Testing"],
            priceRange: "$0.05 fastUSDC - $0.15 fastUSDC",
            settlementToken: "fastUSDC",
            endpointCount: 2,
            totalCalls: 18,
            revenue: "0.42",
            successRate30d: 75,
            volume30d: [{ date: "2026-03-18", amount: "0.15" }]
          },
          about: "A mock service for wallet and x402 smoke tests.",
          useThisServicePrompt: "I want to use the Mock Research Signals service.",
          skillUrl: "https://fast.8o.vc/skill.md",
          endpoints: [
            {
              routeId: "mock.quick-insight.v1",
              title: "Quick Insight",
              description: "Instant paid insight.",
              price: "$0.05",
              tokenSymbol: "fastUSDC",
              mode: "sync",
              method: "POST",
              path: "/api/mock/quick-insight",
              proxyUrl: "https://fastapi.8o.vc/api/mock/quick-insight",
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
    expect(screen.getByText("Available Endpoints (1)")).toBeTruthy();
    expect(screen.getByText("Open canonical SKILL.md")).toBeTruthy();
  });
});
