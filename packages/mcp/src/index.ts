#!/usr/bin/env node

import process from "node:process";
import { pathToFileURL } from "node:url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { MarketplaceDeploymentNetwork, MarketplaceRouteDetail, ServiceDetail } from "@marketplace/shared";
import { z } from "zod/v3";

import type { CliDependencies } from "../../cli/src/lib.js";
import {
  fetchJobResult,
  loadWallet,
  searchMarketplace,
  showMarketplaceItem,
  useMarketplaceRoute
} from "../../cli/src/lib.js";

export interface FastPayMcpConfig {
  apiUrl: string;
  network: MarketplaceDeploymentNetwork;
  privateKey?: string;
  keyfilePath?: string;
  configPath?: string;
}

function createToolResult(data: unknown) {
  const structuredContent = JSON.parse(JSON.stringify(data)) as Record<string, unknown>;
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(structuredContent, null, 2)
      }
    ],
    structuredContent
  };
}

export function parseFastPayMcpConfig(env: NodeJS.ProcessEnv = process.env): FastPayMcpConfig {
  const schema = z.object({
    MARKETPLACE_API_BASE_URL: z.string().url(),
    MARKETPLACE_FAST_NETWORK: z.enum(["mainnet", "testnet"]),
    FAST_PRIVATE_KEY: z.string().optional(),
    FAST_KEYFILE_PATH: z.string().optional(),
    FAST_MARKETPLACE_CONFIG: z.string().optional()
  }).superRefine((value, ctx) => {
    if (!value.FAST_PRIVATE_KEY && !value.FAST_KEYFILE_PATH) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Set FAST_PRIVATE_KEY or FAST_KEYFILE_PATH before starting fast-pay-mcp."
      });
    }
  });

  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    throw new Error(parsed.error.issues.map((issue) => issue.message).join(" "));
  }

  return {
    apiUrl: parsed.data.MARKETPLACE_API_BASE_URL,
    network: parsed.data.MARKETPLACE_FAST_NETWORK,
    privateKey: parsed.data.FAST_PRIVATE_KEY,
    keyfilePath: parsed.data.FAST_KEYFILE_PATH,
    configPath: parsed.data.FAST_MARKETPLACE_CONFIG
  };
}

export async function validateFastPayMcpConfig(config: FastPayMcpConfig): Promise<void> {
  await loadWallet({
    privateKey: config.privateKey,
    keyfilePath: config.keyfilePath,
    configPath: config.configPath,
    network: config.network
  });
}

export function createFastPayMcpCliDependencies(): CliDependencies {
  return {
    fetchImpl: fetch,
    async confirm() {
      return false;
    },
    now: () => new Date(),
    print() {},
    error(message) {
      console.error(message);
    }
  };
}

function isTopupRoute(detail: ServiceDetail | MarketplaceRouteDetail): detail is MarketplaceRouteDetail {
  return "kind" in detail && detail.kind === "route" && detail.billingType === "topup_x402_variable";
}

export function createFastPayMcpHandlers(config: FastPayMcpConfig, deps: CliDependencies = createFastPayMcpCliDependencies()) {
  return {
    async marketplaceSearch(input: {
      q?: string;
      category?: string;
      billingType?: "fixed_x402" | "topup_x402_variable" | "prepaid_credit" | "free";
      mode?: "sync" | "async";
      settlementMode?: "verified_escrow";
      limit?: number;
    }) {
      return searchMarketplace({
        apiUrl: config.apiUrl,
        ...input
      }, deps);
    },
    async marketplaceShow(input: {
      ref: string;
    }) {
      return showMarketplaceItem({
        apiUrl: config.apiUrl,
        ref: input.ref
      }, deps);
    },
    async marketplaceCall(input: {
      ref: string;
      input: unknown;
    }) {
      return useMarketplaceRoute({
        apiUrl: config.apiUrl,
        ref: input.ref,
        body: input.input,
        privateKey: config.privateKey,
        keyfilePath: config.keyfilePath,
        configPath: config.configPath,
        network: config.network,
        autoApproveExpensive: false
      }, deps);
    },
    async marketplaceTopup(input: {
      ref: string;
      amount: string;
    }) {
      const detail = await showMarketplaceItem({
        apiUrl: config.apiUrl,
        ref: input.ref
      }, deps);
      if (!isTopupRoute(detail)) {
        throw new Error("Top-up requires a route ref with billingType=topup_x402_variable.");
      }

      return useMarketplaceRoute({
        apiUrl: config.apiUrl,
        ref: input.ref,
        body: {
          amount: input.amount
        },
        privateKey: config.privateKey,
        keyfilePath: config.keyfilePath,
        configPath: config.configPath,
        network: config.network,
        autoApproveExpensive: false
      }, deps);
    },
    async marketplaceGetJob(input: {
      jobToken: string;
    }) {
      return fetchJobResult({
        apiUrl: config.apiUrl,
        jobToken: input.jobToken,
        privateKey: config.privateKey,
        keyfilePath: config.keyfilePath,
        configPath: config.configPath,
        network: config.network
      }, deps);
    }
  };
}

export function createFastPayMcpServer(
  config: FastPayMcpConfig,
  deps: CliDependencies = createFastPayMcpCliDependencies()
) {
  const server = new McpServer({
    name: "fast-pay-mcp",
    version: "0.1.0"
  });
  const handlers = createFastPayMcpHandlers(config, deps);

  server.registerTool("marketplace_search", {
    description: "Search Fast marketplace services and executable routes.",
    inputSchema: {
      q: z.string().optional(),
      category: z.string().optional(),
      billingType: z.enum(["fixed_x402", "topup_x402_variable", "prepaid_credit", "free"]).optional(),
      mode: z.enum(["sync", "async"]).optional(),
      settlementMode: z.enum(["verified_escrow"]).optional(),
      limit: z.number().int().min(1).max(100).optional()
    }
  }, async (input) => createToolResult(await handlers.marketplaceSearch(input)));

  server.registerTool("marketplace_show", {
    description: "Get one marketplace service or route by slug or route ref.",
    inputSchema: {
      ref: z.string()
    }
  }, async (input) => createToolResult(await handlers.marketplaceShow(input)));

  server.registerTool("marketplace_call", {
    description: "Invoke one Fast marketplace route using x402 or wallet-session auth.",
    inputSchema: {
      ref: z.string(),
      input: z.unknown()
    }
  }, async (input) => createToolResult(await handlers.marketplaceCall(input)));

  server.registerTool("marketplace_topup", {
    description: "Execute a variable-amount marketplace top-up route.",
    inputSchema: {
      ref: z.string(),
      amount: z.string()
    }
  }, async (input) => createToolResult(await handlers.marketplaceTopup(input)));

  server.registerTool("marketplace_get_job", {
    description: "Fetch an async marketplace job result for the configured wallet.",
    inputSchema: {
      jobToken: z.string()
    }
  }, async (input) => createToolResult(await handlers.marketplaceGetJob(input)));

  return server;
}

export async function main() {
  const config = parseFastPayMcpConfig();
  await validateFastPayMcpConfig(config);

  const transport = new StdioServerTransport();
  const server = createFastPayMcpServer(config);
  await server.connect(transport);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
