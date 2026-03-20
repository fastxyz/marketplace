// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";

import {
  WALLET_SESSION_CHANGE_EVENT,
  clearStoredWalletSession,
  normalizeWalletConnectorNetwork,
  readStoredWalletSession,
  shortenWalletAddress,
  writeStoredWalletSession
} from "./wallet-session";

describe("wallet session helpers", () => {
  it("normalizes connector network names", () => {
    expect(normalizeWalletConnectorNetwork("mainnet")).toBe("mainnet");
    expect(normalizeWalletConnectorNetwork("fast-testnet")).toBe("testnet");
    expect(normalizeWalletConnectorNetwork("unknown")).toBeNull();
  });

  it("stores and reloads a wallet session for the active deployment network", () => {
    clearStoredWalletSession();
    writeStoredWalletSession({
      accessToken: "token-1",
      wallet: "fast1abcdefghijklmnopqrstuvwxyz0123456789uvwxyz",
      deploymentNetwork: "testnet",
      resourceId: window.location.origin
    });

    expect(readStoredWalletSession("testnet")?.accessToken).toBe("token-1");
    expect(readStoredWalletSession("mainnet")).toBeNull();
  });

  it("clears a stored session when it was minted for a different site origin", () => {
    clearStoredWalletSession();
    writeStoredWalletSession({
      accessToken: "token-1",
      wallet: "fast1abcdefghijklmnopqrstuvwxyz0123456789uvwxyz",
      deploymentNetwork: "testnet",
      resourceId: "https://wrong.marketplace.example.com"
    });

    expect(readStoredWalletSession("testnet")).toBeNull();
    expect(window.localStorage.getItem("fast-marketplace-wallet-session")).toBeNull();
  });

  it("emits a same-tab session change event when the session is cleared", () => {
    const listener = vi.fn();
    window.addEventListener(WALLET_SESSION_CHANGE_EVENT, listener);

    clearStoredWalletSession();

    expect(listener).toHaveBeenCalledTimes(1);

    window.removeEventListener(WALLET_SESSION_CHANGE_EVENT, listener);
  });

  it("shortens long wallet addresses for header display", () => {
    expect(shortenWalletAddress("fast1abcdefghijklmnopqrstuvwxyz0123456789uvwxyz")).toMatch(/\.\.\./);
  });
});
