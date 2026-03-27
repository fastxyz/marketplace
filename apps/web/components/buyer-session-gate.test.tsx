// @vitest-environment jsdom

import React from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BuyerSessionGate } from "./buyer-session-gate";
import { clearStoredWalletSession } from "@/lib/wallet-session";

vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: { href: string; children: ReactNode }) => (
    <a href={href} {...props}>
      {children}
    </a>
  )
}));

describe("BuyerSessionGate", () => {
  afterEach(() => {
    cleanup();
    window.localStorage.clear();
  });

  it("shows the wallet-required state when there is no session", async () => {
    render(
      <BuyerSessionGate deploymentNetwork="mainnet">
        {() => <div>secret spend</div>}
      </BuyerSessionGate>
    );

    await waitFor(() => {
      expect(screen.getByText("Spend dashboard")).toBeTruthy();
    });

    expect(screen.getByText(/connect the extension wallet first/i)).toBeTruthy();
    expect(screen.getByRole("link", { name: /back to marketplace/i }).getAttribute("href")).toBe("/");
  });

  it("renders children when a matching wallet session exists", async () => {
    window.localStorage.setItem(
      "fast-marketplace-wallet-session",
      JSON.stringify({
        accessToken: "token_123",
        wallet: "fast1buyer0000000000000000000000000000000000000000000000000000000",
        deploymentNetwork: "testnet",
        resourceId: window.location.origin
      })
    );

    render(
      <BuyerSessionGate deploymentNetwork="testnet">
        {(session) => <div>{session.wallet}</div>}
      </BuyerSessionGate>
    );

    await waitFor(() => {
      expect(screen.getByText(/fast1buyer/i)).toBeTruthy();
    });
  });

  it("reacts to same-tab session clears and falls back to the wallet-required state", async () => {
    window.localStorage.setItem(
      "fast-marketplace-wallet-session",
      JSON.stringify({
        accessToken: "token_123",
        wallet: "fast1buyer0000000000000000000000000000000000000000000000000000000",
        deploymentNetwork: "testnet",
        resourceId: window.location.origin
      })
    );

    render(
      <BuyerSessionGate deploymentNetwork="testnet">
        {(session) => <div>{session.wallet}</div>}
      </BuyerSessionGate>
    );

    await waitFor(() => {
      expect(screen.getAllByText(/fast1buyer/i).length).toBeGreaterThan(0);
    });

    clearStoredWalletSession();

    await waitFor(() => {
      expect(screen.getByText(/connect the extension wallet first/i)).toBeTruthy();
    });
  });
});
