// @vitest-environment jsdom

import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ProviderServiceReview } from "./provider-service-review";

const fetchProviderService = vi.fn();
const submitProviderService = vi.fn();

vi.mock("@/lib/api", () => ({
  fetchProviderService: (...args: unknown[]) => fetchProviderService(...args),
  submitProviderService: (...args: unknown[]) => submitProviderService(...args)
}));

describe("ProviderServiceReview", () => {
  beforeEach(() => {
    window.localStorage.clear();
    fetchProviderService.mockReset();
    submitProviderService.mockReset();

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
});
