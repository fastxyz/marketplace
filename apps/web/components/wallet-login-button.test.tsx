// @vitest-environment jsdom

import React from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { WalletLoginButton } from "./wallet-login-button";
import { WALLET_SESSION_STORAGE_KEY } from "@/lib/wallet-session";

const connectMock = vi.fn();
const disconnectMock = vi.fn();
const exportKeysMock = vi.fn();
const getActiveNetworkMock = vi.fn();
const signMock = vi.fn();
const fromInjectedMock = vi.fn();
const getInjectedFastConnectorMock = vi.fn();
const waitForInjectedFastConnectorMock = vi.fn();

vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: { href: string; children: ReactNode }) => (
    <a href={href} {...props}>
      {children}
    </a>
  )
}));

vi.mock("@fastxyz/fast-connector", () => ({
  FastConnector: {
    fromInjected: fromInjectedMock
  },
  getInjectedFastConnector: getInjectedFastConnectorMock,
  waitForInjectedFastConnector: waitForInjectedFastConnectorMock
}));

describe("WalletLoginButton", () => {
  beforeEach(() => {
    connectMock.mockResolvedValue(true);
    disconnectMock.mockResolvedValue(undefined);
    exportKeysMock.mockResolvedValue({
      address: "fast1provider000000000000000000000000000000000000000000000000000000"
    });
    getActiveNetworkMock.mockResolvedValue("mainnet");
    signMock.mockResolvedValue({
      signature: "signed-wallet-challenge"
    });
    fromInjectedMock.mockReturnValue({
      connect: connectMock,
      disconnect: disconnectMock,
      exportKeys: exportKeysMock,
      getActiveNetwork: getActiveNetworkMock,
      sign: signMock
    });
    getInjectedFastConnectorMock.mockReturnValue({ provider: "injected" });
    waitForInjectedFastConnectorMock.mockResolvedValue({ provider: "injected" });
    window.localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("uses same-origin auth endpoints when no public API base URL is configured", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            wallet: "fast1provider000000000000000000000000000000000000000000000000000000",
            resourceType: "site",
            resourceId: window.location.origin,
            nonce: "nonce-1",
            expiresAt: "2026-03-25T00:00:00.000Z",
            message: "Sign in to Fast Marketplace"
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json"
            }
          }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            accessToken: "wallet-session-token",
            wallet: "fast1provider000000000000000000000000000000000000000000000000000000",
            resourceType: "site",
            resourceId: window.location.origin,
            tokenType: "Bearer"
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json"
            }
          }
        )
      );

    render(
      <WalletLoginButton
        apiBaseUrl=""
        deploymentNetwork="mainnet"
        networkLabel="Mainnet"
      />
    );

    await userEvent.click(screen.getByRole("button", { name: /connect to fast/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    expect(fetchMock.mock.calls[0]?.[0]).toBe("/auth/wallet/challenge");
    expect(fetchMock.mock.calls[1]?.[0]).toBe("/auth/wallet/session");
    expect(JSON.parse(window.localStorage.getItem("fast-marketplace-wallet-session") ?? "{}")).toMatchObject({
      accessToken: "wallet-session-token",
      wallet: "fast1provider000000000000000000000000000000000000000000000000000000",
      deploymentNetwork: "mainnet"
    });
  });

  it("shows the connected wallet dropdown with dashboard and disconnect actions", async () => {
    const user = userEvent.setup();

    window.localStorage.setItem(
      WALLET_SESSION_STORAGE_KEY,
      JSON.stringify({
        accessToken: "wallet-session-token",
        wallet: "fast1provider000000000000000000000000000000000000000000000000000000",
        deploymentNetwork: "mainnet",
        resourceId: window.location.origin
      })
    );

    render(
      <WalletLoginButton
        apiBaseUrl=""
        deploymentNetwork="mainnet"
        networkLabel="Mainnet"
      />
    );

    await user.hover(screen.getByRole("button", { name: /wallet menu for fast1pro\.\.\.000000/i }));

    const dashboardMenuItem = await screen.findByRole("menuitem", { name: "My Dashboard" });
    expect(dashboardMenuItem.getAttribute("href")).toBe("/me/spend");

    await user.click(screen.getByText("Disconnect Wallet"));

    await waitFor(() => {
      expect(disconnectMock).toHaveBeenCalledTimes(1);
    });

    expect(window.localStorage.getItem(WALLET_SESSION_STORAGE_KEY)).toBeNull();
    expect(screen.getByRole("button", { name: /connect to fast/i })).toBeTruthy();
  });

  it("shows an actionable error when wallet auth receives the Next app HTML instead of API JSON", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("<!DOCTYPE html><html><body>Not the API</body></html>", {
        status: 404,
        headers: {
          "content-type": "text/html"
        }
      })
    );

    render(
      <WalletLoginButton
        apiBaseUrl=""
        deploymentNetwork="mainnet"
        networkLabel="Mainnet"
      />
    );

    await userEvent.click(screen.getByRole("button", { name: /connect to fast/i }));

    await waitFor(() => {
      expect(
        screen.getByText(
          /wallet auth hit the web app instead of the api\. for localhost dev, run the api server and set marketplace_api_base_url=http:\/\/localhost:3000 before starting the web app\./i
        )
      ).toBeTruthy();
    });
  });
});
