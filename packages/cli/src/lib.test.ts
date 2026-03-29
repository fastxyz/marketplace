import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  fetchJobResult,
  initializeWallet,
  readCliConfig,
  searchMarketplace,
  setSpendControls,
  showMarketplaceItem,
  useMarketplaceRoute,
  walletAddress
} from "./lib.js";

function jsonResponse(status: number, body: unknown, headers?: Record<string, string>): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: new Headers(headers),
    json: async () => body,
    text: async () => JSON.stringify(body)
  } as Response;
}

const FAST_MAINNET_USDC_ASSET_ID = "0xc655a12330da6af361d281b197996d2bc135aaed3b66278e729c2222291e9130";
const API_URL = "http://localhost:3000";

function buildServiceSummary(overrides: Record<string, unknown> = {}) {
  return {
    serviceType: "marketplace_proxy",
    slug: "mock-research-signals",
    name: "Mock Research Signals",
    ownerName: "Marketplace",
    tagline: "Mock route set for signal lookups.",
    categories: ["Research"],
    settlementMode: "verified_escrow",
    settlementLabel: "Verified escrow",
    settlementDescription: "Marketplace holds funds and handles refunds.",
    priceRange: "$0.0001 USDC",
    settlementToken: "USDC",
    endpointCount: 1,
    totalCalls: 0,
    revenue: "0",
    successRate30d: 0,
    volume30d: [],
    ...overrides
  };
}

function buildRouteDetail(overrides: Record<string, unknown> = {}) {
  return {
    kind: "route",
    ref: "mock.quick-insight",
    routeId: "mock.quick-insight.v1",
    provider: "mock",
    operation: "quick-insight",
    serviceSlug: "mock-research-signals",
    serviceName: "Mock Research Signals",
    ownerName: "Marketplace",
    categories: ["Research"],
    title: "Quick Insight",
    description: "Run a quick signal lookup.",
    price: "$0.0001",
    billingType: "fixed_x402",
    tokenSymbol: "USDC",
    mode: "sync",
    method: "POST",
    path: "/api/mock/quick-insight",
    proxyUrl: `${API_URL}/api/mock/quick-insight`,
    settlementMode: "verified_escrow",
    settlementLabel: "Verified escrow",
    settlementDescription: "Marketplace holds funds and handles refunds.",
    authRequirement: {
      type: "x402",
      description: "Requires x402 payment headers and Fast wallet authorization.",
      paymentProtocol: "x402",
      paymentHeaders: {
        required: "payment-required",
        signature: "payment-signature",
        response: "payment-response",
        paymentIdentifier: "payment-identifier"
      }
    },
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
      additionalProperties: true
    },
    requestExample: { query: "alpha" },
    responseExample: { ok: true },
    usageNotes: "Use for quick research lookups.",
    asyncConfig: null,
    serviceSummary: buildServiceSummary(),
    ...overrides
  };
}

function buildServiceDetail(overrides: Record<string, unknown> = {}) {
  return {
    serviceType: "marketplace_proxy",
    summary: buildServiceSummary(),
    about: "Mock service detail.",
    useThisServicePrompt: "Use the mock service.",
    skillUrl: "https://marketplace.example.com/skill.md",
    endpoints: [
      {
        endpointType: "marketplace_proxy",
        routeId: "mock.quick-insight.v1",
        ref: "mock.quick-insight",
        title: "Quick Insight",
        description: "Run a quick signal lookup.",
        price: "$0.0001",
        billingType: "fixed_x402",
        tokenSymbol: "USDC",
        mode: "sync",
        method: "POST",
        path: "/api/mock/quick-insight",
        proxyUrl: `${API_URL}/api/mock/quick-insight`,
        authRequirement: {
          type: "x402",
          description: "Requires x402 payment headers and Fast wallet authorization.",
          paymentProtocol: "x402",
          paymentHeaders: {
            required: "payment-required",
            signature: "payment-signature",
            response: "payment-response",
            paymentIdentifier: "payment-identifier"
          }
        },
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
          additionalProperties: true
        },
        requestExample: { query: "alpha" },
        responseExample: { ok: true }
      }
    ],
    ...overrides
  };
}

