import { buildTimeMapUrl, parseTimeMap } from "./timemap.js";

export type ArchiveHost = "archive.today" | "archive.is" | "archive.ph";

export interface ArchiveSnapshot {
  originalUrl: string;
  archiveUrl: string;
  capturedAt: string;
  archiveId: string | null;
  sourceHost: string;
  validation?: ArchiveSnapshotValidation;
}

export type ArchiveSnapshotValidationStatus = "usable" | "broken" | "unchecked";

export interface ArchiveSnapshotValidation {
  status: ArchiveSnapshotValidationStatus;
  reason?: string;
  statusCode?: number;
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
  validateSnapshots?: boolean;
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
const SNAPSHOT_VALIDATION_CONCURRENCY = 5;

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
  const filteredSnapshots = applySnapshotFilters({
    snapshots: parseSnapshots({
      body,
      originalUrl: normalized.originalUrl,
      sourceHost
    }),
    from: normalized.from,
    to: normalized.to
  });
  const snapshots = options.validateSnapshots
    ? await validateSnapshotPages({
      fetchImpl,
      snapshots: filteredSnapshots.slice(0, normalized.limit),
      timeoutMs,
      userAgent: options.userAgent ?? DEFAULT_USER_AGENT
    })
    : filteredSnapshots.slice(0, normalized.limit);

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

    const body = await response.text();
    const linkHeader = response.headers.get("link");
    if (body.trim().length === 0 && linkHeader) {
      return linkHeader;
    }

    return body;
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
}): ArchiveSnapshot[] {
  return input.snapshots
    .filter((snapshot) => {
      const capturedAt = Date.parse(snapshot.capturedAt);
      return (input.from === null || capturedAt >= input.from.getTime())
        && (input.to === null || capturedAt <= input.to.getTime());
    })
    .sort((left, right) => Date.parse(right.capturedAt) - Date.parse(left.capturedAt));
}

async function validateSnapshotPages(input: {
  fetchImpl: typeof fetch;
  snapshots: ArchiveSnapshot[];
  timeoutMs: number;
  userAgent: string;
}): Promise<ArchiveSnapshot[]> {
  return mapWithConcurrency(input.snapshots, SNAPSHOT_VALIDATION_CONCURRENCY, async (snapshot) => ({
      ...snapshot,
      validation: await validateArchiveSnapshot({
        fetchImpl: input.fetchImpl,
        snapshot,
        timeoutMs: input.timeoutMs,
        userAgent: input.userAgent
      })
    }));
}

async function validateArchiveSnapshot(input: {
  fetchImpl: typeof fetch;
  snapshot: ArchiveSnapshot;
  timeoutMs: number;
  userAgent: string;
}): Promise<ArchiveSnapshotValidation> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs);

  try {
    const response = await fetchArchivePage({
      fetchImpl: input.fetchImpl,
      url: input.snapshot.archiveUrl,
      signal: controller.signal,
      userAgent: input.userAgent
    });

    if (!response.ok) {
      const errorPage = getArchiveErrorPageReason(response.body);
      if (errorPage) {
        return {
          status: "broken",
          reason: errorPage,
          statusCode: response.status
        };
      }

      const blockPage = getArchiveBlockPageReason(response.body);
      if (blockPage) {
        return {
          status: "unchecked",
          reason: blockPage,
          statusCode: response.status
        };
      }

      return {
        status: "unchecked",
        reason: "validation_http_error",
        statusCode: response.status
      };
    }

    const errorPage = getArchiveErrorPageReason(response.body);
    if (errorPage) {
      return {
        status: "broken",
        reason: errorPage
      };
    }

    return { status: "usable" };
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      return {
        status: "unchecked",
        reason: "validation_timeout"
      };
    }

    return {
      status: "unchecked",
      reason: "validation_fetch_failed"
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchArchivePage(input: {
  fetchImpl: typeof fetch;
  url: string;
  signal: AbortSignal;
  userAgent: string;
}): Promise<{
  ok: boolean;
  status: number;
  body: string;
}> {
  const response = await input.fetchImpl(input.url, {
    method: "GET",
    redirect: "manual",
    headers: {
      accept: "text/html, text/plain;q=0.9, */*;q=0.1",
      "user-agent": input.userAgent
    },
    signal: input.signal
  });

  if (!isRedirectStatus(response.status)) {
    return {
      ok: response.ok,
      status: response.status,
      body: await response.text()
    };
  }

  const location = response.headers.get("location");
  if (!location) {
    return {
      ok: response.ok,
      status: response.status,
      body: await response.text()
    };
  }

  const cookie = response.headers.get("set-cookie")?.split(";")[0];
  const redirectedUrl = new URL(location, input.url).toString();
  const redirectedResponse = await input.fetchImpl(redirectedUrl, {
    method: "GET",
    headers: {
      accept: "text/html, text/plain;q=0.9, */*;q=0.1",
      ...(cookie ? { cookie } : {}),
      "user-agent": input.userAgent
    },
    signal: input.signal
  });

  return {
    ok: redirectedResponse.ok,
    status: redirectedResponse.status,
    body: await redirectedResponse.text()
  };
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(concurrency, items.length);

  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await mapper(items[currentIndex]);
    }
  }));

  return results;
}

function getArchiveErrorPageReason(body: string): string | null {
  const normalized = body.toLowerCase();
  if (normalized.includes("task timed-out after 15 seconds of inactivity")) {
    return "archive_task_timeout";
  }

  if (normalized.includes("invalid interceptionid")) {
    return "archive_invalid_interception_id";
  }

  if (normalized.includes("<pre") && normalized.includes("error:")) {
    return "archive_error_page";
  }

  return null;
}

function getArchiveBlockPageReason(body: string): string | null {
  const normalized = body.toLowerCase();
  if (normalized.includes("g-recaptcha")
    && normalized.includes("please complete the security check")) {
    return "archive_security_check";
  }

  return null;
}
