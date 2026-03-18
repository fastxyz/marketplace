import { zodToJsonSchema } from "zod-to-json-schema";

import { buildServiceSummary, getRoutesForService } from "./catalog.js";
import {
  MARKETPLACE_NAME,
  MARKETPLACE_VERSION,
  PAYMENT_IDENTIFIER_HEADER,
  PAYMENT_REQUIRED_HEADER,
  PAYMENT_RESPONSE_HEADER,
  PAYMENT_SIGNATURE_HEADER
} from "./constants.js";
import { listServiceDefinitions } from "./services.js";
import { marketplaceRoutes } from "./routes.js";
import { getDefaultMarketplaceNetworkConfig } from "./network.js";

export function buildOpenApiDocument(baseUrl = "http://localhost:3000") {
  const network = getDefaultMarketplaceNetworkConfig();
  const paths: Record<string, unknown> = {
    "/auth/wallet/challenge": {
      post: {
        summary: "Create a wallet-signin challenge for the marketplace website.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["wallet"],
                properties: {
                  wallet: { type: "string" }
                }
              }
            }
          }
        },
        responses: {
          "200": { description: "Wallet challenge created." }
        }
      }
    },
    "/auth/wallet/session": {
      post: {
        summary: "Exchange a signed wallet challenge for a short-lived website session token.",
        responses: {
          "200": { description: "Wallet session created." }
        }
      }
    },
    "/auth/challenge": {
      post: {
        summary: "Create a wallet challenge for a previously paid resource.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["wallet", "resourceType", "resourceId"],
                properties: {
                  wallet: { type: "string" },
                  resourceType: { type: "string", enum: ["job"] },
                  resourceId: { type: "string" }
                }
              }
            }
          }
        },
        responses: {
          "200": { description: "Challenge created." }
        }
      }
    },
    "/auth/session": {
      post: {
        summary: "Exchange a wallet challenge signature for a short-lived access token.",
        responses: {
          "200": { description: "Session created." }
        }
      }
    },
    "/api/jobs/{jobToken}": {
      get: {
        summary: "Retrieve a previously paid async job using a wallet-bound session.",
        parameters: [
          {
            in: "path",
            name: "jobToken",
            required: true,
            schema: { type: "string" }
          }
        ],
        responses: {
          "200": { description: "Job status or result." },
          "401": { description: "Missing or invalid session token." }
        }
      }
    },
    "/catalog/services": {
      get: {
        summary: "List marketplace services with live stats."
      }
    },
    "/catalog/services/{slug}": {
      get: {
        summary: "Get one marketplace service with endpoint docs and generated usage instructions.",
        parameters: [
          {
            in: "path",
            name: "slug",
            required: true,
            schema: { type: "string" }
          }
        ]
      }
    },
    "/catalog/suggestions": {
      post: {
        summary: "Submit a new endpoint or source suggestion for the marketplace."
      }
    },
    "/internal/suggestions": {
      get: {
        summary: "List private marketplace suggestions for operator review."
      }
    },
    "/internal/suggestions/{id}": {
      patch: {
        summary: "Update a suggestion status or internal notes.",
        parameters: [
          {
            in: "path",
            name: "id",
            required: true,
            schema: { type: "string" }
          }
        ]
      }
    },
    "/openapi.json": {
      get: {
        summary: "OpenAPI document."
      }
    },
    "/llms.txt": {
      get: {
        summary: "Agent-facing marketplace summary."
      }
    },
    "/.well-known/marketplace.json": {
      get: {
        summary: "Machine-readable marketplace catalog."
      }
    }
  };

  for (const route of marketplaceRoutes) {
    paths[`/api/${route.provider}/${route.operation}`] = {
      post: {
        summary: route.title,
        description: route.description,
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: zodToJsonSchema(route.inputSchema, `${route.routeId}.input`)
            }
          }
        },
        responses: {
          "200": {
            description: "Paid sync response.",
            content: {
              "application/json": {
                schema: zodToJsonSchema(route.outputSchema, `${route.routeId}.output`)
              }
            }
          },
          "202": {
            description: "Paid async job accepted."
          },
          "402": {
            description: "Payment required.",
            headers: {
              [PAYMENT_REQUIRED_HEADER]: {
                schema: { type: "string" }
              }
            }
          }
        },
        parameters: [
          {
            in: "header",
            name: PAYMENT_IDENTIFIER_HEADER,
            required: false,
            schema: { type: "string" }
          },
          {
            in: "header",
            name: PAYMENT_SIGNATURE_HEADER,
            required: false,
            schema: { type: "string" }
          },
          {
            in: "header",
            name: PAYMENT_RESPONSE_HEADER,
            required: false,
            schema: { type: "string" }
          }
        ]
      }
    };
  }

  return {
    openapi: "3.1.0",
    info: {
      title: MARKETPLACE_NAME,
      version: MARKETPLACE_VERSION,
      description: `Deployment network: ${network.displayName}`
    },
    servers: [{ url: baseUrl }],
    paths
  };
}

