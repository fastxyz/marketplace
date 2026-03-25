// @vitest-environment jsdom

import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EndpointBrowserRunner } from "./endpoint-browser-runner";

const mockConnector = {
  connect: vi.fn(async () => true),
  exportKeys: vi.fn(async () => ({
    address: "fast1buyer00000000000000000000000000000000000000000000000000000000",
    publicKey: "pubkey"
  })),
  getActiveNetwork: vi.fn(async () => "mainnet"),
  sign: vi.fn(async () => ({
    signature: "signed_challenge"
  })),
  transfer: vi.fn()
};

vi.mock("@fastxyz/fast-connector", () => ({
  FastConnector: {
    fromInjected: () => mockConnector
  },
  waitForInjectedFastConnector: async () => ({})
}));

function jsonResponse(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: new Headers(),
    json: async () => body,
    text: async () => JSON.stringify(body)
  } as Response;
}

describe("EndpointBrowserRunner", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    mockConnector.connect.mockClear();
    mockConnector.exportKeys.mockClear();
    mockConnector.getActiveNetwork.mockClear();
    mockConnector.sign.mockClear();
    mockConnector.transfer.mockClear();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("uses wallet-session auth for prepaid-credit GET routes", async () => {
    const user = userEvent.setup();
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();

      if (url.endsWith("/auth/challenge")) {
        return jsonResponse(200, {
          nonce: "nonce_123",
          expiresAt: "2026-03-21T00:05:00.000Z",
          message: "Sign this challenge"
        });
      }

      if (url.endsWith("/auth/session")) {
        return jsonResponse(200, {
          accessToken: "api_session_token"
        });
      }

      if (url === "https://api.marketplace.example.com/api/orders/lookup?id=order_123") {
        expect(init?.method).toBe("GET");
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer api_session_token");
        expect(new Headers(init?.headers).get("payment-identifier")).toBeNull();
        expect(init?.body).toBeUndefined();

        return jsonResponse(200, {
          orderId: "order_123",
          status: "ready"
        });
      }

      throw new Error(`Unexpected fetch: ${url}`);
    });
    globalThis.fetch = fetchImpl as unknown as typeof fetch;

    render(
      <EndpointBrowserRunner
        deploymentNetwork="mainnet"
        endpoint={{
          endpointType: "marketplace_proxy",
          routeId: "orders.lookup.v1",
          title: "Lookup order",
          description: "Read one prepaid order.",
          price: "Prepaid credit",
          billingType: "prepaid_credit",
          tokenSymbol: "USDC",
          mode: "sync",
          method: "GET",
          path: "/api/orders/lookup",
          proxyUrl: "https://api.marketplace.example.com/api/orders/lookup",
          requestSchemaJson: {
            type: "object",
            properties: {
              id: { type: "string" }
            },
            required: ["id"],
            additionalProperties: false
          },
          responseSchemaJson: {
            type: "object",
            properties: {
              orderId: { type: "string" },
              status: { type: "string" }
            },
            required: ["orderId", "status"],
            additionalProperties: false
          },
          requestExample: {
            id: "order_123"
          },
          responseExample: {
            orderId: "order_123",
            status: "ready"
          },
          usageNotes: undefined
        }}
      />
    );

    expect(screen.getByText(/authorize and run this endpoint with your fast wallet/i)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /authorize and run in browser/i }));

    await waitFor(() => {
      expect(screen.getByText("HTTP 200")).toBeTruthy();
    });

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(mockConnector.transfer).not.toHaveBeenCalled();
  });
});
