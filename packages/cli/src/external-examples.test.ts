import { describe, expect, it } from "vitest";

import { inferExternalServiceExamples } from "./external-examples.js";

describe("inferExternalServiceExamples", () => {
  it("uses OpenAPI request schemas and generic async guidance for tokenized trigger routes", async () => {
    const responses = new Map<string, Response>([
      [
        "https://stablesocial.dev/openapi.json",
        new Response(JSON.stringify({
          openapi: "3.1.0",
          info: {
            title: "StableSocial",
            "x-guidance": "All endpoints are POST requests that accept JSON bodies. All return 202 with a job token."
          },
          paths: {
            "/api/reddit/comment": {
              post: {
                requestBody: {
                  content: {
                    "application/json": {
                      schema: {
                        type: "object",
                        properties: {
                          comment_id: { type: "string" }
                        },
                        required: ["comment_id"]
                      }
                    }
                  }
                },
                responses: {
                  "202": {
                    description: "Accepted"
                  }
                }
              }
            }
          }
        }), {
          headers: { "content-type": "application/json" }
        })
      ],
      [
        "https://stablesocial.dev/llms.txt",
        new Response("# StableSocial\nReturns a signed JWT token.", {
          headers: { "content-type": "text/plain" }
        })
      ]
    ]);

    const inferred = await inferExternalServiceExamples({
      websiteUrl: "https://stablesocial.dev",
      endpoints: [
        {
          endpointId: "endpoint_1",
          title: "Reddit comment",
          description: "Get Reddit comment details.",
          method: "POST",
          publicUrl: "https://stablesocial.dev/api/reddit/comment",
          docsUrl: "https://stablesocial.dev/llms.txt",
          requestExample: {},
          responseExample: {}
        }
      ],
      deps: {
        fetchImpl: async (url) => responses.get(String(url)) ?? new Response("not found", { status: 404 })
      }
    });

    expect(inferred[0]?.requestExample).toEqual({ comment_id: "string" });
    expect(inferred[0]?.responseExample).toEqual({ token: "eyJ..." });
    expect(inferred[0]?.requestSource).toBe("openapi");
    expect(inferred[0]?.responseSource).toBe("guidance-generic");
  });

  it("extracts exact request and response examples from endpoint-specific llms sections", async () => {
    const llms = [
      "# StableUpload API",
      "## POST /api/site",
      "",
      '**Input:** `{ "filename": "my-site.zip", "tier": "100mb" }`',
      "",
      '**Output:** `{ "uploadId": "k7gm3nqp2", "uploadUrl": "https://upload.example.com", "expiresAt": "2026-01-01T00:00:00Z", "maxSize": 104857600, "curlExample": "curl ..." }`'
    ].join("\n");

    const responses = new Map<string, Response>([
      ["https://stableupload.dev/openapi.json", new Response("not found", { status: 404 })],
      ["https://stableupload.dev/llms.txt", new Response(llms, { headers: { "content-type": "text/plain" } })]
    ]);

    const inferred = await inferExternalServiceExamples({
      websiteUrl: "https://stableupload.dev",
      endpoints: [
        {
          endpointId: "endpoint_1",
          title: "Buy site upload slot",
          description: "Buy a site upload slot.",
          method: "POST",
          publicUrl: "https://stableupload.dev/api/site",
          docsUrl: "https://stableupload.dev/llms.txt",
          requestExample: {},
          responseExample: {}
        }
      ],
      deps: {
        fetchImpl: async (url) => responses.get(String(url)) ?? new Response("not found", { status: 404 })
      }
    });

    expect(inferred[0]?.requestExample).toEqual({
      filename: "my-site.zip",
      tier: "100mb"
    });
    expect(inferred[0]?.responseExample).toEqual({
      uploadId: "k7gm3nqp2",
      uploadUrl: "https://upload.example.com",
      expiresAt: "2026-01-01T00:00:00Z",
      maxSize: 104857600,
      curlExample: "curl ..."
    });
    expect(inferred[0]?.requestSource).toBe("guidance");
    expect(inferred[0]?.responseSource).toBe("guidance");
  });

  it("parses query-param labels and infers path-parameter examples for download-style GET routes", async () => {
    const llms = [
      "# StableUpload API",
      "## GET /api/uploads (SIWX auth)",
      "",
      "**Query params:** `limit` (default 50, max 100), `cursor` (from previous `nextCursor`)",
      "",
      '**Output:** `{ "uploads": [{ "uploadId": "k7gm3nqp2" }], "nextCursor": "abc123" }`',
      "",
      "## GET /api/download/:uploadId (SIWX auth)",
      "",
      "Get details for a specific upload including its public URL."
    ].join("\n");

    const responses = new Map<string, Response>([
      ["https://stableupload.dev/openapi.json", new Response("not found", { status: 404 })],
      ["https://stableupload.dev/llms.txt", new Response(llms, { headers: { "content-type": "text/plain" } })]
    ]);

    const inferred = await inferExternalServiceExamples({
      websiteUrl: "https://stableupload.dev",
      endpoints: [
        {
          endpointId: "endpoint_uploads",
          title: "List uploads",
          description: "List uploads.",
          method: "GET",
          publicUrl: "https://stableupload.dev/api/uploads",
          docsUrl: "https://stableupload.dev/llms.txt",
          requestExample: {},
          responseExample: {}
        },
        {
          endpointId: "endpoint_download",
          title: "Get upload details",
          description: "Get upload details by ID.",
          method: "GET",
          publicUrl: "https://stableupload.dev/api/download/:uploadId",
          docsUrl: "https://stableupload.dev/llms.txt",
          requestExample: {},
          responseExample: {}
        }
      ],
      deps: {
        fetchImpl: async (url) => responses.get(String(url)) ?? new Response("not found", { status: 404 })
      }
    });

    expect(inferred[0]?.requestExample).toEqual({ limit: "50", cursor: "abc123" });
    expect(inferred[0]?.responseExample).toEqual({
      uploads: [{ uploadId: "k7gm3nqp2" }],
      nextCursor: "abc123"
    });
    expect(inferred[1]?.requestExample).toEqual({ uploadId: "k7gm3nqp2" });
    expect(inferred[1]?.responseExample).toEqual({
      uploadId: "k7gm3nqp2",
      publicUrl: "https://stableupload.dev/u/k7gm3nqp2/file.png",
      expiresAt: "2026-01-01T00:00:00Z"
    });
  });

  it("parses GET query examples and sanitizes bool placeholders in returns lines", async () => {
    const llms = [
      "### GET /api/subdomain/status?subdomain=yourname",
      "- Returns: { \"subdomain\": \"string\", \"ownerWallet\": \"string\", \"dnsVerified\": bool, \"sesVerified\": bool, \"signerCount\": number, \"signers\": [\"0x...\"] }"
    ].join("\n");

    const responses = new Map<string, Response>([
      ["https://stableemail.dev/openapi.json", new Response("not found", { status: 404 })],
      ["https://stableemail.dev/llms.txt", new Response(llms, { headers: { "content-type": "text/plain" } })]
    ]);

    const inferred = await inferExternalServiceExamples({
      websiteUrl: "https://stableemail.dev",
      endpoints: [
        {
          endpointId: "endpoint_1",
          title: "Check subdomain status",
          description: "Check subdomain status.",
          method: "GET",
          publicUrl: "https://stableemail.dev/api/subdomain/status?subdomain=yourname",
          docsUrl: "https://stableemail.dev/llms.txt",
          requestExample: {},
          responseExample: {}
        }
      ],
      deps: {
        fetchImpl: async (url) => responses.get(String(url)) ?? new Response("not found", { status: 404 })
      }
    });

    expect(inferred[0]?.requestExample).toEqual({ subdomain: "yourname" });
    expect(inferred[0]?.responseExample).toEqual({
      subdomain: "string",
      ownerWallet: "string",
      dnsVerified: true,
      sesVerified: true,
      signerCount: 0,
      signers: ["0x..."]
    });
  });

  it("falls back to success responses for management endpoints and linkedin_url requests for linkedin scrape routes", async () => {
    const stableEmailLlms = [
      "### POST /api/subdomain/signers — Manage authorized wallets",
      '- Body: { "action": "add", "subdomain": "yourname", "walletAddress": "0x..." }'
    ].join("\n");
    const stableEnrichLlms = "Clado linkedin scrape docs are not yet documented here.";

    const responses = new Map<string, Response>([
      [
        "https://stableemail.dev/openapi.json",
        new Response(JSON.stringify({
          openapi: "3.1.0",
          paths: {
            "/api/subdomain/signers": {
              post: {
                requestBody: {
                  content: {
                    "application/json": {
                      schema: {
                        type: "object",
                        properties: {
                          action: { type: "string", enum: ["add", "remove"] },
                          subdomain: { type: "string" },
                          walletAddress: { type: "string" }
                        },
                        required: ["action", "subdomain", "walletAddress"]
                      }
                    }
                  }
                },
                responses: {
                  "200": { description: "ok" }
                }
              }
            }
          }
        }), { headers: { "content-type": "application/json" } })
      ],
      ["https://stableemail.dev/llms.txt", new Response(stableEmailLlms, { headers: { "content-type": "text/plain" } })],
      ["https://stableenrich.dev/openapi.json", new Response(JSON.stringify({ openapi: "3.1.0", paths: {} }), { headers: { "content-type": "application/json" } })],
      ["https://stableenrich.dev/llms.txt", new Response(stableEnrichLlms, { headers: { "content-type": "text/plain" } })]
    ]);

    const [emailInference] = await inferExternalServiceExamples({
      websiteUrl: "https://stableemail.dev",
      endpoints: [
        {
          endpointId: "endpoint_email",
          title: "Manage authorized wallets",
          description: "Manage signers.",
          method: "POST",
          publicUrl: "https://stableemail.dev/api/subdomain/signers",
          docsUrl: "https://stableemail.dev/llms.txt",
          requestExample: {},
          responseExample: {}
        }
      ],
      deps: {
        fetchImpl: async (url) => responses.get(String(url)) ?? new Response("not found", { status: 404 })
      }
    });

    const [cladoInference] = await inferExternalServiceExamples({
      websiteUrl: "https://stableenrich.dev",
      endpoints: [
        {
          endpointId: "endpoint_clado",
          title: "Scrape full LinkedIn profile data",
          description: "Scrape LinkedIn profile data.",
          method: "POST",
          publicUrl: "https://stableenrich.dev/api/clado/linkedin-scrape",
          docsUrl: "https://stableenrich.dev/llms.txt",
          requestExample: {},
          responseExample: {}
        }
      ],
      deps: {
        fetchImpl: async (url) => responses.get(String(url)) ?? new Response("not found", { status: 404 })
      }
    });

    expect(emailInference?.responseExample).toEqual({ success: true });
    expect(emailInference?.responseSource).toBe("guidance-generic");
    expect(cladoInference?.requestExample).toEqual({
      linkedin_url: "https://www.linkedin.com/in/example"
    });
    expect(cladoInference?.responseExample).toEqual({
      linkedin_url: "https://www.linkedin.com/in/example",
      full_name: "Jane Example",
      headline: "Product Manager at Example Co",
      location: "San Francisco, CA"
    });
    expect(cladoInference?.requestSource).toBe("path-heuristic");
    expect(cladoInference?.responseSource).toBe("guidance-generic");
  });

  it("fills upload and job examples from workflow-style docs when OpenAPI responses are incomplete", async () => {
    const llms = [
      "# StableStudio API",
      "",
      "**Step 1: Get upload token**",
      "```",
      "POST /api/upload",
      "",
      "{\"filename\": \"image.png\", \"contentType\": \"image/png\"}",
      "```",
      "",
      "Returns:",
      "```json",
      "{\"uploadId\": \"uuid\", \"clientToken\": \"vercel_blob_...\", \"pathname\": \"uploads/uuid/image.png\", \"expiresAt\": \"...\"}",
      "```",
      "",
      "**Step 3: Confirm upload**",
      "```",
      "POST /api/upload/confirm",
      "",
      "{\"uploadId\": \"uuid\", \"blobUrl\": \"https://....blob.vercel-storage.com/...\"}",
      "```",
      "",
      "Returns `{\"success\": true, \"upload\": {\"id\": \"...\", \"blobUrl\": \"...\"}}`.",
      "",
      "**Routes:**",
      "- `GET /api/jobs/{jobId}` - Get job status",
      "- `GET /api/jobs` - List jobs (`?limit=20&status=complete`)",
      "",
      "**Response:**",
      "```json",
      "{\"status\": \"complete\", \"result\": {\"imageUrl\": \"https://...\"}}",
      "```"
    ].join("\n");

    const responses = new Map<string, Response>([
      [
        "https://stablestudio.dev/openapi.json",
        new Response(JSON.stringify({
          openapi: "3.1.0",
          info: { title: "StableStudio" },
          paths: {
            "/api/upload": {
              post: {
                requestBody: {
                  content: {
                    "application/json": {
                      schema: {
                        type: "object",
                        properties: {
                          filename: { type: "string" },
                          contentType: { type: "string" }
                        },
                        required: ["filename", "contentType"]
                      }
                    }
                  }
                },
                responses: { "200": { description: "ok" } }
              }
            },
            "/api/upload/confirm": {
              post: {
                responses: { "200": { description: "ok" } }
              }
            },
            "/api/jobs": {
              get: {
                responses: { "200": { description: "ok" } }
              }
            },
            "/api/jobs/{jobId}": {
              get: {
                responses: { "200": { description: "ok" } }
              }
            }
          }
        }), { headers: { "content-type": "application/json" } })
      ],
      ["https://stablestudio.dev/llms.txt", new Response(llms, { headers: { "content-type": "text/plain" } })]
    ]);

    const inferred = await inferExternalServiceExamples({
      websiteUrl: "https://stablestudio.dev",
      endpoints: [
        {
          endpointId: "endpoint_upload",
          title: "Upload image",
          description: "Upload image.",
          method: "POST",
          publicUrl: "https://stablestudio.dev/api/upload",
          docsUrl: "https://stablestudio.dev/llms.txt",
          requestExample: {},
          responseExample: {}
        },
        {
          endpointId: "endpoint_confirm",
          title: "Confirm upload",
          description: "Confirm upload.",
          method: "POST",
          publicUrl: "https://stablestudio.dev/api/upload/confirm",
          docsUrl: "https://stablestudio.dev/llms.txt",
          requestExample: {},
          responseExample: {}
        },
        {
          endpointId: "endpoint_jobs",
          title: "List jobs",
          description: "List jobs.",
          method: "GET",
          publicUrl: "https://stablestudio.dev/api/jobs",
          docsUrl: "https://stablestudio.dev/llms.txt",
          requestExample: {},
          responseExample: {}
        },
        {
          endpointId: "endpoint_job",
          title: "Get job status",
          description: "Get job status.",
          method: "GET",
          publicUrl: "https://stablestudio.dev/api/jobs/{jobId}",
          docsUrl: "https://stablestudio.dev/llms.txt",
          requestExample: {},
          responseExample: {}
        }
      ],
      deps: {
        fetchImpl: async (url) => responses.get(String(url)) ?? new Response("not found", { status: 404 })
      }
    });

    expect(inferred[0]?.requestExample).toEqual({
      filename: "string",
      contentType: "string"
    });
    expect(inferred[0]?.responseExample).toEqual({
      uploadId: "uuid",
      clientToken: "vercel_blob_...",
      pathname: "uploads/uuid/image.png",
      expiresAt: "2026-01-01T00:00:00Z"
    });
    expect(inferred[1]?.requestExample).toEqual({
      uploadId: "uuid",
      blobUrl: "https://blob.vercel-storage.com/example.png"
    });
    expect(inferred[1]?.responseExample).toEqual({
      success: true,
      upload: {
        id: "uuid",
        blobUrl: "https://blob.vercel-storage.com/example.png"
      }
    });
    expect(inferred[2]?.requestExample).toEqual({
      limit: "20",
      status: "complete"
    });
    expect(inferred[3]?.requestExample).toEqual({
      jobId: "job_123"
    });
    expect(inferred[3]?.responseExample).toEqual({
      status: "complete",
      result: { imageUrl: "https://..." }
    });
  });
});
