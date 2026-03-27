import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  loadWalletMock,
  searchMarketplaceMock,
  showMarketplaceItemMock,
  useMarketplaceRouteMock,
  fetchJobResultMock
} = vi.hoisted(() => ({
  loadWalletMock: vi.fn(),
  searchMarketplaceMock: vi.fn(),
  showMarketplaceItemMock: vi.fn(),
  useMarketplaceRouteMock: vi.fn(),
  fetchJobResultMock: vi.fn()
}));

vi.mock("../../cli/src/lib.js", () => ({
  loadWallet: loadWalletMock,
  searchMarketplace: searchMarketplaceMock,
  showMarketplaceItem: showMarketplaceItemMock,
  useMarketplaceRoute: useMarketplaceRouteMock,
  fetchJobResult: fetchJobResultMock
}));

import {
  createFastPayMcpHandlers,
  parseFastPayMcpConfig,
  validateFastPayMcpConfig
} from "./index.js";

describe("fast-pay-mcp", () => {
  beforeEach(() => {
    loadWalletMock.mockReset();
    searchMarketplaceMock.mockReset();
    showMarketplaceItemMock.mockReset();
    useMarketplaceRouteMock.mockReset();
    fetchJobResultMock.mockReset();
  });

  it("fails config parsing when no wallet source is provided", () => {
    expect(() => parseFastPayMcpConfig({
      MARKETPLACE_API_BASE_URL: "https://api.marketplace.example.com",
      MARKETPLACE_FAST_NETWORK: "mainnet"
    })).toThrow(/FAST_PRIVATE_KEY or FAST_KEYFILE_PATH/i);
  });

  it("validates startup config through the existing wallet loader", async () => {
    loadWalletMock.mockResolvedValue({ paymentWallet: { address: "fast1buyer" } });

    await validateFastPayMcpConfig({
      apiUrl: "https://api.marketplace.example.com",
      network: "testnet",
      privateKey: "11".repeat(32)
    });

    expect(loadWalletMock).toHaveBeenCalledWith({
      privateKey: "11".repeat(32),
      keyfilePath: undefined,
      configPath: undefined,
      network: "testnet"
    });
  });

  it("wraps marketplace search, show, call, topup, and job retrieval through CLI logic", async () => {
    searchMarketplaceMock.mockResolvedValue({ results: [{ kind: "route" }] });
    showMarketplaceItemMock
      .mockResolvedValueOnce({ kind: "route", billingType: "topup_x402_variable" })
      .mockResolvedValueOnce({ kind: "route", ref: "mock.quick-insight" });
    useMarketplaceRouteMock
      .mockResolvedValueOnce({ ref: "orders.topup", statusCode: 200, body: { ok: true }, authFlow: "x402", jobToken: null })
      .mockResolvedValueOnce({ ref: "mock.quick-insight", statusCode: 200, body: { ok: true }, authFlow: "x402", jobToken: null });
    fetchJobResultMock.mockResolvedValue({ statusCode: 200, body: { status: "completed" } });

    const handlers = createFastPayMcpHandlers({
      apiUrl: "https://api.marketplace.example.com",
      network: "mainnet",
      privateKey: "22".repeat(32),
      configPath: "/tmp/fast-marketplace-config.json"
    });

    await expect(handlers.marketplaceSearch({ q: "weather" })).resolves.toEqual({
      results: [{ kind: "route" }]
    });
    await expect(handlers.marketplaceTopup({ ref: "orders.topup", amount: "25" })).resolves.toMatchObject({
      statusCode: 200
    });
    await expect(handlers.marketplaceShow({ ref: "mock.quick-insight" })).resolves.toMatchObject({
      kind: "route"
    });
    await expect(handlers.marketplaceCall({ ref: "mock.quick-insight", input: { query: "alpha" } })).resolves.toMatchObject({
      statusCode: 200
    });
    await expect(handlers.marketplaceGetJob({ jobToken: "job_123" })).resolves.toEqual({
      statusCode: 200,
      body: { status: "completed" }
    });

    expect(searchMarketplaceMock).toHaveBeenCalledWith({
      apiUrl: "https://api.marketplace.example.com",
      q: "weather"
    }, expect.any(Object));
    expect(useMarketplaceRouteMock).toHaveBeenNthCalledWith(1, {
      apiUrl: "https://api.marketplace.example.com",
      ref: "orders.topup",
      body: {
        amount: "25"
      },
      privateKey: "22".repeat(32),
      keyfilePath: undefined,
      configPath: "/tmp/fast-marketplace-config.json",
      network: "mainnet",
      autoApproveExpensive: false
    }, expect.any(Object));
    expect(fetchJobResultMock).toHaveBeenCalledWith({
      apiUrl: "https://api.marketplace.example.com",
      jobToken: "job_123",
      privateKey: "22".repeat(32),
      keyfilePath: undefined,
      configPath: "/tmp/fast-marketplace-config.json",
      network: "mainnet"
    }, expect.any(Object));
  });

  it("rejects topup calls for non-topup route refs", async () => {
    showMarketplaceItemMock.mockResolvedValue({
      kind: "route",
      billingType: "fixed_x402"
    });
    const handlers = createFastPayMcpHandlers({
      apiUrl: "https://api.marketplace.example.com",
      network: "mainnet",
      privateKey: "33".repeat(32)
    });

    await expect(handlers.marketplaceTopup({ ref: "mock.quick-insight", amount: "25" })).rejects.toThrow(
      /billingType=topup_x402_variable/i
    );
  });
});
