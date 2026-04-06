import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

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

  it("starts over stdio in a CI-style env and serves marketplace tools", async () => {
    const requests: Array<{ method: string; url: string; body: unknown }> = [];
    const server = createServer(async (req, res) => {
      await handleRequest(req, res, requests);
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });

    const address = server.address();
    expect(address).toBeTruthy();
    expect(typeof address).toBe("object");

    const stderrChunks: string[] = [];
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", "packages/mcp/src/index.ts"],
      cwd: process.cwd(),
      env: {
        ...process.env,
        MARKETPLACE_API_BASE_URL: `http://127.0.0.1:${(address as { port: number }).port}`,
        MARKETPLACE_FAST_NETWORK: "testnet",
        FAST_PRIVATE_KEY: "44".repeat(32)
      },
      stderr: "pipe"
    });
    transport.stderr?.on("data", (chunk) => {
      stderrChunks.push(String(chunk));
    });

    const client = new Client({
      name: "fast-pay-mcp-ci-test",
      version: "0.0.0"
    });

    try {
      await client.connect(transport);

      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toContain("marketplace_call");

      const result = await client.callTool({
        name: "marketplace_call",
        arguments: {
          ref: "research.search",
          input: {
            query: "alpha"
          }
        }
      });

      expect(result.structuredContent).toEqual({
        ref: "research.search",
        statusCode: 200,
        body: {
          ok: true,
          received: {
            query: "alpha"
          }
        },
        authFlow: "none",
        jobToken: null
      });
      expect(requests).toEqual(expect.arrayContaining([
        expect.objectContaining({
          method: "GET",
          url: "/catalog/routes/research/search"
        }),
        expect.objectContaining({
          method: "POST",
          url: "/api/research/search"
        })
      ]));
    } catch (error) {
      const stderr = stderrChunks.join("");
      if (stderr) {
        throw new Error(`${error instanceof Error ? error.message : String(error)}\n\nfast-pay-mcp stderr:\n${stderr}`);
      }
      throw error;
    } finally {
      await transport.close().catch(() => undefined);
      server.close();
    }
  });
});

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  requests: Array<{ method: string; url: string; body: unknown }>
) {
  const body = await readJsonBody(req);
  requests.push({
    method: req.method ?? "GET",
    url: req.url ?? "/",
    body
  });

  if (req.method === "GET" && req.url === "/catalog/routes/research/search") {
    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      routeId: "route_research_search",
      ref: "research.search",
      provider: "research",
      operation: "search",
      method: "POST",
      requestSchemaJson: {
        type: "object",
        properties: {
          query: { type: "string" }
        },
        required: ["query"],
        additionalProperties: false
      },
      authRequirement: {
        type: "none"
      }
    }));
    return;
  }

  if (req.method === "POST" && req.url === "/api/research/search") {
    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      ok: true,
      received: body
    }));
    return;
  }

  res.statusCode = 404;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({
    error: `Unhandled mock request: ${req.method ?? "GET"} ${req.url ?? "/"}`
  }));
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  if (chunks.length === 0) {
    return null;
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}
