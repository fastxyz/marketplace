// @vitest-environment jsdom

import React from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
const fetchProviderRuntimeKey = vi.fn();
const importProviderOpenApi = vi.fn();
const rotateProviderRuntimeKey = vi.fn();

vi.mock("@/lib/api", () => ({
  fetchProviderService: (...args: unknown[]) => fetchProviderService(...args),
  fetchProviderRuntimeKey: (...args: unknown[]) => fetchProviderRuntimeKey(...args),
  updateProviderService: (...args: unknown[]) => updateProviderService(...args),
  createProviderEndpoint: (...args: unknown[]) => createProviderEndpoint(...args),
  createProviderVerificationChallenge: (...args: unknown[]) => createProviderVerificationChallenge(...args),
  verifyProviderService: (...args: unknown[]) => verifyProviderService(...args),
  submitProviderService: (...args: unknown[]) => submitProviderService(...args),
  deleteProviderEndpoint: (...args: unknown[]) => deleteProviderEndpoint(...args),
  updateProviderEndpoint: (...args: unknown[]) => updateProviderEndpoint(...args),
  importProviderOpenApi: (...args: unknown[]) => importProviderOpenApi(...args),
  rotateProviderRuntimeKey: (...args: unknown[]) => rotateProviderRuntimeKey(...args)
}));

