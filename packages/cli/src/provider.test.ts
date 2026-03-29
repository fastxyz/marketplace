import { mkdtemp, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { InMemoryMarketplaceStore, type ProviderServiceDetailRecord } from "@marketplace/shared";

import { createMarketplaceApi } from "../../../apps/api/src/app.js";
import { loadWalletFromPrivateKey } from "./lib.js";
import { createProviderSiteSession, submitProviderService, syncProviderSpec, type ProviderSyncSpec, verifyProviderService } from "./provider.js";

const TREASURY_PRIVATE_KEY = "22".repeat(32);
const AGENT_PRIVATE_KEY = "33".repeat(32);
const OTHER_PRIVATE_KEY = "44".repeat(32);

const originalCwd = process.cwd();
const originalAgentWalletKey = process.env.AGENT_WALLET_KEY;
const originalApiBaseUrl = process.env.MARKETPLACE_API_BASE_URL;
const originalNetwork = process.env.MARKETPLACE_FAST_NETWORK;

const startedServers: Server[] = [];

describe("provider cli", () => {
  afterEach(async () => {
    process.chdir(originalCwd);

    resetEnv("AGENT_WALLET_KEY", originalAgentWalletKey);
    resetEnv("MARKETPLACE_API_BASE_URL", originalApiBaseUrl);
    resetEnv("MARKETPLACE_FAST_NETWORK", originalNetwork);

    vi.restoreAllMocks();

    await Promise.all(startedServers.splice(0).map(closeServer));
  });

  it("loads AGENT_WALLET_KEY from repo-root .env and creates a site session", async () => {
    const { apiUrl } = await startApiServer();
    const agentWallet = await loadWalletFromPrivateKey({
      privateKey: AGENT_PRIVATE_KEY,
      sourceLabel: "env:AGENT_WALLET_KEY",
      network: "mainnet"
    });

    await withAgentEnv(apiUrl, async () => {
      const session = await createProviderSiteSession({});

      expect(session.wallet).toBe(agentWallet.paymentWallet.address);
      expect(session.accessToken).toBeTruthy();
      expect(session.resourceId).toBe("http://marketplace.local");
      expect(session.keySource).toBe("env:AGENT_WALLET_KEY");
    });
  });

  it("syncs a new provider profile, draft service, endpoint drafts, and a missing runtime key", async () => {
    const { apiUrl, store } = await startApiServer();
    const spec = buildMarketplaceSpec({
      service: {
        slug: "signal-labs",
        apiNamespace: "signals"
      },
      endpoints: [
        buildMarketplaceEndpoint({
          operation: "quote",
          title: "Quote"
        })
      ]
    });

    await withAgentEnv(apiUrl, async (tempDir) => {
      const result = await syncProviderSpec({
        specPath: await writeSpec(tempDir, "provider-spec.json", spec)
      });

      expect(result.status).toBe("synced");
      expect(result.service.slug).toBe("signal-labs");
      expect(result.service.status).toBe("draft");
      expect(result.runtimeKey.created).toBe(true);
      expect(result.runtimeKey.keyPrefix).toBeTruthy();
      expect(result.runtimeKey.plaintextKey).toBeTruthy();
      expect(result.endpoints.created).toEqual(["marketplace:quote"]);
      expect(result.endpoints.updated).toEqual([]);
      expect(result.endpoints.deleted).toEqual([]);

      const account = await store.getProviderAccountByWallet(result.wallet);
      expect(account?.displayName).toBe(spec.profile.displayName);

      const services = await store.listProviderServices(result.wallet);
      expect(services).toHaveLength(1);
      expect(services[0]?.endpoints).toHaveLength(1);
      expect(services[0]?.endpoints[0]?.endpointType).toBe("marketplace_proxy");
    });
  });

  it("reconciles provider endpoint drafts without duplicates on repeated sync", async () => {
    const { apiUrl, store } = await startApiServer();

    const initialSpec = buildMarketplaceSpec({
      service: {
        slug: "signal-labs",
        apiNamespace: "signals"
      },
      endpoints: [
        buildMarketplaceEndpoint({
          operation: "quote",
          title: "Quote"
        }),
        buildMarketplaceEndpoint({
          operation: "news",
          title: "News",
          description: "Return a short market-news digest."
        })
      ]
    });

    const updatedSpec = buildMarketplaceSpec({
      service: {
        slug: "signal-labs",
        apiNamespace: "signals"
      },
      endpoints: [
        buildMarketplaceEndpoint({
          operation: "quote",
          title: "Latest Quote",
          description: "Return the latest quote snapshot with confidence."
        }),
        buildMarketplaceEndpoint({
          operation: "search",
          title: "Search",
          description: "Search provider-authored market signals."
        })
      ]
    });

    await withAgentEnv(apiUrl, async (tempDir) => {
      await syncProviderSpec({
        specPath: await writeSpec(tempDir, "provider-spec-initial.json", initialSpec)
      });

      const result = await syncProviderSpec({
        specPath: await writeSpec(tempDir, "provider-spec-updated.json", updatedSpec)
      });

      expect(result.runtimeKey.created).toBe(false);
      expect(result.endpoints.created).toEqual(["marketplace:search"]);
      expect(result.endpoints.updated).toEqual(["marketplace:quote"]);
      expect(result.endpoints.deleted).toEqual(["marketplace:news"]);

      const services = await store.listProviderServices(result.wallet);
      expect(services).toHaveLength(1);

      const detail = services[0] as ProviderServiceDetailRecord;
      expect(detail.endpoints).toHaveLength(2);
      expect(detail.endpoints.find((endpoint) => endpoint.endpointType === "marketplace_proxy" && endpoint.operation === "quote")?.title)
        .toBe("Latest Quote");
      expect(detail.endpoints.find((endpoint) => endpoint.endpointType === "marketplace_proxy" && endpoint.operation === "search"))
        .toBeTruthy();
      expect(detail.endpoints.some((endpoint) => endpoint.endpointType === "marketplace_proxy" && endpoint.operation === "news"))
        .toBe(false);
    });
  });

  it("resets endpoint drafts before changing apiNamespace and rebuilds from spec", async () => {
    const { apiUrl, store } = await startApiServer();

    const initialSpec = buildMarketplaceSpec({
      service: {
        slug: "signal-labs",
        apiNamespace: "signals"
      },
      endpoints: [buildMarketplaceEndpoint({ operation: "quote", title: "Quote" })]
    });

    const renamedSpec = buildMarketplaceSpec({
      service: {
        slug: "signal-labs",
        apiNamespace: "signals-next"
      },
      endpoints: [buildMarketplaceEndpoint({ operation: "quote", title: "Quote" })]
    });

    await withAgentEnv(apiUrl, async (tempDir) => {
      const initialResult = await syncProviderSpec({
        specPath: await writeSpec(tempDir, "provider-spec-initial.json", initialSpec)
      });

      const result = await syncProviderSpec({
        specPath: await writeSpec(tempDir, "provider-spec-renamed.json", renamedSpec)
      });

      expect(result.runtimeKey.created).toBe(false);
      expect(result.endpoints.created).toEqual(["marketplace:quote"]);
      expect(result.endpoints.updated).toEqual([]);
      expect(result.endpoints.deleted).toEqual(["marketplace:quote"]);

      const detail = await store.getProviderServiceForOwner(initialResult.service.id, initialResult.wallet);
      expect(detail?.service.apiNamespace).toBe("signals-next");
      expect(detail?.endpoints).toHaveLength(1);
      expect(detail?.endpoints[0]?.endpointType).toBe("marketplace_proxy");
      expect(detail?.endpoints[0]?.operation).toBe("quote");
    });
  });

  it("restores existing endpoint drafts when apiNamespace update fails after reset", async () => {
    const { apiUrl, store } = await startApiServer();

    const initialSpec = buildMarketplaceSpec({
      service: {
        slug: "signal-labs",
        apiNamespace: "signals"
      },
      endpoints: [buildMarketplaceEndpoint({ operation: "quote", title: "Quote" })]
    });
    const conflictingSpec = buildMarketplaceSpec({
      service: {
        slug: "conflict-labs",
        apiNamespace: "signals-next"
      },
      endpoints: [buildMarketplaceEndpoint({ operation: "search", title: "Search" })]
    });
    const renamedSpec = buildMarketplaceSpec({
      service: {
        slug: "signal-labs",
        apiNamespace: "signals-next"
      },
      endpoints: [buildMarketplaceEndpoint({ operation: "quote", title: "Quote" })]
    });

    const initialResult = await withWalletEnv(apiUrl, AGENT_PRIVATE_KEY, async (tempDir) => syncProviderSpec({
      specPath: await writeSpec(tempDir, "provider-spec-initial.json", initialSpec)
    }));

    await withWalletEnv(apiUrl, OTHER_PRIVATE_KEY, async (tempDir) => syncProviderSpec({
      specPath: await writeSpec(tempDir, "provider-spec-conflict.json", conflictingSpec)
    }));

    await expect(withWalletEnv(apiUrl, AGENT_PRIVATE_KEY, async (tempDir) => syncProviderSpec({
      specPath: await writeSpec(tempDir, "provider-spec-renamed.json", renamedSpec)
    }))).rejects.toThrow("API namespace already exists: signals-next");

    const detail = await store.getProviderServiceForOwner(initialResult.service.id, initialResult.wallet);
    expect(detail?.service.apiNamespace).toBe("signals");
    expect(detail?.endpoints).toHaveLength(1);
    expect(detail?.endpoints[0]?.endpointType).toBe("marketplace_proxy");
    expect(detail?.endpoints[0]?.operation).toBe("quote");
  });

  it("restores already-deleted endpoint drafts when reset fails mid-delete", async () => {
    const { apiUrl, store } = await startApiServer();

    const initialSpec = buildMarketplaceSpec({
      service: {
        slug: "signal-labs",
        apiNamespace: "signals"
      },
      endpoints: [
        buildMarketplaceEndpoint({ operation: "quote", title: "Quote" }),
        buildMarketplaceEndpoint({ operation: "search", title: "Search" })
      ]
    });
    const renamedSpec = buildMarketplaceSpec({
      service: {
        slug: "signal-labs",
        apiNamespace: "signals-next"
      },
      endpoints: [
        buildMarketplaceEndpoint({ operation: "quote", title: "Quote" }),
        buildMarketplaceEndpoint({ operation: "search", title: "Search" })
      ]
    });

    const initialResult = await withWalletEnv(apiUrl, AGENT_PRIVATE_KEY, async (tempDir) => syncProviderSpec({
      specPath: await writeSpec(tempDir, "provider-spec-initial.json", initialSpec)
    }));

    const originalFetch = globalThis.fetch.bind(globalThis);
    let deleteCount = 0;
    await expect(withWalletEnv(apiUrl, AGENT_PRIVATE_KEY, async (tempDir) => syncProviderSpec(
      {
        specPath: await writeSpec(tempDir, "provider-spec-renamed.json", renamedSpec)
      },
      {
        fetchImpl: async (input, init) => {
          const url = String(input);
          if (url.includes(`/provider/services/${initialResult.service.id}/endpoints/`) && init?.method === "DELETE") {
            deleteCount += 1;
            if (deleteCount === 2) {
              return new Response("delete failed mid-reset", { status: 500 });
            }
          }

          return originalFetch(input, init);
        },
        confirm: async () => true,
        now: () => new Date(),
        print: () => {},
        error: () => {}
      }
    ))).rejects.toThrow("delete failed mid-reset");

    const detail = await store.getProviderServiceForOwner(initialResult.service.id, initialResult.wallet);
    expect(detail?.service.apiNamespace).toBe("signals");
    expect(detail?.endpoints).toHaveLength(2);
    expect(detail?.endpoints.map((endpoint) => endpoint.endpointType === "marketplace_proxy" ? endpoint.operation : null).sort())
      .toEqual(["quote", "search"]);
  });

  it("creates a verification challenge and only verifies after confirmation", async () => {
    const { apiUrl, store } = await startApiServer();
    const spec = buildMarketplaceSpec({
      service: {
        slug: "signal-labs",
        apiNamespace: "signals"
      },
      endpoints: [buildMarketplaceEndpoint({ operation: "quote", title: "Quote" })]
    });

    await withAgentEnv(apiUrl, async (tempDir) => {
      const syncResult = await syncProviderSpec({
        specPath: await writeSpec(tempDir, "provider-spec.json", spec)
      });
      const serviceId = syncResult.service.id;

      const pending = await verifyProviderService(
        { serviceRef: syncResult.service.slug, apiUrl },
        {
          fetchImpl: fetch,
          confirm: async () => false,
          now: () => new Date(),
          print: () => {},
          error: () => {}
        }
      );

      expect(pending.status).toBe("action_required");
      expect(pending.challenge.expectedUrl).toBe("https://provider.example.com/.well-known/fast-marketplace-verification.txt");
      expect(pending.instructions[0]).toContain(pending.challenge.expectedUrl);

      const latestBeforeVerify = await store.getLatestProviderVerification(serviceId);
      expect(latestBeforeVerify?.status).toBe("pending");

      const originalFetch = globalThis.fetch.bind(globalThis);
      vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
        const url = String(input);
        if (url === "https://provider.example.com/.well-known/fast-marketplace-verification.txt") {
          const latest = await store.getLatestProviderVerification(serviceId);
          return new Response(latest?.token ?? "", { status: 200 });
        }

        return originalFetch(input, init);
      });

      const verified = await verifyProviderService(
        { serviceRef: serviceId, apiUrl },
        {
          fetchImpl: originalFetch,
          confirm: async () => true,
          now: () => new Date(),
          print: () => {},
          error: () => {}
        }
      );

      expect(verified.status).toBe("verified");
      expect(verified.verification?.status).toBe("verified");
      expect((await store.getLatestProviderVerification(serviceId))?.status).toBe("verified");
    });
  });

  it("returns actionRequired for unverified submit and reaches pending_review after verification", async () => {
    const { apiUrl, store } = await startApiServer();
    const spec = buildMarketplaceSpec({
      service: {
        slug: "signal-labs",
        apiNamespace: "signals"
      },
      endpoints: [buildMarketplaceEndpoint({ operation: "quote", title: "Quote" })]
    });

    await withAgentEnv(apiUrl, async (tempDir) => {
      const syncResult = await syncProviderSpec({
        specPath: await writeSpec(tempDir, "provider-spec.json", spec)
      });

      const blocked = await submitProviderService({ serviceRef: syncResult.service.slug, apiUrl });
      expect(blocked.status).toBe("action_required");
      expect(blocked.error).toContain("Website verification is incomplete");

      const serviceId = syncResult.service.id;
      const originalFetch = globalThis.fetch.bind(globalThis);
      vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
        const url = String(input);
        if (url === "https://provider.example.com/.well-known/fast-marketplace-verification.txt") {
          const latest = await store.getLatestProviderVerification(serviceId);
          return new Response(latest?.token ?? "", { status: 200 });
        }

        return originalFetch(input, init);
      });

      const verified = await verifyProviderService(
        { serviceRef: serviceId, apiUrl },
        {
          fetchImpl: originalFetch,
          confirm: async () => true,
          now: () => new Date(),
          print: () => {},
          error: () => {}
        }
      );
      expect(verified.status).toBe("verified");

      const submitted = await submitProviderService({ serviceRef: serviceId, apiUrl });
      expect(submitted.status).toBe("submitted");
      expect(submitted.service.status).toBe("pending_review");

      const detail = await store.getProviderServiceForOwner(serviceId, syncResult.wallet);
      expect(detail?.service.status).toBe("pending_review");
    });
  });

  it("submits external registry specs without website verification and still enters pending_review", async () => {
    const { apiUrl, store } = await startApiServer();
    const spec = buildExternalRegistrySpec({
      service: {
        slug: "messari-direct"
      },
      endpoints: [
        {
          endpointType: "external_registry",
          title: "Markets",
          description: "Direct market data endpoint.",
          method: "GET",
          publicUrl: "https://provider.example.com/api/markets",
          docsUrl: "https://docs.provider.example.com/markets",
          authNotes: "Bearer token required.",
          requestExample: {},
          responseExample: { ok: true },
          usageNotes: "Call the provider directly."
        }
      ]
    });

    await withAgentEnv(apiUrl, async (tempDir) => {
      const syncResult = await syncProviderSpec({
        specPath: await writeSpec(tempDir, "external-provider-spec.json", spec)
      });

      const submitted = await submitProviderService({ serviceRef: syncResult.service.slug, apiUrl });
      expect(submitted.status).toBe("submitted");
      expect(submitted.service.status).toBe("pending_review");

      const detail = await store.getProviderServiceForOwner(syncResult.service.id, syncResult.wallet);
      expect(detail?.service.status).toBe("pending_review");
      expect(detail?.verification).toBeNull();
    });
  });

  it("preserves plain-text API errors from the wallet session flow", async () => {
    await withAgentEnv("http://127.0.0.1:9", async () => {
      await expect(createProviderSiteSession(
        {},
        {
          fetchImpl: async () => new Response("upstream gateway exploded", {
            status: 502,
            headers: {
              "content-type": "text/plain"
            }
          }),
          confirm: async () => true,
          now: () => new Date(),
          print: () => {},
          error: () => {}
        }
      )).rejects.toThrow("upstream gateway exploded");
    });
  });
});