describe("marketplace cli", () => {
  it("initializes and loads a local wallet keyfile", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "marketplace-cli-wallet-"));
    const keyfilePath = join(tempDir, "wallet.json");
    const configPath = join(tempDir, "config.json");

    const initialized = await initializeWallet({ keyfilePath, configPath, network: "testnet" });
    const loaded = await walletAddress({ keyfilePath, configPath });
    const config = await readCliConfig(configPath);

    expect(loaded.address).toBe(initialized.address);
    expect(config.defaultNetwork).toBe("testnet");
  });

  it("searches the machine-readable catalog", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input.toString();
      expect(url).toContain("/catalog/search?q=shopping&mode=sync");
      return jsonResponse(200, {
        results: [
          {
            kind: "route",
            summary: {
              ref: "amazon.search",
              routeId: "amazon.search.v1"
            }
          },
          {
            kind: "service",
            summary: {
              slug: "amazon-shop-proxy"
            },
            executableByMarketplace: true,
            routeRefs: ["amazon.search"]
          }
        ]
      });
    });

    const result = await searchMarketplace(
      {
        apiUrl: API_URL,
        q: "shopping",
        mode: "sync"
      },
      {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        confirm: async () => true,
        now: () => new Date(),
        print: () => {},
        error: () => {}
      }
    );

    expect(result.results).toHaveLength(2);
    expect(result.results[0]).toMatchObject({
      kind: "route"
    });
  });

  it("shows either a service slug or a route ref", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/catalog/services/mock-research-signals")) {
        return jsonResponse(200, buildServiceDetail());
      }
      if (url.endsWith("/catalog/routes/mock/quick-insight")) {
        return jsonResponse(200, buildRouteDetail());
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const deps = {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      confirm: async () => true,
      now: () => new Date(),
      print: () => {},
      error: () => {}
    };

    const service = await showMarketplaceItem(
      {
        apiUrl: API_URL,
        ref: "mock-research-signals"
      },
      deps
    );
    const route = await showMarketplaceItem(
      {
        apiUrl: API_URL,
        ref: "mock.quick-insight"
      },
      deps
    );

    expect(service).toMatchObject({
      serviceType: "marketplace_proxy"
    });
    expect(route).toMatchObject({
      kind: "route",
      ref: "mock.quick-insight"
    });
  });

  it("blocks x402 execution when local spend controls would be exceeded", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "marketplace-cli-spend-"));
    const keyfilePath = join(tempDir, "wallet.json");
    const configPath = join(tempDir, "config.json");
    await initializeWallet({ keyfilePath, configPath });
    await setSpendControls({
      configPath,
      maxPerCall: "0.01"
    });

    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/catalog/routes/mock/quick-insight")) {
        return jsonResponse(200, buildRouteDetail());
      }
      if (url.endsWith("/api/mock/quick-insight")) {
        expect(new Headers(init?.headers).get("payment-identifier")).toBeTruthy();
        return jsonResponse(402, {
          accepts: [
            {
              maxAmountRequired: "0.05"
            }
          ]
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    await expect(
      useMarketplaceRoute(
        {
          apiUrl: API_URL,
          ref: "mock.quick-insight",
          body: { query: "alpha" },
          keyfilePath,
          configPath
        },
        {
          fetchImpl: fetchImpl as unknown as typeof fetch,
          confirm: async () => true,
          now: () => new Date("2026-03-18T00:00:00.000Z"),
          print: () => {},
          error: () => {}
        }
      )
    ).rejects.toThrow(/max per call/i);
  });

  it("executes a paid POST route through x402", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "marketplace-cli-use-post-"));
    const keyfilePath = join(tempDir, "wallet.json");
    const configPath = join(tempDir, "config.json");
    await initializeWallet({ keyfilePath, configPath });

    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();

      if (url.endsWith("/catalog/routes/mock/quick-insight")) {
        return jsonResponse(200, buildRouteDetail());
      }

      if (url.endsWith("/api/mock/quick-insight")) {
        const headers = new Headers(init?.headers);
        if (!headers.get("X-PAYMENT")) {
          return jsonResponse(402, {
            x402Version: 1,
            accepts: [
              {
                scheme: "exact",
                network: "fast-mainnet",
                maxAmountRequired: "0.05",
                payTo: "fast19cjwajufyuqv883ydlvrp8xrhxejuvfe40pxq5dsrv675zgh89sqg9txs8",
                asset: FAST_MAINNET_USDC_ASSET_ID
              }
            ]
          });
        }

        return jsonResponse(200, { ok: true, route: "mock.quick-insight" }, { "payment-response": "encoded" });
      }

      const body = JSON.parse(String(init?.body ?? "{}")) as {
        method?: string;
        params?: {
          transaction?: unknown;
          signature?: unknown;
        };
      };
      if (body.method === "proxy_getAccountInfo") {
        return jsonResponse(200, {
          result: {
            next_nonce: 1
          }
        });
      }

      if (body.method === "proxy_getTokenInfo") {
        return jsonResponse(200, {
          result: {
            requested_token_metadata: [
              [
                Array.from(Buffer.from(FAST_MAINNET_USDC_ASSET_ID.slice(2), "hex")),
                {
                  token_name: "USDC",
                  decimals: 6
                }
              ]
            ]
          }
        });
      }

      if (body.method === "proxy_submitTransaction") {
        return jsonResponse(200, {
          result: {
            Success: {
              envelope: {
                transaction: body.params?.transaction,
                signature: body.params?.signature
              },
              signatures: [[[1], [2]]]
            }
          }
        });
      }

      throw new Error(`Unexpected fetch: ${url}`);
    });

    const result = await useMarketplaceRoute(
      {
        apiUrl: API_URL,
        ref: "mock.quick-insight",
        body: { query: "alpha" },
        keyfilePath,
        configPath
      },
      {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        confirm: async () => true,
        now: () => new Date("2026-03-18T00:00:00.000Z"),
        print: () => {},
        error: () => {}
      }
    );

    expect(result).toMatchObject({
      ref: "mock.quick-insight",
      statusCode: 200,
      authFlow: "x402",
      jobToken: null
    });

    const config = await readCliConfig(configPath);
    expect(config.spendLedger?.spentRaw).toBe("50000");
  });

  it("executes a paid GET route with canonical query params", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "marketplace-cli-use-get-"));
    const keyfilePath = join(tempDir, "wallet.json");
    const configPath = join(tempDir, "config.json");
    await initializeWallet({ keyfilePath, configPath });

    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();

      if (url.endsWith("/catalog/routes/weather/lookup")) {
        return jsonResponse(200, buildRouteDetail({
          ref: "weather.lookup",
          routeId: "weather.lookup.v1",
          provider: "weather",
          operation: "lookup",
          title: "Weather Lookup",
          method: "GET",
          path: "/api/weather/lookup",
          proxyUrl: `${API_URL}/api/weather/lookup`,
          requestSchemaJson: {
            type: "object",
            properties: {
              city: { type: "string" },
              day: { type: "integer" }
            },
            required: ["city", "day"],
            additionalProperties: false
          },
          requestExample: { city: "Paris", day: 1 }
        }));
      }

      if (url.endsWith("/api/weather/lookup?city=Paris&day=1")) {
        expect(init?.method).toBe("GET");
        expect(init?.body).toBeUndefined();
        const headers = new Headers(init?.headers);
        if (!headers.get("X-PAYMENT")) {
          return jsonResponse(402, {
            x402Version: 1,
            accepts: [
              {
                scheme: "exact",
                network: "fast-mainnet",
                maxAmountRequired: "0.05",
                payTo: "fast19cjwajufyuqv883ydlvrp8xrhxejuvfe40pxq5dsrv675zgh89sqg9txs8",
                asset: FAST_MAINNET_USDC_ASSET_ID
              }
            ]
          });
        }

        return jsonResponse(200, { city: "Paris", forecast: "sunny" });
      }

      const body = JSON.parse(String(init?.body ?? "{}")) as {
        method?: string;
        params?: {
          transaction?: unknown;
          signature?: unknown;
        };
      };
      if (body.method === "proxy_getAccountInfo") {
        return jsonResponse(200, {
          result: {
            next_nonce: 1
          }
        });
      }

      if (body.method === "proxy_getTokenInfo") {
        return jsonResponse(200, {
          result: {
            requested_token_metadata: [
              [
                Array.from(Buffer.from(FAST_MAINNET_USDC_ASSET_ID.slice(2), "hex")),
                {
                  token_name: "USDC",
                  decimals: 6
                }
              ]
            ]
          }
        });
      }

      if (body.method === "proxy_submitTransaction") {
        return jsonResponse(200, {
          result: {
            Success: {
              envelope: {
                transaction: body.params?.transaction,
                signature: body.params?.signature
              },
              signatures: [[[1], [2]]]
            }
          }
        });
      }

      throw new Error(`Unexpected fetch: ${url}`);
    });

    const result = await useMarketplaceRoute(
      {
        apiUrl: API_URL,
        ref: "weather.lookup",
        body: { day: 1, city: "Paris" },
        keyfilePath,
        configPath
      },
      {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        confirm: async () => true,
        now: () => new Date("2026-03-18T00:00:00.000Z"),
        print: () => {},
        error: () => {}
      }
    );

    expect(result).toMatchObject({
      ref: "weather.lookup",
      statusCode: 200,
      authFlow: "x402",
      body: {
        city: "Paris",
        forecast: "sunny"
      }
    });
  });

  it("executes a free sync route without requiring local wallet setup", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();

      if (url.endsWith("/catalog/routes/public/free-search")) {
        return jsonResponse(200, buildRouteDetail({
          ref: "public.free-search",
          routeId: "public.free-search.v1",
          provider: "public",
          operation: "free-search",
          price: "Free",
          billingType: "free",
          authRequirement: {
            type: "none",
            description: "No payment or session token is required."
          },
          path: "/api/public/free-search",
          proxyUrl: `${API_URL}/api/public/free-search`,
          requestExample: { query: "alpha" }
        }));
      }

      if (url.endsWith("/api/public/free-search")) {
        const headers = new Headers(init?.headers);
        expect(headers.get("authorization")).toBeNull();
        expect(headers.get("x-payment")).toBeNull();
        return jsonResponse(200, {
          ok: true,
          query: "alpha"
        });
      }

      throw new Error(`Unexpected fetch: ${url}`);
    });

    const result = await useMarketplaceRoute(
      {
        apiUrl: API_URL,
        ref: "public.free-search",
        body: { query: "alpha" }
      },
      {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        confirm: async () => true,
        now: () => new Date(),
        print: () => {},
        error: () => {}
      }
    );

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      ref: "public.free-search",
      statusCode: 200,
      authFlow: "none",
      body: {
        ok: true,
        query: "alpha"
      }
    });
  });

  it("executes a prepaid-credit route with wallet-session auth", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "marketplace-cli-use-prepaid-"));
    const keyfilePath = join(tempDir, "wallet.json");
    const configPath = join(tempDir, "config.json");
    const initialized = await initializeWallet({ keyfilePath, configPath });

    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();

      if (url.endsWith("/catalog/routes/orders/place-order")) {
        return jsonResponse(200, buildRouteDetail({
          ref: "orders.place-order",
          routeId: "orders.place-order.v1",
          provider: "orders",
          operation: "place-order",
          price: "Prepaid credit",
          billingType: "prepaid_credit",
          authRequirement: {
            type: "wallet_session",
            description: "Requires a wallet-bound bearer token scoped to the route.",
            authorizationScheme: "Bearer",
            challengeEndpoint: "/auth/challenge",
            sessionEndpoint: "/auth/session",
            resourceType: "api"
          },
          path: "/api/orders/place-order",
          proxyUrl: `${API_URL}/api/orders/place-order`,
          requestSchemaJson: {
            type: "object",
            properties: {
              item: { type: "string" }
            },
            required: ["item"],
            additionalProperties: false
          },
          requestExample: { item: "notebook" }
        }));
      }

      if (url.endsWith("/auth/challenge")) {
        return jsonResponse(200, {
          wallet: initialized.address,
          resourceType: "api",
          resourceId: "orders.place-order.v1",
          nonce: "nonce-2",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          message: [
            "Fast Marketplace Access",
            `Wallet: ${initialized.address}`,
            "Resource: api/orders.place-order.v1",
            "Nonce: nonce-2",
            `Expires: ${new Date(Date.now() + 60_000).toISOString()}`
          ].join("\n")
        });
      }

      if (url.endsWith("/auth/session")) {
        return jsonResponse(200, {
          accessToken: "api-token-1"
        });
      }

      if (url.endsWith("/api/orders/place-order")) {
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer api-token-1");
        return jsonResponse(200, {
          orderId: "ord_123"
        });
      }

      throw new Error(`Unexpected fetch: ${url}`);
    });

    const result = await useMarketplaceRoute(
      {
        apiUrl: API_URL,
        ref: "orders.place-order",
        body: { item: "notebook" },
        keyfilePath,
        configPath
      },
      {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        confirm: async () => true,
        now: () => new Date(),
        print: () => {},
        error: () => {}
      }
    );

    expect(result).toMatchObject({
      ref: "orders.place-order",
      statusCode: 200,
      authFlow: "wallet_session",
      body: { orderId: "ord_123" }
    });
  });

  it("returns a job token for async wallet-session routes and retrieves jobs", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "marketplace-cli-use-async-"));
    const keyfilePath = join(tempDir, "wallet.json");
    const configPath = join(tempDir, "config.json");
    const initialized = await initializeWallet({ keyfilePath, configPath });

    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();

      if (url.endsWith("/catalog/routes/signals/async-search")) {
        return jsonResponse(200, buildRouteDetail({
          ref: "signals.async-search",
          routeId: "signals.async-search.v1",
          provider: "signals",
          operation: "async-search",
          price: "Free",
          billingType: "free",
          mode: "async",
          authRequirement: {
            type: "wallet_session",
            description: "Requires a wallet-bound bearer token scoped to the route.",
            authorizationScheme: "Bearer",
            challengeEndpoint: "/auth/challenge",
            sessionEndpoint: "/auth/session",
            resourceType: "api"
          },
          path: "/api/signals/async-search",
          proxyUrl: `${API_URL}/api/signals/async-search`
        }));
      }

      if (url.endsWith("/auth/challenge")) {
        const body = JSON.parse(String(init?.body ?? "{}")) as { resourceType: string; resourceId: string };
        return jsonResponse(200, {
          wallet: initialized.address,
          resourceType: body.resourceType,
          resourceId: body.resourceId,
          nonce: "nonce-async",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          message: [
            "Fast Marketplace Access",
            `Wallet: ${initialized.address}`,
            `Resource: ${body.resourceType}/${body.resourceId}`,
            "Nonce: nonce-async",
            `Expires: ${new Date(Date.now() + 60_000).toISOString()}`
          ].join("\n")
        });
      }

      if (url.endsWith("/auth/session")) {
        return jsonResponse(200, {
          accessToken: "token-async"
        });
      }

      if (url.endsWith("/api/signals/async-search")) {
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer token-async");
        return jsonResponse(202, {
          jobToken: "job_123",
          status: "pending"
        });
      }

      if (url.endsWith("/api/jobs/job_123")) {
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer token-async");
        return jsonResponse(200, {
          jobToken: "job_123",
          status: "completed"
        });
      }

      throw new Error(`Unexpected fetch: ${url}`);
    });

    const deps = {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      confirm: async () => true,
      now: () => new Date(),
      print: () => {},
      error: () => {}
    };

    const useResult = await useMarketplaceRoute(
      {
        apiUrl: API_URL,
        ref: "signals.async-search",
        body: { query: "fast" },
        keyfilePath,
        configPath
      },
      deps
    );
    const jobResult = await fetchJobResult(
      {
        apiUrl: API_URL,
        jobToken: "job_123",
        keyfilePath,
        configPath
      },
      deps
    );

    expect(useResult).toMatchObject({
      ref: "signals.async-search",
      statusCode: 202,
      authFlow: "wallet_session",
      jobToken: "job_123"
    });
    expect(jobResult).toMatchObject({
      statusCode: 200,
      body: {
        jobToken: "job_123",
        status: "completed"
      }
    });
  });
});
