import { describe, expect, it } from "vitest";

import { parseOpenApiImportDocument } from "./openapi.js";

describe("parseOpenApiImportDocument", () => {
  it("extracts POST and safe GET operations, resolves local refs, and infers auth", () => {
    const preview = parseOpenApiImportDocument({
      documentUrl: "https://provider.example.com/openapi.json",
      document: {
        openapi: "3.0.3",
        info: {
          title: "Provider API",
          version: "1.2.3"
        },
        servers: [
          {
            url: "https://api.provider.example.com/v1"
          }
        ],
        components: {
          securitySchemes: {
            bearerAuth: {
              type: "http",
              scheme: "bearer"
            }
          },
          schemas: {
            SearchRequest: {
              type: "object",
              properties: {
                query: {
                  type: "string"
                }
              },
              required: ["query"],
              additionalProperties: false
            },
            SearchResponse: {
              type: "object",
              properties: {
                query: {
                  type: "string"
                },
                items: {
                  type: "array",
                  items: {
                    type: "string"
                  }
                }
              },
              required: ["query", "items"],
              additionalProperties: false
            }
          }
        },
        security: [{ bearerAuth: [] }],
        paths: {
          "/search": {
            post: {
              operationId: "CreateSearch",
              summary: "Create search",
              description: "Run a provider search.",
              requestBody: {
                content: {
                  "application/json": {
                    schema: {
                      $ref: "#/components/schemas/SearchRequest"
                    }
                  }
                }
              },
              responses: {
                "200": {
                  content: {
                    "application/json": {
                      schema: {
                        $ref: "#/components/schemas/SearchResponse"
                      }
                    }
                  }
                }
              }
            }
          },
          "/health": {
            get: {
              summary: "Health"
            }
          }
        }
      }
    });

    expect(preview.title).toBe("Provider API");
    expect(preview.version).toBe("1.2.3");
    expect(preview.warnings).toEqual([]);
    expect(preview.endpoints).toHaveLength(2);

    const endpoint = preview.endpoints[0];
    expect(endpoint).toMatchObject({
      operation: "create-search",
      method: "POST",
      title: "Create search",
      description: "Run a provider search.",
      upstreamBaseUrl: "https://api.provider.example.com/v1",
      upstreamPath: "/search",
      upstreamAuthMode: "bearer",
      upstreamAuthHeaderName: null
    });
    expect(endpoint.requestSchemaJson).toMatchObject({
      type: "object",
      required: ["query"]
    });
    expect(endpoint.responseSchemaJson).toMatchObject({
      type: "object",
      required: ["query", "items"]
    });
    expect(endpoint.requestExample).toEqual({
      query: "string"
    });
    expect(endpoint.responseExample).toEqual({
      query: "string",
      items: ["string"]
    });
    expect(endpoint.warnings).toContain("Add the upstream secret before creating this draft.");

    const getEndpoint = preview.endpoints[1];
    expect(getEndpoint).toMatchObject({
      operation: "health",
      method: "GET",
      title: "Health",
      upstreamBaseUrl: "https://api.provider.example.com/v1",
      upstreamPath: "/health",
      upstreamAuthMode: "bearer"
    });
    expect(getEndpoint.requestSchemaJson).toEqual({
      type: "object",
      properties: {},
      additionalProperties: false
    });
    expect(getEndpoint.requestExample).toEqual({});
    expect(getEndpoint.warnings).toContain("Add the upstream secret before creating this draft.");
  });

  it("ignores default responses when no explicit 2xx success schema exists", () => {
    const preview = parseOpenApiImportDocument({
      documentUrl: "https://provider.example.com/openapi.json",
      document: {
        openapi: "3.0.3",
        paths: {
          "/search": {
            post: {
              responses: {
                default: {
                  content: {
                    "application/json": {
                      schema: {
                        type: "object",
                        properties: {
                          error: {
                            type: "string"
                          }
                        },
                        required: ["error"],
                        additionalProperties: false
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    });

    const endpoint = preview.endpoints[0];
    expect(endpoint.responseSchemaJson).toEqual({
      type: "object",
      additionalProperties: true
    });
    expect(endpoint.responseExample).toEqual({});
    expect(endpoint.warnings).toContain(
      "No explicit 2xx success response schema was declared. The OpenAPI default response was ignored because it is usually an error shape."
    );
  });

  it("imports auth as none when unauthenticated access is explicitly allowed", () => {
    const preview = parseOpenApiImportDocument({
      documentUrl: "https://provider.example.com/openapi.json",
      document: {
        openapi: "3.0.3",
        components: {
          securitySchemes: {
            bearerAuth: {
              type: "http",
              scheme: "bearer"
            }
          }
        },
        paths: {
          "/search": {
            post: {
              security: [{ bearerAuth: [] }, {}],
              responses: {
                "200": {
                  content: {
                    "application/json": {
                      schema: {
                        type: "object"
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    });

    const endpoint = preview.endpoints[0];
    expect(endpoint.upstreamAuthMode).toBe("none");
    expect(endpoint.upstreamAuthHeaderName).toBeNull();
    expect(endpoint.warnings).toContain(
      "Security requirements allow unauthenticated access. Imported auth settings as none."
    );
    expect(endpoint.warnings).not.toContain("Add the upstream secret before creating this draft.");
  });

  it("does not guess between multiple alternative auth schemes", () => {
    const preview = parseOpenApiImportDocument({
      documentUrl: "https://provider.example.com/openapi.json",
      document: {
        openapi: "3.0.3",
        components: {
          securitySchemes: {
            bearerAuth: {
              type: "http",
              scheme: "bearer"
            },
            apiKeyAuth: {
              type: "apiKey",
              in: "header",
              name: "X-API-Key"
            }
          }
        },
        paths: {
          "/search": {
            post: {
              security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
              responses: {
                "200": {
                  content: {
                    "application/json": {
                      schema: {
                        type: "object"
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    });

    const endpoint = preview.endpoints[0];
    expect(endpoint.upstreamAuthMode).toBe("none");
    expect(endpoint.warnings).toContain("Multiple alternative auth schemes were declared. Review auth settings manually.");
  });

  it("skips unsupported GET operations with path params, headers, and request bodies", () => {
    const preview = parseOpenApiImportDocument({
      documentUrl: "https://provider.example.com/openapi.json",
      document: {
        openapi: "3.0.3",
        paths: {
          "/signals/{id}": {
            get: {
              parameters: [
                {
                  name: "id",
                  in: "path",
                  required: true,
                  schema: {
                    type: "string"
                  }
                }
              ],
              responses: {
                "200": {
                  content: {
                    "application/json": {
                      schema: {
                        type: "object"
                      }
                    }
                  }
                }
              }
            }
          },
          "/health": {
            get: {
              requestBody: {
                content: {
                  "application/json": {
                    schema: {
                      type: "object"
                    }
                  }
                }
              },
              responses: {
                "200": {
                  content: {
                    "application/json": {
                      schema: {
                        type: "object"
                      }
                    }
                  }
                }
              }
            }
          },
          "/search": {
            get: {
              parameters: [
                {
                  name: "X-Trace",
                  in: "header",
                  schema: {
                    type: "string"
                  }
                }
              ],
              responses: {
                "200": {
                  content: {
                    "application/json": {
                      schema: {
                        type: "object"
                      }
                    }
                  }
                }
              }
            }
          },
          "/tags": {
            get: {
              parameters: [
                {
                  name: "tags",
                  in: "query",
                  style: "pipeDelimited",
                  schema: {
                    type: "array",
                    items: {
                      type: "string"
                    }
                  }
                }
              ],
              responses: {
                "200": {
                  content: {
                    "application/json": {
                      schema: {
                        type: "object"
                      }
                    }
                  }
                }
              }
            }
          },
          "/list": {
            get: {
              parameters: [
                {
                  name: "ids",
                  in: "query",
                  explode: false,
                  schema: {
                    type: "array",
                    items: {
                      type: "string"
                    }
                  }
                }
              ],
              responses: {
                "200": {
                  content: {
                    "application/json": {
                      schema: {
                        type: "object"
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    });

    expect(preview.endpoints).toEqual([]);
    expect(preview.warnings).toContain("Skipped GET /signals/{id}: path parameters are not supported for imported GET routes.");
    expect(preview.warnings).toContain("Skipped GET /health: GET request bodies are not supported.");
    expect(preview.warnings).toContain("Skipped GET /search: only query parameters are supported for imported GET routes.");
    expect(preview.warnings).toContain("Skipped GET /tags: only form-style query parameters are supported for imported GET routes.");
    expect(preview.warnings).toContain("Skipped GET /list: only exploded query parameters are supported for imported GET routes.");
    expect(preview.warnings).toContain("No importable POST or safe GET operations were found in this document.");
  });

  it("accepts scalar form query params even when explode is false", () => {
    const preview = parseOpenApiImportDocument({
      documentUrl: "https://provider.example.com/openapi.json",
      document: {
        openapi: "3.0.3",
        paths: {
          "/status": {
            get: {
              parameters: [
                {
                  name: "verbose",
                  in: "query",
                  explode: false,
                  schema: {
                    type: "boolean"
                  }
                }
              ],
              responses: {
                "200": {
                  content: {
                    "application/json": {
                      schema: {
                        type: "object"
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    });

    expect(preview.warnings).toEqual([]);
    expect(preview.endpoints).toHaveLength(1);
    expect(preview.endpoints[0]).toMatchObject({
      method: "GET",
      upstreamPath: "/status",
      requestSchemaJson: {
        type: "object",
        properties: {
          verbose: {
            type: "boolean"
          }
        },
        additionalProperties: false
      }
    });
  });
});