async function startApiServer() {
  const treasuryWallet = await loadWalletFromPrivateKey({
    privateKey: TREASURY_PRIVATE_KEY,
    sourceLabel: "test:treasury",
    network: "mainnet"
  });
  const buyerWallet = await loadWalletFromPrivateKey({
    privateKey: OTHER_PRIVATE_KEY,
    sourceLabel: "test:buyer",
    network: "mainnet"
  });
  const store = new InMemoryMarketplaceStore();
  const app = createMarketplaceApi({
    store,
    payTo: buyerWallet.paymentWallet.address,
    sessionSecret: "test-session-secret",
    secretsKey: "test-secrets-key",
    adminToken: "test-admin-token",
    baseUrl: "http://api.marketplace.local",
    webBaseUrl: "http://marketplace.local",
    facilitatorClient: {
      async verify() {
        return {
          isValid: true,
          payer: treasuryWallet.paymentWallet.publicKey,
          network: "fast-mainnet"
        };
      }
    },
    refundService: {
      async issueRefund() {
        return { txHash: "0xrefund" };
      }
    }
  });

  const server = createServer(app);
  startedServers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to start test API server.");
  }

  return {
    apiUrl: `http://127.0.0.1:${address.port}`,
    store
  };
}

async function withAgentEnv<T>(apiUrl: string, fn: (tempDir: string) => Promise<T>) {
  return withWalletEnv(apiUrl, AGENT_PRIVATE_KEY, fn);
}

