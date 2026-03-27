// @vitest-environment jsdom

import React from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SpendDashboard } from "./spend-dashboard";

const { fetchBuyerActivityMock } = vi.hoisted(() => ({
  fetchBuyerActivityMock: vi.fn()
}));

vi.mock("@/lib/api", () => ({
  fetchBuyerActivity: fetchBuyerActivityMock
}));

describe("SpendDashboard", () => {
  beforeEach(() => {
    window.localStorage.clear();
    fetchBuyerActivityMock.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it("shows the wallet gate without a session", async () => {
    render(
      <SpendDashboard
        apiBaseUrl="https://api.marketplace.example.com"
        deploymentNetwork="mainnet"
      />
    );

    await waitFor(() => {
      expect(screen.getByText("Spend dashboard")).toBeTruthy();
    });

    expect(screen.getByText(/connect a fast wallet in the header/i)).toBeTruthy();
  });

  it("renders summary cards and grouped activity when a wallet session exists", async () => {
    window.localStorage.setItem(
      "fast-marketplace-wallet-session",
      JSON.stringify({
        accessToken: "wallet-session-token",
        wallet: "fast1buyer0000000000000000000000000000000000000000000000000000000",
        deploymentNetwork: "testnet",
        resourceId: window.location.origin
      })
    );
    fetchBuyerActivityMock.mockResolvedValue({
      wallet: "fast1buyer0000000000000000000000000000000000000000000000000000000",
      summary: {
        totalSpend: "12.50",
        totalRefunded: "2.50",
        netSpend: "10.00",
        paidCallCount: 2,
        serviceCount: 1
      },
      items: [
        {
          paymentId: "payment_2",
          kind: "route_charge",
          status: "failed",
          amount: "7.50",
          tokenSymbol: "testUSDC",
          createdAt: "2026-03-27T10:00:00.000Z",
          service: {
            slug: "signal-labs",
            name: "Signal Labs"
          },
          route: {
            ref: "signals.async-report",
            title: "Async Report",
            mode: "async",
            billingType: "fixed_x402"
          },
          job: {
            jobToken: "job_123",
            status: "failed"
          },
          refund: null
        },
        {
          paymentId: "payment_1",
          kind: "credit_topup",
          status: "refunded",
          amount: "5.00",
          tokenSymbol: "testUSDC",
          createdAt: "2026-03-26T10:00:00.000Z",
          service: {
            slug: "signal-labs",
            name: "Signal Labs"
          },
          route: {
            ref: "signals.topup",
            title: "Top Up",
            mode: "sync",
            billingType: "topup_x402_variable"
          },
          job: null,
          refund: {
            status: "sent",
            amount: "2.50",
            txHash: "0xrefund"
          }
        }
      ]
    });

    render(
      <SpendDashboard
        apiBaseUrl="https://api.marketplace.example.com"
        deploymentNetwork="testnet"
      />
    );

    await waitFor(() => {
      expect(screen.getByText("Marketplace spend")).toBeTruthy();
    });

    expect(fetchBuyerActivityMock).toHaveBeenCalledWith({
      apiBaseUrl: "https://api.marketplace.example.com",
      accessToken: "wallet-session-token",
      range: "30d"
    });
    expect(screen.getByText("$12.50")).toBeTruthy();
    expect(screen.getByText("$2.50")).toBeTruthy();
    expect(screen.getByText("$10.00")).toBeTruthy();
    expect(screen.getByText("Signal Labs")).toBeTruthy();
    expect(screen.getByText(/signals\.async-report/i)).toBeTruthy();
    expect(screen.getByText(/refund: sent/i)).toBeTruthy();
  });
});
