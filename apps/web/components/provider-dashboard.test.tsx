// @vitest-environment jsdom

import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ProviderDashboard } from "./provider-dashboard";

const fetchProviderAccount = vi.fn();
const fetchProviderServices = vi.fn();
const fetchProviderRequests = vi.fn();
const claimProviderRequest = vi.fn();

vi.mock("@/lib/api", () => ({
  fetchProviderAccount: (...args: unknown[]) => fetchProviderAccount(...args),
  fetchProviderServices: (...args: unknown[]) => fetchProviderServices(...args),
  fetchProviderRequests: (...args: unknown[]) => fetchProviderRequests(...args),
  claimProviderRequest: (...args: unknown[]) => claimProviderRequest(...args)
}));

describe("ProviderDashboard", () => {
  beforeEach(() => {
    window.localStorage.clear();
    fetchProviderAccount.mockReset();
    fetchProviderServices.mockReset();
    fetchProviderRequests.mockReset();
    claimProviderRequest.mockReset();

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

  it("loads provider requests and lets the connected provider claim one", async () => {
    fetchProviderAccount.mockResolvedValue({
      id: "account_1",
      ownerWallet: "fast1provider000000000000000000000000000000000000000000000000000000",
      displayName: "Signal Labs",
      bio: null,
      websiteUrl: "https://provider.example.com",
      contactEmail: null,
      createdAt: "2026-03-19T00:00:00.000Z",
      updatedAt: "2026-03-19T00:00:00.000Z"
    });
    fetchProviderServices.mockResolvedValue([
      {
        service: {
          id: "service_1",
          providerAccountId: "account_1",
          slug: "signal-labs",
          apiNamespace: "signals",
          name: "Signal Labs",
          tagline: "Short-form market signals",
          about: "Provider-authored signal endpoints.",
          categories: ["Research"],
          promptIntro: "Prompt intro",
          setupInstructions: ["Step 1"],
          websiteUrl: "https://provider.example.com",
          payoutWallet: "fast1provider000000000000000000000000000000000000000000000000000000",
          featured: false,
          status: "draft",
          createdAt: "2026-03-19T00:00:00.000Z",
          updatedAt: "2026-03-19T00:00:00.000Z"
        },
        account: {
          id: "account_1",
          ownerWallet: "fast1provider000000000000000000000000000000000000000000000000000000",
          displayName: "Signal Labs",
          bio: null,
          websiteUrl: "https://provider.example.com",
          contactEmail: null,
          createdAt: "2026-03-19T00:00:00.000Z",
          updatedAt: "2026-03-19T00:00:00.000Z"
        },
        endpoints: [],
        verification: null,
        latestReview: null,
        latestPublishedVersionId: null
      }
    ]);
    fetchProviderRequests.mockResolvedValue([
      {
        id: "request_1",
        type: "endpoint",
        serviceSlug: "mock-research-signals",
        title: "Add a structured watchlist endpoint",
        description: "Expose a watchlist-friendly endpoint that returns a ranked signal feed.",
        sourceUrl: null,
        status: "submitted",
        claimedByProviderName: null,
        claimedAt: null,
        claimedByCurrentProvider: false,
        claimable: true,
        createdAt: "2026-03-19T00:00:00.000Z",
        updatedAt: "2026-03-19T00:00:00.000Z"
      }
    ]);
    claimProviderRequest.mockResolvedValue({
      id: "request_1",
      type: "endpoint",
      serviceSlug: "mock-research-signals",
      title: "Add a structured watchlist endpoint",
      description: "Expose a watchlist-friendly endpoint that returns a ranked signal feed.",
      sourceUrl: null,
      status: "reviewing",
      claimedByProviderName: "Signal Labs",
      claimedAt: "2026-03-19T00:05:00.000Z",
      claimedByCurrentProvider: true,
      claimable: false,
      createdAt: "2026-03-19T00:00:00.000Z",
      updatedAt: "2026-03-19T00:05:00.000Z"
    });

    render(
      <ProviderDashboard
        apiBaseUrl="https://api.marketplace.example.com"
        deploymentNetwork="mainnet"
      />
    );

    await waitFor(() => {
      expect(screen.getByText("Request intake")).toBeTruthy();
    });

    expect(screen.getByText("Open requests")).toBeTruthy();
    expect(screen.getByText("Add a structured watchlist endpoint")).toBeTruthy();
    expect(screen.queryByText("builder@example.com")).toBeNull();

    fireEvent.click(await screen.findByRole("button", { name: "Claim request" }));

    await waitFor(() => {
      expect(screen.getByText("Claimed by you")).toBeTruthy();
    });

    expect(claimProviderRequest).toHaveBeenCalledWith("https://api.marketplace.example.com", "provider_token", "request_1");
  });

  it("shows onboarding when the wallet has no provider profile yet", async () => {
    fetchProviderAccount.mockResolvedValue(null);

    render(
      <ProviderDashboard
        apiBaseUrl="https://api.marketplace.example.com"
        deploymentNetwork="mainnet"
      />
    );

    await waitFor(() => {
      expect(screen.getByText("Create your provider profile")).toBeTruthy();
    });

    expect(screen.getByRole("button", { name: "Open onboarding" })).toBeTruthy();
  });
});
