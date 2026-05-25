import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { ArchiveIsError, type ListSnapshotsResult } from "@marketplace/archive-is";

import { createArchiveIsServiceApp, normalizeArchiveIsTimeoutMs } from "./app.js";
import { buildSnapshotsRequestSchema, buildSnapshotsResponseSchema } from "./openapi.js";

const appDir = dirname(fileURLToPath(import.meta.url));

function buildResult(): ListSnapshotsResult {
  return {
    originalUrl: "https://example.com/articles/launch",
    normalizedUrl: "https://example.com/articles/launch",
    sourceHost: "archive.today",
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
  };
}

describe("archive-is service", () => {
  it("lists snapshots through the configured SDK implementation", async () => {
    const listSnapshots = vi.fn().mockResolvedValue(buildResult());
    const app = createArchiveIsServiceApp({
      archiveHost: "archive.ph",
      listSnapshots
    });

    const response = await request(app)
      .post("/snapshots")
      .send({
        url: "https://example.com/articles/launch",
        limit: 1
      });

    expect(response.status).toBe(200);
    expect(response.body).toEqual(buildResult());
    expect(listSnapshots).toHaveBeenCalledWith({
      url: "https://example.com/articles/launch",
      limit: 1,
      from: undefined,
      to: undefined,
      archiveHost: "archive.ph"
    });
  });

  it("allows per-request archive host overrides", async () => {
    const listSnapshots = vi.fn().mockResolvedValue(buildResult());
    const app = createArchiveIsServiceApp({
      archiveHost: "archive.today",
      listSnapshots
    });

    await request(app)
      .post("/snapshots")
      .send({
        url: "https://example.com/articles/launch",
        archiveHost: "archive.is"
      });

    expect(listSnapshots).toHaveBeenCalledWith(expect.objectContaining({
      archiveHost: "archive.is"
    }));
  });

  it("enables snapshot validation in the production SDK path", async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(
        '<https://example.com/articles/launch>; rel="original", <http://archive.md/20240501120000/https://example.com/articles/launch>; rel="memento"; datetime="Wed, 01 May 2024 12:00:00 GMT"',
        {
          status: 200,
          headers: {
            "content-type": "application/link-format"
          }
        }
      ))
      .mockResolvedValueOnce(new Response("<html><article>Archived article content</article></html>", {
        status: 200
      }));
    const originalFetch = globalThis.fetch;
    vi.stubGlobal("fetch", fetchImpl);

    try {
      const app = createArchiveIsServiceApp({
        archiveHost: "archive.today"
      });

      const response = await request(app)
        .post("/snapshots")
        .send({
          url: "https://example.com/articles/launch",
          limit: 1
        });

      expect(response.status).toBe(200);
      expect(response.body.snapshots).toEqual([
        expect.objectContaining({
          archiveUrl: "http://archive.md/20240501120000/https://example.com/articles/launch",
          validation: {
            status: "usable"
          }
        })
      ]);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    } finally {
      vi.stubGlobal("fetch", originalFetch);
    }
  });

  it("maps invalid input to 400", async () => {
    const app = createArchiveIsServiceApp();

    const response = await request(app)
      .post("/snapshots")
      .send({ url: "ftp://example.com/file" });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      error: "url must use http or https.",
      code: "invalid_input"
    });
  });

  it("rejects request bodies that do not match the OpenAPI schema", async () => {
    const listSnapshots = vi.fn().mockResolvedValue(buildResult());
    const app = createArchiveIsServiceApp({
      listSnapshots
    });

    const response = await request(app)
      .post("/snapshots")
      .send({
        url: "https://example.com",
        unexpected: true
      });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      error: "Unknown request field: unexpected.",
      code: "invalid_input"
    });
    expect(listSnapshots).not.toHaveBeenCalled();
  });

  it.each([
    ["no_captures", 404],
    ["upstream_rate_limited", 429],
    ["upstream_timeout", 504],
    ["upstream_fetch_failed", 502],
    ["upstream_http_error", 502],
    ["parse_failure", 502]
  ] as const)("maps %s errors to HTTP %i", async (code, statusCode) => {
    const app = createArchiveIsServiceApp({
      listSnapshots: async () => {
        throw new ArchiveIsError("mapped error", {
          code,
          statusCode
        });
      }
    });

    const response = await request(app)
      .post("/snapshots")
      .send({ url: "https://example.com" });

    expect(response.status).toBe(statusCode);
    expect(response.body).toEqual({
      error: "mapped error",
      code
    });
  });

  it("reports service health", async () => {
    const app = createArchiveIsServiceApp({
      archiveHost: "archive.is",
      timeoutMs: 7500
    });

    const response = await request(app).get("/health");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      ok: true,
      archiveHost: "archive.is",
      timeoutMs: 7500
    });
  });

  it("serves a provider-facing openapi.json document", async () => {
    const app = createArchiveIsServiceApp();

    const response = await request(app).get("/openapi.json");

    expect(response.status).toBe(200);
    expect(response.body.openapi).toBe("3.0.3");
    expect(response.body.servers).toEqual([{ url: "/" }]);
    expect(Object.keys(response.body.paths)).toEqual(["/snapshots"]);
    expect(response.body.paths["/snapshots"].post.operationId).toBe("list-snapshots");
    expect(response.body.paths["/snapshots"].post.responses["200"].content["application/json"].schema.properties.snapshots.items.required)
      .toContain("validation");
    expect(response.body.paths["/health"]).toBeUndefined();
    expect(response.body.paths["/.well-known/fast-marketplace-verification.txt"]).toBeUndefined();
  });

  it("keeps the provider spec template aligned with the OpenAPI schemas", () => {
    const providerSpec = JSON.parse(readFileSync(join(appDir, "../provider-spec.mainnet.template.json"), "utf8"));
    const endpoint = providerSpec.endpoints[0];

    expect(endpoint.requestSchemaJson).toEqual(buildSnapshotsRequestSchema());
    expect(endpoint.responseSchemaJson).toEqual(buildSnapshotsResponseSchema());
    expect(endpoint.responseExample.snapshots[0].validation).toEqual({
      status: "usable"
    });
  });

  it("serves the marketplace verification token when configured", async () => {
    const app = createArchiveIsServiceApp({
      verificationToken: "verify-me"
    });

    const response = await request(app).get("/.well-known/fast-marketplace-verification.txt");

    expect(response.status).toBe(200);
    expect(response.text).toBe("verify-me");
  });

  it("normalizes timeout environment values before service startup", () => {
    expect(normalizeArchiveIsTimeoutMs(undefined)).toBe(10_000);
    expect(normalizeArchiveIsTimeoutMs("")).toBe(10_000);
    expect(normalizeArchiveIsTimeoutMs("7500")).toBe(7500);

    expect(() => normalizeArchiveIsTimeoutMs("0")).toThrow("ARCHIVE_IS_TIMEOUT_MS must be a positive integer.");
    expect(() => normalizeArchiveIsTimeoutMs("abc")).toThrow("ARCHIVE_IS_TIMEOUT_MS must be a positive integer.");
    expect(() => normalizeArchiveIsTimeoutMs("1.5")).toThrow("ARCHIVE_IS_TIMEOUT_MS must be a positive integer.");
  });
});
