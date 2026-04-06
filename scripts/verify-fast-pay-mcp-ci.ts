import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import process from "node:process";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

async function main() {
  const requests: Array<{ method: string; url: string; body: unknown }> = [];
  const server = createServer(async (req, res) => {
    await handleRequest(req, res, requests);
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to determine mock server address.");
  }

  const stderrChunks: string[] = [];
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", "packages/mcp/src/index.ts"],
    cwd: process.cwd(),
    env: {
      ...process.env,
      MARKETPLACE_API_BASE_URL: `http://127.0.0.1:${address.port}`,
      MARKETPLACE_FAST_NETWORK: "testnet",
      FAST_PRIVATE_KEY: "11".repeat(32)
    },
    stderr: "pipe"
  });
  transport.stderr?.on("data", (chunk) => {
    stderrChunks.push(String(chunk));
  });

  const client = new Client({
    name: "fast-pay-mcp-ci-smoke",
    version: "0.0.0"
  });

  try {
    await client.connect(transport);

    const tools = await client.listTools();
    assert.ok(
      tools.tools.some((tool) => tool.name === "marketplace_call"),
      "Expected marketplace_call to be registered."
    );

    const result = await client.callTool({
      name: "marketplace_call",
      arguments: {
        ref: "research.search",
        input: {
          query: "agent spend controls"
        }
      }
    });

    assert.deepEqual(result.structuredContent, {
      ref: "research.search",
      statusCode: 200,
      body: {
        ok: true,
        received: {
          query: "agent spend controls"
        }
      },
      authFlow: "none",
      jobToken: null
    });
    assert.ok(
      requests.some((request) => request.method === "GET" && request.url === "/catalog/routes/research/search"),
      "Expected route detail lookup to hit the mock catalog endpoint."
    );
    assert.ok(
      requests.some((request) => request.method === "POST" && request.url === "/api/research/search"),
      "Expected tool execution to hit the mock API endpoint."
    );
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
}

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
    return json(res, 200, {
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
    });
  }

  if (req.method === "POST" && req.url === "/api/research/search") {
    return json(res, 200, {
      ok: true,
      received: body
    });
  }

  return json(res, 404, {
    error: `Unhandled mock request: ${req.method ?? "GET"} ${req.url ?? "/"}`
  });
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

function json(res: ServerResponse, statusCode: number, body: unknown) {
  res.statusCode = statusCode;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

await main();
