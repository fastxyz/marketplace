import { buildServiceSummary } from "./catalog.js";
import {
  MARKETPLACE_NAME,
  MARKETPLACE_VERSION,
  PAYMENT_IDENTIFIER_HEADER,
  PAYMENT_REQUIRED_HEADER,
  PAYMENT_RESPONSE_HEADER,
  PAYMENT_SIGNATURE_HEADER
} from "./constants.js";
import { getDefaultMarketplaceNetworkConfig } from "./network.js";
import type { MarketplaceRoute, ServiceDefinition } from "./types.js";

export function buildOpenApiDocument(input: {
  baseUrl?: string;
  services: ServiceDefinition[];
  routes: MarketplaceRoute[];
}) {
  const network = getDefaultMarketplaceNetworkConfig();
  const baseUrl = input.baseUrl ?? "http://localhost:3000";

  const paths: Record<string, unknown> = {
    "/auth/wallet/challenge": {
      post: {
        summary: "Create a wallet-signin challenge for the marketplace website."
      }
    },
    "/auth/wallet/session": {
      post: {
        summary: "Exchange a signed wallet challenge for a short-lived website session token."
      }
    },
    "/auth/challenge": {
      post: {
        summary: "Create a wallet challenge for a previously paid resource."
      }
    },
    "/auth/session": {
      post: {
        summary: "Exchange a wallet challenge signature for a short-lived access token."
      }
    },
    "/api/jobs/{jobToken}": {
      get: {
        summary: "Retrieve a previously paid async job using a wallet-bound session."
      }
    },
    "/catalog/services": {
      get: {
        summary: "List marketplace services with live stats."
      }
    },
    "/catalog/services/{slug}": {
      get: {
        summary: "Get one marketplace service with endpoint docs and generated usage instructions."
      }
    },
    "/catalog/suggestions": {
      post: {
        summary: "Submit a new endpoint or source suggestion for the marketplace."
      }
    },
    "/provider/me": {
      get: {
        summary: "Get the provider account for the current website wallet session."
      },
      post: {
        summary: "Create or update the provider account for the current website wallet session."
      }
    },
    "/provider/requests": {
      get: {
        summary: "List provider-visible request intake for the current website wallet session."
      }
    },
    "/provider/requests/{id}/claim": {
      post: {
        summary: "Claim one provider request from the current website wallet session."
      }
    },
    "/provider/services": {
      get: {
        summary: "List provider-owned service drafts."
      },
      post: {
        summary: "Create a provider-owned service draft."
      }
    },
    "/provider/services/{id}": {
      get: {
        summary: "Get one provider-owned service draft."
      },
      patch: {
        summary: "Update service draft metadata."
      }
    },
    "/provider/services/{id}/endpoints": {
      post: {
        summary: "Create a provider endpoint draft."
      }
    },
    "/provider/services/{id}/endpoints/{endpointId}": {
      patch: {
        summary: "Update a provider endpoint draft."
      },
      delete: {
        summary: "Delete a provider endpoint draft."
      }
    },
    "/provider/services/{id}/verification-challenge": {
      post: {
        summary: "Create a website ownership verification challenge for a provider service."
      }
    },
    "/provider/services/{id}/verify": {
      post: {
        summary: "Verify website ownership for a provider service."
      }
    },
    "/provider/services/{id}/submit": {
      post: {
        summary: "Submit the current provider service draft for review."
      }
    },
    "/internal/suggestions": {
      get: {
        summary: "List private marketplace suggestions for operator review."
      }
    },
    "/internal/suggestions/{id}": {
      patch: {
        summary: "Update a suggestion status or internal notes."
      }
    },
    "/internal/provider-services": {
      get: {
        summary: "List provider service drafts for marketplace review."
      }
    },
    "/internal/provider-services/{id}": {
      get: {
        summary: "Get one provider service draft for marketplace review."
      }
    },
    "/internal/provider-services/{id}/request-changes": {
      post: {
        summary: "Request provider changes before publish."
      }
    },
    "/internal/provider-services/{id}/publish": {
      post: {
        summary: "Publish the latest submitted provider service snapshot."
      }
    },
    "/internal/provider-services/{id}/suspend": {
      post: {
        summary: "Suspend a provider service from the public marketplace."
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

  for (const route of input.routes) {
    paths[`/api/${route.provider}/${route.operation}`] = {
      post: {
        summary: route.title,
        description: route.description,
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: route.requestSchemaJson
            }
          }
        },
        responses: {
          "200": {
            description: "Paid sync response.",
            content: {
              "application/json": {
                schema: route.responseSchemaJson
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

export function buildLlmsTxt(input: {
  baseUrl?: string;
  services: ServiceDefinition[];
  routes: MarketplaceRoute[];
}): string {
  const network = getDefaultMarketplaceNetworkConfig();
  const baseUrl = input.baseUrl ?? "http://localhost:3000";
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

  for (const service of input.services) {
    const routes = input.routes.filter((route) => service.routeIds.includes(route.routeId));
    const summary = buildServiceSummary({
      service,
      endpoints: routes,
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

  for (const route of input.routes) {
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

export function buildMarketplaceCatalog(input: {
  baseUrl?: string;
  services: ServiceDefinition[];
  routes: MarketplaceRoute[];
}) {
  const network = getDefaultMarketplaceNetworkConfig();
  const baseUrl = input.baseUrl ?? "http://localhost:3000";

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
    services: input.services.map((service) => ({
      slug: service.slug,
      name: service.name,
      ownerName: service.ownerName,
      categories: service.categories,
      routeIds: service.routeIds
    })),
    routes: input.routes.map((route) => ({
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
