// @vitest-environment jsdom

import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ProviderServiceEditor } from "./provider-service-editor";

const fetchProviderService = vi.fn();
const updateProviderService = vi.fn();
const createProviderEndpoint = vi.fn();
const createProviderVerificationChallenge = vi.fn();
const verifyProviderService = vi.fn();
const submitProviderService = vi.fn();
const deleteProviderEndpoint = vi.fn();
const updateProviderEndpoint = vi.fn();

vi.mock("@/lib/api", () => ({
  fetchProviderService: (...args: unknown[]) => fetchProviderService(...args),
  updateProviderService: (...args: unknown[]) => updateProviderService(...args),
  createProviderEndpoint: (...args: unknown[]) => createProviderEndpoint(...args),
  createProviderVerificationChallenge: (...args: unknown[]) => createProviderVerificationChallenge(...args),
  verifyProviderService: (...args: unknown[]) => verifyProviderService(...args),
  submitProviderService: (...args: unknown[]) => submitProviderService(...args),
  deleteProviderEndpoint: (...args: unknown[]) => deleteProviderEndpoint(...args),
  updateProviderEndpoint: (...args: unknown[]) => updateProviderEndpoint(...args)
}));

describe("ProviderServiceEditor", () => {
  beforeEach(() => {
    window.localStorage.clear();
    fetchProviderService.mockReset();
    updateProviderService.mockReset();
    createProviderEndpoint.mockReset();
    createProviderVerificationChallenge.mockReset();
    verifyProviderService.mockReset();
    submitProviderService.mockReset();
    deleteProviderEndpoint.mockReset();
    updateProviderEndpoint.mockReset();

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

  it("shows an unavailable state when the service draft no longer exists", async () => {
    fetchProviderService.mockResolvedValue(null);

    render(
      <ProviderServiceEditor
        apiBaseUrl="https://api.marketplace.example.com"
        deploymentNetwork="mainnet"
        serviceId="missing_service"
      />
    );

    await waitFor(() => {
      expect(screen.getByText("Service draft unavailable")).toBeTruthy();
    });

    expect(screen.getByText(/no longer accessible from the connected wallet session/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /back to drafts/i })).toBeTruthy();
  });
});
