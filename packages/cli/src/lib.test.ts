import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  createApiSession,
  fetchJobResult,
  initializeWallet,
  invokePaidRoute,
  readCliConfig,
  setSpendControls,
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

describe("marketplace cli", () => {
  const mockCatalogResponse = jsonResponse(200, {
    routes: [
      {
        provider: "mock",
        operation: "quick-insight",
        method: "POST",
        requestSchemaJson: {
          type: "object",
          properties: {
            query: { type: "string" }
          },
          required: ["query"],
          additionalProperties: false
        }
      },
      {
        provider: "orders",
        operation: "place-order",
        method: "POST",
        requestSchemaJson: {
          type: "object",
          properties: {
            item: { type: "string" }
          },
          required: ["item"],
          additionalProperties: false
        }
      },
      {
        provider: "weather",
        operation: "lookup",
        method: "GET",
        requestSchemaJson: {
          type: "object",
          properties: {
            city: { type: "string" },
            day: { type: "integer" }
          },
          required: ["city", "day"],
          additionalProperties: false
        }
      }
    ]
  });

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

  it("blocks invocation when local spend controls would be exceeded", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "marketplace-cli-spend-"));
    const keyfilePath = join(tempDir, "wallet.json");
    const configPath = join(tempDir, "config.json");
    await initializeWallet({ keyfilePath, configPath });
    await setSpendControls({
      configPath,
      maxPerCall: "0.01"
    });

    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/.well-known/marketplace.json")) {
        return mockCatalogResponse;
      }

      return jsonResponse(402, {
        accepts: [
          {
            maxAmountRequired: "0.05"
          }
        ]
      });
    });

    await expect(
      invokePaidRoute(
        {
          apiUrl: "http://localhost:3000",
          provider: "mock",
          operation: "quick-insight",
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

  it("invokes a paid route with x402-client compatibility", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "marketplace-cli-invoke-"));
    const keyfilePath = join(tempDir, "wallet.json");
    const configPath = join(tempDir, "config.json");
    await initializeWallet({ keyfilePath, configPath });

    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();

      if (url.endsWith("/.well-known/marketplace.json")) {
        return mockCatalogResponse;
      }

      if (url.includes("/api/mock/quick-insight")) {
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
                asset: "0xc655a12330da6af361d281b197996d2bc135aaed3b66278e729c2222291e9130"
              }
            ]
          });
        }

        return jsonResponse(
          200,
          { ok: true, route: "mock.quick-insight" },
          { "payment-response": "encoded" }
        );
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

    const result = await invokePaidRoute(
      {
        apiUrl: "http://localhost:3000",
        provider: "mock",
        operation: "quick-insight",
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

    expect("success" in result && result.success).toBe(true);
    expect(result.statusCode).toBe(200);
    expect(fetchImpl).toHaveBeenCalled();

    const config = await readCliConfig(configPath);
    expect(config.spendLedger?.spentRaw).toBe("50000");
  });

  it("invokes a paid GET route with canonical query params", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "marketplace-cli-invoke-get-"));
    const keyfilePath = join(tempDir, "wallet.json");
    const configPath = join(tempDir, "config.json");
    await initializeWallet({ keyfilePath, configPath });

    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();

      if (url.endsWith("/.well-known/marketplace.json")) {
        return mockCatalogResponse;
      }

      if (url.includes("/api/weather/lookup?city=Paris&day=1")) {
        const headers = new Headers(init?.headers);
        expect(init?.method).toBe("GET");
        expect(init?.body).toBeUndefined();

        if (!headers.get("X-PAYMENT")) {
          return jsonResponse(402, {
            x402Version: 1,
            accepts: [
              {
                scheme: "exact",
                network: "fast-mainnet",
                maxAmountRequired: "0.05",
                payTo: "fast19cjwajufyuqv883ydlvrp8xrhxejuvfe40pxq5dsrv675zgh89sqg9txs8",
                asset: "0xc655a12330da6af361d281b197996d2bc135aaed3b66278e729c2222291e9130"
              }
            ]
          });
        }

        return jsonResponse(200, {
          city: "Paris",
          forecast: "sunny"
        });
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

    const result = await invokePaidRoute(
      {
        apiUrl: "http://localhost:3000",
        provider: "weather",
        operation: "lookup",
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

    expect("success" in result && result.success).toBe(true);
    expect(result.statusCode).toBe(200);
    expect(result.body).toEqual({
      city: "Paris",
      forecast: "sunny"
    });
  });

  it("retrieves a job through the wallet-challenge flow", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "marketplace-cli-job-"));
    const keyfilePath = join(tempDir, "wallet.json");
    const configPath = join(tempDir, "config.json");
    const initialized = await initializeWallet({ keyfilePath, configPath });

    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input.toString();

      if (url.endsWith("/auth/challenge")) {
        return jsonResponse(200, {
          wallet: initialized.address,
          resourceType: "job",
          resourceId: "job_123",
          nonce: "nonce-1",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          message: [
            "Fast Marketplace Access",
            `Wallet: ${initialized.address}`,
            "Resource: job/job_123",
            "Nonce: nonce-1",
            `Expires: ${new Date(Date.now() + 60_000).toISOString()}`
          ].join("\n")
        });
      }

      if (url.endsWith("/auth/session")) {
        return jsonResponse(200, {
          accessToken: "token-1"
        });
      }

      if (url.endsWith("/api/jobs/job_123")) {
        return jsonResponse(200, {
          jobToken: "job_123",
          status: "completed"
        });
      }

      throw new Error(`Unexpected URL ${url}`);
    });

    const result = await fetchJobResult(
      {
        apiUrl: "http://localhost:3000",
        jobToken: "job_123",
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

    expect(result.statusCode).toBe(200);
    expect(result.body).toEqual({
      jobToken: "job_123",
      status: "completed"
    });
  });

  it("creates an API-scoped session and invokes a prepaid-credit route without x402", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "marketplace-cli-api-session-"));
    const keyfilePath = join(tempDir, "wallet.json");
    const configPath = join(tempDir, "config.json");
    const initialized = await initializeWallet({ keyfilePath, configPath });

    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();

      if (url.endsWith("/.well-known/marketplace.json")) {
        return mockCatalogResponse;
      }

      if (url.endsWith("/api/orders/place-order") && !new Headers(init?.headers).get("authorization")) {
        return jsonResponse(401, { error: "Missing bearer token." });
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

      throw new Error(`Unexpected URL ${url}`);
    });

    const session = await createApiSession(
      {
        apiUrl: "http://localhost:3000",
        provider: "orders",
        operation: "place-order",
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

    expect(session.accessToken).toBe("api-token-1");

    const result = await invokePaidRoute(
      {
        apiUrl: "http://localhost:3000",
        provider: "orders",
        operation: "place-order",
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

    expect(result.statusCode).toBe(200);
    expect(result.body).toEqual({ orderId: "ord_123" });
    expect(result.note).toContain("wallet-session");
  });
});
