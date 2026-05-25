import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { ArchiveIsError, type ListSnapshotsResult } from "@marketplace/archive-is";

import { createArchiveIsServiceApp } from "./app.js";

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
    expect(response.body.paths["/health"]).toBeUndefined();
    expect(response.body.paths["/.well-known/fast-marketplace-verification.txt"]).toBeUndefined();
  });

  it("serves the marketplace verification token when configured", async () => {
    const app = createArchiveIsServiceApp({
      verificationToken: "verify-me"
    });

    const response = await request(app).get("/.well-known/fast-marketplace-verification.txt");

    expect(response.status).toBe(200);
    expect(response.text).toBe("verify-me");
  });
});