export function buildLlmsTxt(baseUrl = "http://localhost:3000"): string {
  const network = getDefaultMarketplaceNetworkConfig();
  const lines = [
    `# ${MARKETPLACE_NAME}`,
    "",
    "Fast-only x402 paid API marketplace.",
    "",
    `Base URL: ${baseUrl}`,
    `Fast network: ${network.displayName}`,
    `Settlement token: ${network.tokenSymbol}`,
    `Marketplace catalog: ${baseUrl}/catalog/services`,
    "Payment protocol: x402 over HTTP",
    `Payment headers: ${PAYMENT_REQUIRED_HEADER}, ${PAYMENT_SIGNATURE_HEADER}, ${PAYMENT_RESPONSE_HEADER}`,
    "Repeat retrieval auth: wallet challenge session",
    "Marketplace skill: serve from the public web app at /skill.md",
    "",
    "## Services"
  ];

  for (const service of listServiceDefinitions()) {
    const routes = getRoutesForService(service);
    const summary = buildServiceSummary({
      service,
      analytics: {
        totalCalls: 0,
        revenueRaw: "0",
        successRate30d: 0,
        volume30d: []
      }
    });

    lines.push(
      `- ${service.name}`,
      `  owner: ${service.ownerName}`,
      `  slug: ${service.slug}`,
      `  priceRange: ${summary.priceRange}`,
      `  endpointCount: ${routes.length}`,
      `  categories: ${service.categories.join(", ")}`
    );
  }

  lines.push("", "## Routes");

  for (const route of marketplaceRoutes) {
    lines.push(
      `- POST /api/${route.provider}/${route.operation}`,
      `  routeId: ${route.routeId}`,
      `  mode: ${route.mode}`,
      `  network: ${route.network}`,
      `  price: ${route.price}`,
      `  description: ${route.description}`
    );
  }

  lines.push("", "## Free Retrieval", "- GET /api/jobs/{jobToken} with a wallet-bound bearer token");

  return lines.join("\n");
}

export function buildMarketplaceCatalog(baseUrl = "http://localhost:3000") {
  const network = getDefaultMarketplaceNetworkConfig();
  return {
    name: MARKETPLACE_NAME,
    version: MARKETPLACE_VERSION,
    baseUrl,
    network: {
      deployment: network.deploymentNetwork,
      payment: network.paymentNetwork,
      token: network.tokenSymbol,
      rpcUrl: network.rpcUrl
    },
    payment: {
      protocol: "x402",
      headers: {
        required: PAYMENT_REQUIRED_HEADER,
        signature: PAYMENT_SIGNATURE_HEADER,
        response: PAYMENT_RESPONSE_HEADER,
        paymentIdentifier: PAYMENT_IDENTIFIER_HEADER
      }
    },
    auth: {
      type: "wallet-challenge",
      challengeEndpoint: "/auth/challenge",
      sessionEndpoint: "/auth/session",
      walletChallengeEndpoint: "/auth/wallet/challenge",
      walletSessionEndpoint: "/auth/wallet/session"
    },
    services: listServiceDefinitions().map((service) => ({
      slug: service.slug,
      name: service.name,
      ownerName: service.ownerName,
      categories: service.categories,
      routeIds: service.routeIds
    })),
    routes: marketplaceRoutes.map((route) => ({
      routeId: route.routeId,
      provider: route.provider,
      operation: route.operation,
      method: "POST",
      path: `/api/${route.provider}/${route.operation}`,
      mode: route.mode,
      network: route.network,
      price: route.price,
      description: route.description
    }))
  };
}
