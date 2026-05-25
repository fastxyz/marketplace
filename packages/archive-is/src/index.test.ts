import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import {
  ArchiveIsError,
  buildTimeMapUrl,
  listSnapshots,
  parseLinkFormat,
  parseTimeMap
} from "./index.js";

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), "../fixtures");

function readFixture(name: string): string {
  return readFileSync(join(fixtureDir, name), "utf8");
}

describe("archive-is sdk", () => {
  it("constructs Archive.today TimeMap URLs while preserving query and fragment boundaries", () => {
    expect(buildTimeMapUrl({
      archiveHost: "archive.today",
      url: "https://example.com/path?q=fast archive#section"
    })).toBe("https://archive.today/timemap/https://example.com/path%3Fq=fast%20archive%23section");
  });

  it("parses Memento link-format entries without splitting datetimes at commas", () => {
    const entries = parseLinkFormat(readFixture("timemap-link-format.txt"));

    expect(entries).toHaveLength(6);
    expect(entries[3]?.params).toEqual({
      rel: "first memento",
      datetime: "Wed, 01 May 2024 12:00:00 GMT"
    });
  });

  it("parses snapshots from a TimeMap response", () => {
    const snapshots = parseTimeMap({
      body: readFixture("timemap-link-format.txt"),
      originalUrl: "https://example.com/articles/launch",
      sourceHost: "archive.today"
    });

    expect(snapshots).toEqual([
      {
        originalUrl: "https://example.com/articles/launch",
        archiveUrl: "https://archive.today/20240501120000/https://example.com/articles/launch",
        capturedAt: "2024-05-01T12:00:00.000Z",
        archiveId: "20240501120000",
        sourceHost: "archive.today"
      },
      {
        originalUrl: "https://example.com/articles/launch",
        archiveUrl: "https://archive.today/20240615153045/https://example.com/articles/launch",
        capturedAt: "2024-06-15T15:30:45.000Z",
        archiveId: "20240615153045",
        sourceHost: "archive.today"
      },
      {
        originalUrl: "https://example.com/articles/launch",
        archiveUrl: "https://archive.today/20240720170010/https://example.com/articles/launch",
        capturedAt: "2024-07-20T17:00:10.000Z",
        archiveId: "20240720170010",
        sourceHost: "archive.today"
      }
    ]);
  });

  it("fetches, sorts, filters, and limits snapshots", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(readFixture("timemap-link-format.txt"), {
        status: 200,
        headers: {
          "content-type": "application/link-format"
        }
      })
    );

    const result = await listSnapshots({
      url: "https://example.com/articles/launch",
      from: "2024-06-01T00:00:00.000Z",
      limit: 1
    }, {
      fetch: fetchMock,
      timeoutMs: 1000
    });

    expect(result).toEqual({
      originalUrl: "https://example.com/articles/launch",
      normalizedUrl: "https://example.com/articles/launch",
      sourceHost: "archive.today",
      count: 1,
      snapshots: [
        {
          originalUrl: "https://example.com/articles/launch",
          archiveUrl: "https://archive.today/20240720170010/https://example.com/articles/launch",
          capturedAt: "2024-07-20T17:00:10.000Z",
          archiveId: "20240720170010",
          sourceHost: "archive.today"
        }
      ]
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://archive.today/timemap/https://example.com/articles/launch",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          accept: "application/link-format, text/plain;q=0.9, */*;q=0.1"
        })
      })
    );
  });

  it("rejects invalid inputs with typed errors", async () => {
    await expect(listSnapshots({
      url: "ftp://example.com/file"
    }, {
      fetch: vi.fn<typeof fetch>()
    })).rejects.toMatchObject({
      code: "invalid_input",
      statusCode: 400
    });
  });

  it("maps upstream rate limiting to a typed error", async () => {
    await expect(listSnapshots({
      url: "https://example.com"
    }, {
      fetch: vi.fn<typeof fetch>().mockResolvedValue(new Response("slow down", { status: 429 }))
    })).rejects.toMatchObject({
      code: "upstream_rate_limited",
      statusCode: 429
    });
  });

  it("throws no_captures when no mementos are present", async () => {
    await expect(listSnapshots({
      url: "https://example.com"
    }, {
      fetch: vi.fn<typeof fetch>().mockResolvedValue(new Response("<https://example.com>; rel=\"original\"", { status: 200 }))
    })).rejects.toBeInstanceOf(ArchiveIsError);
    await expect(listSnapshots({
      url: "https://example.com"
    }, {
      fetch: vi.fn<typeof fetch>().mockResolvedValue(new Response("<https://example.com>; rel=\"original\"", { status: 200 }))
    })).rejects.toMatchObject({
      code: "no_captures",
      statusCode: 404
    });
  });
});
