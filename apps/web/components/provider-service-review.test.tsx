// @vitest-environment jsdom

import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ProviderServiceReview } from "./provider-service-review";

const fetchProviderService = vi.fn();
const fetchProviderRuntimeKey = vi.fn();
const submitProviderService = vi.fn();

vi.mock("@/lib/api", () => ({
  fetchProviderService: (...args: unknown[]) => fetchProviderService(...args),
  fetchProviderRuntimeKey: (...args: unknown[]) => fetchProviderRuntimeKey(...args),
  submitProviderService: (...args: unknown[]) => submitProviderService(...args)
}));

function buildServiceDetail(overrides?: {
  service?: Partial<{
    serviceType: "marketplace_proxy" | "external_registry";
    settlementMode: "verified_escrow" | "community_direct";
    payoutWallet: string | null;
    websiteUrl: string | null;
  }>;
  endpoints?: Array<Record<string, unknown>>;
  verification?: {
    status: "verified" | "failed" | "pending";
    verifiedHost: string;
    failureReason: string | null;
  } | null;
}) {
  return {
    service: {
      id: "service_1",
      providerAccountId: "provider_1",
      serviceType: overrides?.service?.serviceType ?? "marketplace_proxy",
      settlementMode: overrides?.service?.settlementMode ?? "verified_escrow",
      slug: "signal-labs",
      apiNamespace: overrides?.service?.serviceType === "external_registry" ? null : "signals",
      name: "Signal Labs",
      tagline: "Short-form market signals",
      about: "Provider-authored signal endpoints.",
      categories: ["Research"],
      promptIntro: "Prompt intro",
      setupInstructions: ["Use a funded Fast wallet."],
      websiteUrl: overrides?.service?.websiteUrl ?? "https://provider.example.com",
      payoutWallet: overrides?.service?.payoutWallet ?? "fast1provider000000000000000000000000000000000000000000000000000000",
      featured: false,
      status: "draft" as const,
      createdAt: "2026-03-20T00:00:00.000Z",
      updatedAt: "2026-03-20T00:00:00.000Z"
    },
    account: {
      id: "provider_1",
      ownerWallet: "fast1provider000000000000000000000000000000000000000000000000000000",
      displayName: "Signal Labs",
      bio: null,
      websiteUrl: "https://provider.example.com",
      contactEmail: null,
      createdAt: "2026-03-20T00:00:00.000Z",
      updatedAt: "2026-03-20T00:00:00.000Z"
    },
    endpoints: overrides?.endpoints ?? [],
    verification: overrides?.verification ?? null,
    latestReview: null,
    latestPublishedVersionId: null
  };
}

describe("ProviderServiceReview", () => {
  beforeEach(() => {
    window.localStorage.clear();
    fetchProviderService.mockReset();
    fetchProviderRuntimeKey.mockReset();
    submitProviderService.mockReset();
    fetchProviderRuntimeKey.mockResolvedValue(null);

    window.localStorage.setItem(
      "fast-marketplace-wallet-session",
      JSON.stringify({
        accessToken: "provider_token",
        wallet: "fast1provider000000000000000000000000000000000000000000000000000000",
        deploymentNetwork: "mainnet",
        resourceId: window.location.origin
      })
    );
  });

  it("shows an unavailable state when the review draft no longer exists", async () => {
    fetchProviderService.mockResolvedValue(null);

    render(
      <ProviderServiceReview
        apiBaseUrl="https://api.marketplace.example.com"
        deploymentNetwork="mainnet"
        serviceId="missing_service"
      />
    );

    await waitFor(() => {
      expect(screen.getByText("Review draft unavailable")).toBeTruthy();
    });

    expect(screen.getByText(/no longer accessible from the connected wallet session/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /back to drafts/i })).toBeTruthy();
  });

  it("shows external registry host checks instead of blocking verification requirements", async () => {
    fetchProviderService.mockResolvedValue(
      buildServiceDetail({
        service: {
          serviceType: "external_registry",
          payoutWallet: null
        },
        endpoints: [
          {
            id: "endpoint_1",
            endpointType: "external_registry",
            title: "Status",
            description: "Returns service status directly from the provider.",
            method: "GET",
            publicUrl: "https://provider.example.com/api/status",
            docsUrl: "https://docs.provider.example.com/status",
            authNotes: "Bearer token required.",
            requestExample: {},
            responseExample: { status: "ok" }
          }
        ]
      })
    );

    render(
      <ProviderServiceReview
        apiBaseUrl="https://api.marketplace.example.com"
        deploymentNetwork="mainnet"
        serviceId="service_1"
      />
    );

    await waitFor(() => {
      expect(screen.getByText("Website URL and endpoint hosts are set consistently")).toBeTruthy();
    });

    expect(screen.queryByText("Website verification succeeded")).toBeNull();
    expect(screen.getByText("Marketplace runtime key is not required")).toBeTruthy();
    expect(screen.getByText("not required")).toBeTruthy();
  });

  it("still shows verification as required for marketplace proxy drafts", async () => {
    fetchProviderService.mockResolvedValue(
      buildServiceDetail({
        verification: null,
        endpoints: [
          {
            id: "endpoint_1",
            endpointType: "marketplace_proxy",
            operation: "quote",
            method: "POST",
            title: "Quote",
            description: "Return a single quote snapshot.",
            billing: {
              type: "fixed_x402",
              price: "$0.0001",
              tokenSymbol: "USDC",
              minAmount: null,
              maxAmount: null
            },
            mode: "sync",
            requestSchemaJson: { type: "object", additionalProperties: false },
            responseSchemaJson: { type: "object", additionalProperties: false },
            requestExample: {},
            responseExample: {},
            upstreamBaseUrl: "https://provider.example.com",
            upstreamPath: "/api/quote",
            upstreamAuthMode: "none"
          }
        ]
      })
    );

    render(
      <ProviderServiceReview
        apiBaseUrl="https://api.marketplace.example.com"
        deploymentNetwork="mainnet"
        serviceId="service_1"
      />
    );

    await waitFor(() => {
      expect(screen.getByText("Website verification succeeded")).toBeTruthy();
    });

    expect(screen.getAllByText("missing").length).toBeGreaterThan(0);
  });
});