function buildServiceDetail(overrides?: {
  endpoints?: Array<Record<string, unknown>>;
}) {
  return {
    service: {
      id: "service_1",
      providerAccountId: "provider_1",
      serviceType: "marketplace_proxy" as const,
      settlementMode: "community_direct" as const,
      slug: "signal-labs",
      apiNamespace: "signals",
      name: "Signal Labs",
      tagline: "Short-form market signals",
      about: "Provider-authored signal endpoints.",
      categories: ["Research"],
      promptIntro: "Prompt intro",
      setupInstructions: ["Use a funded Fast wallet."],
      websiteUrl: "https://provider.example.com",
      payoutWallet: "fast1provider000000000000000000000000000000000000000000000000000000",
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
    verification: null,
    latestReview: null,
    latestPublishedVersionId: null
  };
}

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
    fetchProviderRuntimeKey.mockReset();
    importProviderOpenApi.mockReset();
    rotateProviderRuntimeKey.mockReset();
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

  it("loads an imported OpenAPI candidate into the new endpoint form", async () => {
    const user = userEvent.setup();
    fetchProviderService.mockResolvedValue(buildServiceDetail());
    importProviderOpenApi.mockResolvedValue({
      documentUrl: "https://docs.provider.example.com/openapi.json",
      title: "Provider API",
      version: "1.0.0",
      warnings: [],
      endpoints: [
        {
          operation: "search",
          title: "Search",
          description: "Search provider data.",
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
              items: {
                type: "array",
                items: { type: "string" }
              }
            },
            required: ["items"],
            additionalProperties: false
          },
          requestExample: {
            query: "fast"
          },
          responseExample: {
            items: ["alpha"]
          },
          usageNotes: null,
          upstreamBaseUrl: "https://api.provider.example.com",
          upstreamPath: "/search",
          upstreamAuthMode: "none",
          upstreamAuthHeaderName: null,
          warnings: []
        }
      ]
    });

    render(
      <ProviderServiceEditor
        apiBaseUrl="https://api.marketplace.example.com"
        deploymentNetwork="mainnet"
        serviceId="service_1"
      />
    );

    await waitFor(() => {
      expect(screen.getByText("Endpoint drafts")).toBeTruthy();
    });

    await user.type(screen.getByLabelText(/openapi json url/i), "https://docs.provider.example.com/openapi.json");
    await user.click(screen.getByRole("button", { name: /load openapi/i }));

    await waitFor(() => {
      expect(importProviderOpenApi).toHaveBeenCalledWith(
        "https://api.marketplace.example.com",
        "provider_token",
        "service_1",
        "https://docs.provider.example.com/openapi.json"
      );
    });

    await user.click(screen.getByRole("button", { name: /load into new draft/i }));

    expect(screen.getByDisplayValue("search")).toBeTruthy();
    expect(screen.getByDisplayValue("Search")).toBeTruthy();
    expect(screen.getByDisplayValue("https://api.provider.example.com")).toBeTruthy();
    expect(screen.getByDisplayValue("/search")).toBeTruthy();
  });

  it("creates a free endpoint draft through the editor", async () => {
    const user = userEvent.setup();
    fetchProviderService.mockResolvedValue(buildServiceDetail());
    createProviderEndpoint.mockResolvedValue({});

    render(
      <ProviderServiceEditor
        apiBaseUrl="https://api.marketplace.example.com"
        deploymentNetwork="mainnet"
        serviceId="service_1"
      />
    );

    await waitFor(() => {
      expect(screen.getByText("Endpoint drafts")).toBeTruthy();
    });

    const newEndpointHeading = screen.getAllByText("New endpoint").at(-1);
    const newEndpointFormElement = newEndpointHeading?.closest("form") ?? null;
    if (!newEndpointFormElement) {
      throw new Error("New endpoint form not found.");
    }
    const newEndpointForm = within(newEndpointFormElement);

    await user.type(newEndpointForm.getByLabelText(/operation slug/i), "search");
    await user.selectOptions(newEndpointForm.getByLabelText(/billing/i), "free");
    await user.type(newEndpointForm.getByLabelText(/^title$/i), "Search");
    await user.type(newEndpointForm.getByLabelText(/^description$/i), "Search provider data.");
    await user.type(newEndpointForm.getByLabelText(/upstream base url/i), "https://api.provider.example.com");
    await user.type(newEndpointForm.getByLabelText(/upstream path/i), "/search");
    fireEvent.change(newEndpointForm.getByLabelText(/request schema json/i), { target: { value: "{\"type\":\"object\"}" } });
    fireEvent.change(newEndpointForm.getByLabelText(/response schema json/i), { target: { value: "{\"type\":\"object\"}" } });
    fireEvent.change(newEndpointForm.getByLabelText(/request example json/i), { target: { value: "{}" } });
    fireEvent.change(newEndpointForm.getByLabelText(/response example json/i), { target: { value: "{\"ok\":true}" } });
    await user.click(newEndpointForm.getByRole("button", { name: /create endpoint/i }));

    await waitFor(() => {
      expect(createProviderEndpoint).toHaveBeenCalled();
    });

    const input = createProviderEndpoint.mock.calls[0]?.[3];
    expect(input).toMatchObject({
      operation: "search",
      title: "Search",
      description: "Search provider data.",
      billingType: "free",
      mode: "sync",
      upstreamBaseUrl: "https://api.provider.example.com",
      upstreamPath: "/search",
      upstreamAuthMode: "none"
    });
    expect(input).not.toHaveProperty("price");
  });

  it("preserves free billing when saving an existing endpoint draft", async () => {
    const user = userEvent.setup();
    fetchProviderService.mockResolvedValue(buildServiceDetail({
      endpoints: [
        {
          endpointType: "marketplace_proxy" as const,
          id: "endpoint_1",
          serviceId: "service_1",
          routeId: "signal-labs.search.v1",
          operation: "search",
          title: "Search",
          description: "Search provider data.",
          price: "Free",
          billing: {
            type: "free"
          },
          mode: "sync",
          executorKind: "http",
          requestSchemaJson: { type: "object" },
          responseSchemaJson: { type: "object" },
          requestExample: {},
          responseExample: { ok: true },
          usageNotes: null,
          upstreamBaseUrl: "https://api.provider.example.com",
          upstreamPath: "/search",
          upstreamAuthMode: "none",
          upstreamAuthHeaderName: null,
          upstreamSecretRef: null,
          hasUpstreamSecret: false,
          payout: {
            providerAccountId: "provider_1",
            providerWallet: "fast1provider000000000000000000000000000000000000000000000000000000",
            providerBps: 10_000
          },
          createdAt: "2026-03-20T00:00:00.000Z",
          updatedAt: "2026-03-20T00:00:00.000Z"
        }
      ]
    }));
    updateProviderEndpoint.mockResolvedValue({});

    render(
      <ProviderServiceEditor
        apiBaseUrl="https://api.marketplace.example.com"
        deploymentNetwork="mainnet"
        serviceId="service_1"
      />
    );

    await waitFor(() => {
      expect(screen.getAllByRole("button", { name: /^save$/i }).length).toBeGreaterThan(0);
    });

    const saveButton = screen.getAllByRole("button", { name: /^save$/i }).at(-1);
    if (!saveButton) {
      throw new Error("Save button not found.");
    }
    await user.click(saveButton);

    await waitFor(() => {
      expect(updateProviderEndpoint).toHaveBeenCalled();
    });

    const input = updateProviderEndpoint.mock.calls[0]?.[4];
    expect(input).toMatchObject({
      operation: "search",
      title: "Search",
      description: "Search provider data.",
      billingType: "free",
      upstreamBaseUrl: "https://api.provider.example.com",
      upstreamPath: "/search",
      upstreamAuthMode: "none"
    });
    expect(input).not.toHaveProperty("price");
  });
});
