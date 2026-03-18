// @vitest-environment jsdom

import { describe, expect, it } from "vitest";

import {
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
      resourceId: "https://fast.8o.vc"
    });

    expect(readStoredWalletSession("testnet")?.accessToken).toBe("token-1");
    expect(readStoredWalletSession("mainnet")).toBeNull();
  });

  it("shortens long wallet addresses for header display", () => {
    expect(shortenWalletAddress("fast1abcdefghijklmnopqrstuvwxyz0123456789uvwxyz")).toMatch(/\.\.\./);
  });
});