async function withWalletEnv<T>(apiUrl: string, walletPrivateKey: string, fn: (tempDir: string) => Promise<T>) {
  const tempDir = await mkdtemp(join(tmpdir(), "marketplace-provider-cli-"));
  await writeFile(
    join(tempDir, ".env"),
    [
      `AGENT_WALLET_KEY=${walletPrivateKey}`,
      `MARKETPLACE_API_BASE_URL=${apiUrl}`,
      "MARKETPLACE_FAST_NETWORK=mainnet"
    ].join("\n"),
    "utf8"
  );

  resetEnv("AGENT_WALLET_KEY", undefined);
  resetEnv("MARKETPLACE_API_BASE_URL", undefined);
  resetEnv("MARKETPLACE_FAST_NETWORK", undefined);
  process.chdir(tempDir);

  return fn(tempDir);
}

async function writeSpec(tempDir: string, filename: string, spec: ProviderSyncSpec) {
  const specPath = join(tempDir, filename);
  await writeFile(specPath, JSON.stringify(spec, null, 2), "utf8");
  return specPath;
}

function buildMarketplaceSpec(input: {
  service: {
    slug: string;
    apiNamespace: string;
  };
  endpoints: ProviderSyncSpec["endpoints"];
}): ProviderSyncSpec {
  return {
    profile: {
      displayName: "Signal Labs",
      bio: "Quant feeds for agent workflows.",
      websiteUrl: "https://provider.example.com",
      contactEmail: "ops@provider.example.com"
    },
    service: {
      serviceType: "marketplace_proxy",
      slug: input.service.slug,
      apiNamespace: input.service.apiNamespace,
      name: "Signal Labs",
      tagline: "Short-form market signals",
      about: "Provider-authored signal endpoints for agent workflows.",
      categories: ["Research", "Trading"],
      promptIntro: 'I want to use the "Signal Labs" service on Fast Marketplace.',
      setupInstructions: ["Use a funded Fast wallet.", "Call the marketplace proxy route."],
      websiteUrl: "https://provider.example.com"
    },
    endpoints: input.endpoints
  };
}

