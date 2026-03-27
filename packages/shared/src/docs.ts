import { buildServiceSummary } from "./catalog.js";
import { requiresWalletSession, requiresX402Payment, routePriceLabel } from "./billing.js";
import {
  MARKETPLACE_NAME,
  MARKETPLACE_VERSION,
  PAYMENT_IDENTIFIER_HEADER,
  PAYMENT_REQUIRED_HEADER,
  PAYMENT_RESPONSE_HEADER,
  PAYMENT_SIGNATURE_HEADER
} from "./constants.js";
import { getDefaultMarketplaceNetworkConfig } from "./network.js";
import { getQuerySchemaProperties } from "./request-input.js";
import { settlementModeDescription, settlementModeLabel } from "./settlement.js";
import type {
  ExternalRegistryServiceSummary,
  MarketplaceRoute,
  MarketplaceServiceSummary,
  PublishedServiceEndpointVersionRecord,
  ServiceDefinition
} from "./types.js";

type PublishedCatalogService = {
  service: ServiceDefinition;
  endpoints: PublishedServiceEndpointVersionRecord[];
};

function isMarketplaceCatalogService(input: PublishedCatalogService): boolean {
  return input.service.serviceType === "marketplace_proxy";
}

function isExternalCatalogService(input: PublishedCatalogService): boolean {
  return input.service.serviceType === "external_registry";
}

