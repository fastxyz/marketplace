import type { ApifyProxyRouteDefinition } from "./operations.js";

export interface BuildApifyOpenApiDocumentInput {
  actorId: string;
  serviceName: string;
  serviceDescription: string;
  routes: ApifyProxyRouteDefinition[];
}

export function buildApifyOpenApiDocument(input: BuildApifyOpenApiDocumentInput): Record<string, unknown> {
  return {
    openapi: "3.0.3",
    info: {
      title: `${input.serviceName} Provider API`,
      version: "1.0.0",
      description: input.serviceDescription
    },
    servers: [
      {
        url: "/"
      }
    ],
    paths: Object.fromEntries(
      input.routes.map((route) => [
        route.path,
        {
          post: {
            operationId: route.operationId,
            summary: route.summary,
            description: route.description,
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  schema: route.requestSchemaJson,
                  example: route.requestExample
                }
              }
            },
            responses: {
              "202": {
                description: "Async run accepted.",
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      required: ["status", "providerJobId"],
                      properties: {
                        status: {
                          type: "string",
                          enum: ["accepted"]
                        },
                        providerJobId: {
                          type: "string"
                        },
                        pollAfterMs: {
                          type: "integer"
                        },
                        providerState: {
                          type: "object",
                          additionalProperties: true
                        }
                      },
                      additionalProperties: false
                    },
                    example: {
                      status: "accepted",
                      providerJobId: "apify_run_123",
                      pollAfterMs: 5000,
                      providerState: {
                        actorId: input.actorId,
                        datasetId: "dataset_123",
                        keyValueStoreId: "store_123"
                      }
                    }
                  }
                }
              },
              "502": {
                description: "Upstream Apify request failure.",
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      required: ["error"],
                      properties: {
                        error: {
                          type: "string"
                        }
                      },
                      additionalProperties: false
                    }
                  }
                }
              }
            }
          }
        }
      ])
    )
  };
}