function buildMarketplaceEndpoint(input: {
  operation: string;
  title: string;
  description?: string;
}): ProviderSyncSpec["endpoints"][number] {
  return {
    endpointType: "marketplace_proxy",
    operation: input.operation,
    method: "POST",
    title: input.title,
    description: input.description ?? "Return a single quote snapshot.",
    billingType: "fixed_x402",
    price: "$0.0001",
    mode: "sync",
    requestSchemaJson: {
      type: "object",
      properties: {
        symbol: { type: "string", minLength: 1 }
      },
      required: ["symbol"],
      additionalProperties: false
    },
    responseSchemaJson: {
      type: "object",
      properties: {
        symbol: { type: "string" },
        price: { type: "number" }
      },
      required: ["symbol", "price"],
      additionalProperties: false
    },
    requestExample: {
      symbol: "FAST"
    },
    responseExample: {
      symbol: "FAST",
      price: 42.5
    },
    usageNotes: "Returns the latest quote only.",
    upstreamBaseUrl: "https://provider.example.com",
    upstreamPath: `/api/${input.operation}`,
    upstreamAuthMode: "none"
  };
}

function buildExternalRegistrySpec(input: {
  service: {
    slug: string;
  };
  endpoints: ProviderSyncSpec["endpoints"];
}): ProviderSyncSpec {
  return {
    profile: {
      displayName: "Signal Labs",
      bio: "Quant feeds for agent workflows.",
      websiteUrl: "https://provider.example.com",
      contactEmail: "ops@provider.example.com"
    },
    service: {
      serviceType: "external_registry",
      slug: input.service.slug,
      name: "Signal Labs Direct",
      tagline: "Direct provider APIs",
      about: "Discovery-only direct APIs that the marketplace lists but does not execute.",
      categories: ["Research"],
      promptIntro: 'I want to use the "Signal Labs Direct" service.',
      setupInstructions: ["Read the provider docs first."],
      websiteUrl: "https://provider.example.com"
    },
    endpoints: input.endpoints
  };
}

function resetEnv(name: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[name];
    return;
  }

  process.env[name] = value;
}

async function closeServer(server: Server) {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}
