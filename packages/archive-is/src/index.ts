import { buildTimeMapUrl, parseTimeMap } from "./timemap.js";

export type ArchiveHost = "archive.today" | "archive.is" | "archive.ph";

export interface ArchiveSnapshot {
  originalUrl: string;
  archiveUrl: string;
  capturedAt: string;
  archiveId: string | null;
  sourceHost: string;
}

export interface ListSnapshotsInput {
  url: string;
  limit?: number;
  from?: string;
  to?: string;
  archiveHost?: ArchiveHost;
}

export interface ListSnapshotsResult {
  originalUrl: string;
  normalizedUrl: string;
  sourceHost: string;
  count: number;
  snapshots: ArchiveSnapshot[];
}

export interface ArchiveClientOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
  userAgent?: string;
}

export type ArchiveIsErrorCode =
  | "invalid_input"
  | "no_captures"
  | "parse_failure"
  | "upstream_fetch_failed"
  | "upstream_http_error"
  | "upstream_rate_limited"
  | "upstream_timeout";

export class ArchiveIsError extends Error {
  readonly code: ArchiveIsErrorCode;
  readonly statusCode?: number;

  constructor(message: string, options: {
    code: ArchiveIsErrorCode;
    statusCode?: number;
    cause?: unknown;
  }) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ArchiveIsError";
    this.code = options.code;
    this.statusCode = options.statusCode;
  }
}

const ALLOWED_ARCHIVE_HOSTS = new Set<ArchiveHost>(["archive.today", "archive.is", "archive.ph"]);
const DEFAULT_ARCHIVE_HOST: ArchiveHost = "archive.today";
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_USER_AGENT = "fast-agent-marketplace-archive-is/0.1";

export { buildTimeMapUrl, parseLinkFormat, parseTimeMap } from "./timemap.js";

export async function listSnapshots(
  input: ListSnapshotsInput,
  options: ArchiveClientOptions = {}
): Promise<ListSnapshotsResult> {
  const normalized = normalizeInput(input);
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const sourceHost = normalized.archiveHost;
  const timemapUrl = buildTimeMapUrl({
    archiveHost: sourceHost,
    url: normalized.normalizedUrl
  });
  const body = await fetchTimeMap({
    fetchImpl,
    timemapUrl,
    timeoutMs,
    userAgent: options.userAgent ?? DEFAULT_USER_AGENT
  });
  const snapshots = applySnapshotFilters({
    snapshots: parseSnapshots({
      body,
      originalUrl: normalized.originalUrl,
      sourceHost
    }),
    from: normalized.from,
    to: normalized.to,
    limit: normalized.limit
  });

  if (snapshots.length === 0) {
    throw new ArchiveIsError("No archived captures found for the requested URL.", {
      code: "no_captures",
      statusCode: 404
    });
  }

  return {
    originalUrl: normalized.originalUrl,
    normalizedUrl: normalized.normalizedUrl,
    sourceHost,
    count: snapshots.length,
    snapshots
  };
}

function normalizeInput(input: ListSnapshotsInput) {
  const originalUrl = requireString(input.url, "url");
  const normalizedUrl = normalizeHttpUrl(originalUrl);
  const archiveHost = normalizeArchiveHost(input.archiveHost);
  const limit = normalizeLimit(input.limit);
  const from = normalizeDateBoundary(input.from, "from");
  const to = normalizeDateBoundary(input.to, "to");

  if (from && to && from.getTime() > to.getTime()) {
    throw new ArchiveIsError("from must be earlier than or equal to to.", {
      code: "invalid_input",
      statusCode: 400
    });
  }

  return {
    originalUrl,
    normalizedUrl,
    archiveHost,
    limit,
    from,
    to
  };
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ArchiveIsError(`${field} must be a non-empty string.`, {
      code: "invalid_input",
      statusCode: 400
    });
  }

  return value.trim();
}

function normalizeHttpUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch (error) {
    throw new ArchiveIsError("url must be a valid absolute URL.", {
      code: "invalid_input",
      statusCode: 400,
      cause: error
    });
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ArchiveIsError("url must use http or https.", {
      code: "invalid_input",
      statusCode: 400
    });
  }

  return parsed.toString();
}

function normalizeArchiveHost(value: ArchiveHost | undefined): ArchiveHost {
  if (value === undefined) {
    return DEFAULT_ARCHIVE_HOST;
  }

  if (!ALLOWED_ARCHIVE_HOSTS.has(value)) {
    throw new ArchiveIsError("archiveHost must be archive.today, archive.is, or archive.ph.", {
      code: "invalid_input",
      statusCode: 400
    });
  }

  return value;
}

function normalizeLimit(value: number | undefined): number {
  if (value === undefined) {
    return DEFAULT_LIMIT;
  }

  if (!Number.isInteger(value) || value < 1 || value > MAX_LIMIT) {
    throw new ArchiveIsError(`limit must be an integer between 1 and ${MAX_LIMIT}.`, {
      code: "invalid_input",
      statusCode: 400
    });
  }

  return value;
}

function normalizeDateBoundary(value: string | undefined, field: "from" | "to"): Date | null {
  if (value === undefined) {
    return null;
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new ArchiveIsError(`${field} must be a valid date string.`, {
      code: "invalid_input",
      statusCode: 400
    });
  }

  return parsed;
}

async function fetchTimeMap(input: {
  fetchImpl: typeof fetch;
  timemapUrl: string;
  timeoutMs: number;
  userAgent: string;
}): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs);

  try {
    const response = await input.fetchImpl(input.timemapUrl, {
      method: "GET",
      headers: {
        accept: "application/link-format, text/plain;q=0.9, */*;q=0.1",
        "user-agent": input.userAgent
      },
      signal: controller.signal
    });

    if (response.status === 429) {
      throw new ArchiveIsError("Archive.today rate limited the TimeMap request.", {
        code: "upstream_rate_limited",
        statusCode: 429
      });
    }

    if (!response.ok) {
      throw new ArchiveIsError(`Archive.today TimeMap request failed with HTTP ${response.status}.`, {
        code: "upstream_http_error",
        statusCode: response.status
      });
    }

    return response.text();
  } catch (error) {
    if (error instanceof ArchiveIsError) {
      throw error;
    }

    if (error instanceof DOMException && error.name === "AbortError") {
      throw new ArchiveIsError("Archive.today TimeMap request timed out.", {
        code: "upstream_timeout",
        statusCode: 504,
        cause: error
      });
    }

    throw new ArchiveIsError(error instanceof Error ? error.message : "Archive.today TimeMap request failed.", {
      code: "upstream_fetch_failed",
      statusCode: 502,
      cause: error
    });
  } finally {
    clearTimeout(timeout);
  }
}

function parseSnapshots(input: {
  body: string;
  originalUrl: string;
  sourceHost: string;
}): ArchiveSnapshot[] {
  try {
    return parseTimeMap(input);
  } catch (error) {
    throw new ArchiveIsError("Archive.today TimeMap response could not be parsed.", {
      code: "parse_failure",
      statusCode: 502,
      cause: error
    });
  }
}

function applySnapshotFilters(input: {
  snapshots: ArchiveSnapshot[];
  from: Date | null;
  to: Date | null;
  limit: number;
}): ArchiveSnapshot[] {
  return input.snapshots
    .filter((snapshot) => {
      const capturedAt = Date.parse(snapshot.capturedAt);
      return (input.from === null || capturedAt >= input.from.getTime())
        && (input.to === null || capturedAt <= input.to.getTime());
    })
    .sort((left, right) => Date.parse(right.capturedAt) - Date.parse(left.capturedAt))
    .slice(0, input.limit);
}
