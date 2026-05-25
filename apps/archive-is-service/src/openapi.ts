import type { ArchiveHost } from "@marketplace/archive-is";

export const ARCHIVE_IS_ROUTE = {
  path: "/snapshots",
  method: "POST",
  operationId: "list-snapshots",
  summary: "List archived snapshots for a URL",
  description:
    "Fetch Archive.today-compatible Memento TimeMap captures for a submitted URL and return normalized archived page links.",
  requestExample: {
    url: "https://example.com/articles/launch",
    limit: 20
  },
  responseExample: {
    originalUrl: "https://example.com/articles/launch",
    normalizedUrl: "https://example.com/articles/launch",
    sourceHost: "archive.today" satisfies ArchiveHost,
    count: 1,
    snapshots: [
      {
        originalUrl: "https://example.com/articles/launch",
        archiveUrl: "https://archive.today/20240501120000/https://example.com/articles/launch",
        capturedAt: "2024-05-01T12:00:00.000Z",
        archiveId: "20240501120000",
        sourceHost: "archive.today"
      }
    ]
  }
} as const;

export function buildArchiveIsOpenApiDocument(): Record<string, unknown> {
  return {
    openapi: "3.0.3",
    info: {
      title: "Archive.is Marketplace Provider API",
      version: "1.0.0",
      description:
        "Archive.today-compatible lookup endpoint for marketplace provider onboarding. The service returns known archived captures for a submitted URL."
    },
    servers: [{ url: "/" }],
    paths: {
      [ARCHIVE_IS_ROUTE.path]: {
        post: {
          operationId: ARCHIVE_IS_ROUTE.operationId,
          summary: ARCHIVE_IS_ROUTE.summary,
          description: ARCHIVE_IS_ROUTE.description,
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: buildSnapshotsRequestSchema(),
                example: ARCHIVE_IS_ROUTE.requestExample
              }
            }
          },
          responses: {
            "200": {
              description: "Archived snapshot list.",
              content: {
                "application/json": {
                  schema: buildSnapshotsResponseSchema(),
                  example: ARCHIVE_IS_ROUTE.responseExample
                }
              }
            },
            "400": {
              description: "Invalid request input.",
              content: {
                "application/json": {
                  schema: buildErrorSchema(),
                  example: {
                    error: "url must be a valid absolute URL.",
                    code: "invalid_input"
                  }
                }
              }
            },
            "404": {
              description: "No archived captures found.",
              content: {
                "application/json": {
                  schema: buildErrorSchema(),
                  example: {
                    error: "No archived captures found for the requested URL.",
                    code: "no_captures"
                  }
                }
              }
            },
            "429": {
              description: "Archive.today rate limited the request.",
              content: {
                "application/json": {
                  schema: buildErrorSchema(),
                  example: {
                    error: "Archive.today rate limited the TimeMap request.",
                    code: "upstream_rate_limited"
                  }
                }
              }
            },
            "502": {
              description: "Archive.today upstream failure.",
              content: {
                "application/json": {
                  schema: buildErrorSchema(),
                  example: {
                    error: "Archive.today TimeMap request failed.",
                    code: "upstream_fetch_failed"
                  }
                }
              }
            },
            "504": {
              description: "Archive.today request timed out.",
              content: {
                "application/json": {
                  schema: buildErrorSchema(),
                  example: {
                    error: "Archive.today TimeMap request timed out.",
                    code: "upstream_timeout"
                  }
                }
              }
            }
          }
        }
      }
    }
  };
}

export function buildSnapshotsRequestSchema(): Record<string, unknown> {
  return {
    type: "object",
    required: ["url"],
    properties: {
      url: {
        type: "string",
        format: "uri"
      },
      limit: {
        type: "integer",
        minimum: 1,
        maximum: 100,
        default: 20
      },
      from: {
        type: "string",
        format: "date-time"
      },
      to: {
        type: "string",
        format: "date-time"
      },
      archiveHost: {
        type: "string",
        enum: ["archive.today", "archive.is", "archive.ph"],
        default: "archive.today"
      }
    },
    additionalProperties: false
  };
}

export function buildSnapshotsResponseSchema(): Record<string, unknown> {
  return {
    type: "object",
    required: ["originalUrl", "normalizedUrl", "sourceHost", "count", "snapshots"],
    properties: {
      originalUrl: { type: "string", format: "uri" },
      normalizedUrl: { type: "string", format: "uri" },
      sourceHost: { type: "string" },
      count: { type: "integer", minimum: 0 },
      snapshots: {
        type: "array",
        items: {
          type: "object",
          required: ["originalUrl", "archiveUrl", "capturedAt", "archiveId", "sourceHost"],
          properties: {
            originalUrl: { type: "string", format: "uri" },
            archiveUrl: { type: "string", format: "uri" },
            capturedAt: { type: "string", format: "date-time" },
            archiveId: {
              anyOf: [
                { type: "string" },
                { type: "null" }
              ]
            },
            sourceHost: { type: "string" }
          },
          additionalProperties: false
        }
      }
    },
    additionalProperties: false
  };
}

function buildErrorSchema(): Record<string, unknown> {
  return {
    type: "object",
    required: ["error", "code"],
    properties: {
      error: { type: "string" },
      code: { type: "string" }
    },
    additionalProperties: false
  };
}