function buildOpenApiQueryParameters(route: MarketplaceRoute): Array<Record<string, unknown>> {
  return getQuerySchemaProperties(route.requestSchemaJson).map((descriptor) => ({
    in: "query",
    name: descriptor.name,
    required: descriptor.required,
    schema: descriptor.schema,
    ...(descriptor.isArray
      ? {
          style: "form",
          explode: true
        }
      : {})
  }));
}

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
        summary: "Retrieve a previously authorized async job using a wallet-bound session."
      }
    },
    "/catalog/services": {
      get: {
        summary: "List marketplace services with live stats."
      }
    },
    "/catalog/search": {
      get: {
        summary: "Search marketplace services and executable routes with machine-readable filters."
      }
    },
    "/catalog/services/{slug}": {
      get: {
        summary: "Get one marketplace service with endpoint docs and generated usage instructions."
      }
    },
    "/catalog/routes/{provider}/{operation}": {
      get: {
        summary: "Get one executable marketplace route with machine-readable auth, pricing, and schema details."
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
    "/buyer/me/activity": {
      get: {
        summary: "List marketplace spend activity for the current website wallet session."
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
    "/provider/services/{id}/runtime-key": {
      get: {
        summary: "Get the current provider runtime key summary."
      },
      post: {
        summary: "Create or rotate the provider runtime key."
      }
    },
    "/provider/services/{id}/endpoints": {
      post: {
        summary: "Create a provider endpoint draft."
      }
    },
    "/provider/services/{id}/openapi/import": {
      post: {
        summary: "Preview provider endpoint drafts from an upstream OpenAPI document."
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
    "/provider/runtime/credits/reserve": {
      post: {
        summary: "Reserve prepaid credit from a provider runtime."
      }
    },
    "/provider/runtime/credits/{reservationId}/capture": {
      post: {
        summary: "Capture a reserved prepaid credit balance."
      }
    },
    "/provider/runtime/credits/{reservationId}/release": {
      post: {
        summary: "Release a reserved prepaid credit balance."
      }
    },
    "/provider/runtime/credits/{reservationId}/extend": {
      post: {
        summary: "Extend the expiry for a reserved prepaid credit balance."
      }
    },
    "/provider/runtime/jobs/{jobToken}/callback": {
      post: {
        summary: "Complete or fail an async provider job by marketplace callback."
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
    "/internal/provider-services/{id}/submitted": {
      get: {
        summary: "Get the submitted provider service snapshot for marketplace review."
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
    "/internal/provider-services/{id}/settlement-mode": {
      patch: {
        summary: "Change the settlement tier for a provider service."
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
    const responses: Record<string, unknown> = route.mode === "sync"
      ? {
          "200": {
            description: route.billing.type === "free" ? "Free sync response." : "Paid sync response.",
            content: {
              "application/json": {
                schema: route.responseSchemaJson
              }
            }
          }
        }
      : {
          "202": {
            description: route.billing.type === "free" ? "Free async job accepted." : "Paid async job accepted."
          }
        };

    if (route.mode === "sync" && requiresX402Payment(route)) {
      responses["202"] = {
        description: "Paid request accepted and still processing."
      };
    }

    const parameters: Array<Record<string, unknown>> = [];

    if (requiresWalletSession(route)) {
      responses["401"] = {
        description: "Wallet session bearer token required."
      };
      responses["403"] = {
        description: "Bearer token scope does not match this route."
      };

      parameters.push({
        in: "header",
        name: "Authorization",
        required: true,
        schema: { type: "string" },
        description: "Bearer wallet session token scoped to this route."
      });
    } else if (route.billing.type !== "free") {
      responses["402"] = {
        description: "Payment required.",
        headers: {
          [PAYMENT_REQUIRED_HEADER]: {
            schema: { type: "string" }
          }
        }
      };

      parameters.push(
        {
          in: "header",
          name: PAYMENT_IDENTIFIER_HEADER,
          required: true,
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
      );
    }

    if (route.method === "GET") {
      parameters.unshift(...buildOpenApiQueryParameters(route));
    }

    const operation: Record<string, unknown> = {
      summary: route.title,
      description: route.description,
      responses,
      parameters
    };

    if (route.method === "POST") {
      operation.requestBody = {
        required: true,
        content: {
          "application/json": {
            schema: route.requestSchemaJson
          }
        }
      };
    }

    paths[`/api/${route.provider}/${route.operation}`] = {
      [route.method.toLowerCase()]: operation
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
  services: PublishedCatalogService[];
  routes: MarketplaceRoute[];
}): string {
  const network = getDefaultMarketplaceNetworkConfig();
  const baseUrl = input.baseUrl ?? "http://localhost:3000";
  const lines = [
    `# ${MARKETPLACE_NAME}`,
    "",
    "Fast-only API marketplace with executable marketplace routes plus discovery-only external API listings.",
    "",
    `Base URL: ${baseUrl}`,
    `Fast network: ${network.displayName}`,
    `Settlement token: ${network.tokenSymbol}`,
    `Marketplace catalog: ${baseUrl}/catalog/services`,
    `Marketplace search: ${baseUrl}/catalog/search`,
    "Payment protocol for paid trigger routes: x402 over HTTP",
    `Payment headers for x402 routes: ${PAYMENT_REQUIRED_HEADER}, ${PAYMENT_SIGNATURE_HEADER}, ${PAYMENT_RESPONSE_HEADER}`,
    "Repeat retrieval auth: wallet challenge session with a Bearer access token scoped to the route or job resource",
    `Marketplace skill: ${baseUrl}/skill.md`,
    "",
    "## Marketplace Services"
  ];

  for (const serviceDetail of input.services.filter(isMarketplaceCatalogService)) {
    const routes = serviceDetail.endpoints.filter((endpoint) => endpoint.endpointType === "marketplace_proxy");
    const summary = buildServiceSummary({
      service: serviceDetail.service,
      endpoints: routes,
      analytics: {
        totalCalls: 0,
        revenueRaw: "0",
        successRate30d: 0,
        volume30d: []
      }
    });
    if (summary.serviceType !== "marketplace_proxy") {
      throw new Error("Expected a marketplace service summary.");
    }

    lines.push(
      `- ${serviceDetail.service.name}`,
      `  owner: ${serviceDetail.service.ownerName}`,
      `  slug: ${serviceDetail.service.slug}`,
      `  settlement: ${summary.settlementLabel}`,
      `  guarantees: ${summary.settlementDescription}`,
      `  priceRange: ${summary.priceRange}`,
      `  endpointCount: ${routes.length}`,
      `  categories: ${serviceDetail.service.categories.join(", ")}`
    );
  }

  const externalServices = input.services.filter(isExternalCatalogService);
  if (externalServices.length > 0) {
    lines.push("", "## Discovery-Only External APIs");
  }

  for (const serviceDetail of externalServices) {
    const summary = buildServiceSummary({
      service: serviceDetail.service,
      endpoints: serviceDetail.endpoints,
      analytics: {
        totalCalls: 0,
        revenueRaw: "0",
        successRate30d: 0,
        volume30d: []
      }
    });
    if (summary.serviceType !== "external_registry") {
      throw new Error("Expected an external registry summary.");
    }

    lines.push(
      `- ${serviceDetail.service.name}`,
      `  owner: ${serviceDetail.service.ownerName}`,
      `  slug: ${serviceDetail.service.slug}`,
      `  website: ${serviceDetail.service.websiteUrl ?? "not provided"}`,
      `  access: ${summary.accessModelDescription}`,
      `  endpointCount: ${summary.endpointCount}`,
      `  categories: ${serviceDetail.service.categories.join(", ")}`
    );

    for (const endpoint of serviceDetail.endpoints.filter((candidate) => candidate.endpointType === "external_registry")) {
      lines.push(
        `  - ${endpoint.method} ${endpoint.publicUrl}`,
        `    docs: ${endpoint.docsUrl}`,
        `    executableByMarketplace: false`
      );

      if (endpoint.authNotes) {
        lines.push(`    auth: ${endpoint.authNotes}`);
      }
    }
  }

  lines.push("", "## Routes");

  for (const route of input.routes) {
    lines.push(
      `- ${route.method} /api/${route.provider}/${route.operation}`,
      `  routeId: ${route.routeId}`,
      `  mode: ${route.mode}`,
      `  network: ${route.network}`,
      `  settlement: ${settlementModeLabel(route.settlementMode)}`,
      `  billing: ${route.billing.type}`,
      `  price: ${routePriceLabel(route)}`,
      `  description: ${route.description}`
    );
  }

  lines.push(
    "",
    "## Free Retrieval",
    "- GET /api/jobs/{jobToken} with Authorization: Bearer <accessToken> from a job-scoped wallet challenge session"
  );

  return lines.join("\n");
}

export function buildMarketplaceCatalog(input: {
  baseUrl?: string;
  services: PublishedCatalogService[];
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
    services: input.services.filter(isMarketplaceCatalogService).map((serviceDetail) => {
      const summary = buildServiceSummary({
        service: serviceDetail.service,
        endpoints: serviceDetail.endpoints,
        analytics: {
          totalCalls: 0,
          revenueRaw: "0",
          successRate30d: 0,
          volume30d: []
        }
      }) as MarketplaceServiceSummary;

      return {
        serviceType: "marketplace_proxy",
        executableByMarketplace: true,
        slug: serviceDetail.service.slug,
        name: serviceDetail.service.name,
        ownerName: serviceDetail.service.ownerName,
        settlementMode: summary.settlementMode,
        settlementLabel: summary.settlementLabel,
        settlementDescription: summary.settlementDescription,
        categories: serviceDetail.service.categories,
        routeIds: serviceDetail.service.routeIds
      };
    }),
    discoveryOnlyServices: input.services.filter(isExternalCatalogService).map((serviceDetail) => {
      const summary = buildServiceSummary({
        service: serviceDetail.service,
        endpoints: serviceDetail.endpoints,
        analytics: {
          totalCalls: 0,
          revenueRaw: "0",
          successRate30d: 0,
          volume30d: []
        }
      }) as ExternalRegistryServiceSummary;

      return {
        serviceType: "external_registry",
        executableByMarketplace: false,
        slug: serviceDetail.service.slug,
        name: serviceDetail.service.name,
        ownerName: serviceDetail.service.ownerName,
        websiteUrl: serviceDetail.service.websiteUrl,
        accessModelLabel: summary.accessModelLabel,
        accessModelDescription: summary.accessModelDescription,
        categories: serviceDetail.service.categories,
        endpoints: serviceDetail.endpoints
          .filter((endpoint) => endpoint.endpointType === "external_registry")
          .map((endpoint) => ({
            endpointId: endpoint.endpointVersionId,
            method: endpoint.method,
            publicUrl: endpoint.publicUrl,
            docsUrl: endpoint.docsUrl,
            authNotes: endpoint.authNotes,
            executableByMarketplace: false
          }))
      };
    }),
    routes: input.routes.map((route) => ({
      routeId: route.routeId,
      provider: route.provider,
      operation: route.operation,
      method: route.method,
      path: `/api/${route.provider}/${route.operation}`,
      mode: route.mode,
      settlementMode: route.settlementMode,
      network: route.network,
      billingType: route.billing.type,
      price: routePriceLabel(route),
      description: route.description,
      requestSchemaJson: route.requestSchemaJson,
      responseSchemaJson: route.responseSchemaJson
    }))
  };
}
