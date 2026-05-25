import {
  ArchiveIsError,
  listSnapshots,
  type ListSnapshotsInput,
  type ListSnapshotsResult
} from "@marketplace/archive-is";
import express, { type Express } from "express";

import { buildArchiveIsOpenApiDocument } from "./openapi.js";

export interface ArchiveIsServiceOptions {
  archiveHost?: ListSnapshotsInput["archiveHost"];
  timeoutMs?: number;
  verificationToken?: string | null;
  listSnapshots?: (input: ListSnapshotsInput) => Promise<ListSnapshotsResult>;
}

export function createArchiveIsServiceApp(options: ArchiveIsServiceOptions = {}): Express {
  const app = express();
  const archiveHost = options.archiveHost ?? "archive.today";
  const timeoutMs = options.timeoutMs ?? 10_000;
  const listSnapshotsImpl = options.listSnapshots ?? ((input) => listSnapshots(input, {
    timeoutMs,
    validateSnapshots: true
  }));

  app.use(express.json({ limit: "64kb" }));

  app.get("/health", (_req, res) => {
    res.json({
      ok: true,
      archiveHost,
      timeoutMs
    });
  });

  app.get("/openapi.json", (_req, res) => {
    res.json(buildArchiveIsOpenApiDocument());
  });

  app.get("/.well-known/fast-marketplace-verification.txt", (_req, res) => {
    if (!options.verificationToken) {
      return res.status(404).type("text/plain").send("Verification token is not configured.");
    }

    return res.type("text/plain").send(options.verificationToken);
  });

  app.post("/snapshots", async (req, res) => {
    try {
      const input = parseRequestInput(req.body, archiveHost);
      const result = await listSnapshotsImpl(input);
      return res.status(200).json(result);
    } catch (error) {
      const mapped = mapArchiveError(error);
      return res.status(mapped.statusCode).json({
        error: mapped.message,
        code: mapped.code
      });
    }
  });

  return app;
}

export function normalizeArchiveIsTimeoutMs(value: string | undefined): number {
  if (value === undefined || value.trim() === "") {
    return 10_000;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error("ARCHIVE_IS_TIMEOUT_MS must be a positive integer.");
  }

  return parsed;
}

function parseRequestInput(body: unknown, archiveHost: ListSnapshotsInput["archiveHost"]): ListSnapshotsInput {
  if (!isRecord(body)) {
    throw new ArchiveIsError("Request body must be a JSON object.", {
      code: "invalid_input",
      statusCode: 400
    });
  }

  const allowedKeys = new Set(["url", "limit", "from", "to", "archiveHost"]);
  const unknownKeys = Object.keys(body).filter((key) => !allowedKeys.has(key));
  if (unknownKeys.length > 0) {
    throw new ArchiveIsError(`Unknown request field: ${unknownKeys[0]}.`, {
      code: "invalid_input",
      statusCode: 400
    });
  }

  if (typeof body.url !== "string") {
    throw new ArchiveIsError("url must be a non-empty string.", {
      code: "invalid_input",
      statusCode: 400
    });
  }

  if (body.limit !== undefined && typeof body.limit !== "number") {
    throw new ArchiveIsError("limit must be a number.", {
      code: "invalid_input",
      statusCode: 400
    });
  }

  if (body.from !== undefined && typeof body.from !== "string") {
    throw new ArchiveIsError("from must be a string.", {
      code: "invalid_input",
      statusCode: 400
    });
  }

  if (body.to !== undefined && typeof body.to !== "string") {
    throw new ArchiveIsError("to must be a string.", {
      code: "invalid_input",
      statusCode: 400
    });
  }

  if (body.archiveHost !== undefined && !isArchiveHost(body.archiveHost)) {
    throw new ArchiveIsError("archiveHost must be archive.today, archive.is, or archive.ph.", {
      code: "invalid_input",
      statusCode: 400
    });
  }

  return {
    url: body.url,
    limit: body.limit,
    from: body.from,
    to: body.to,
    archiveHost: body.archiveHost ?? archiveHost
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isArchiveHost(value: unknown): value is ListSnapshotsInput["archiveHost"] {
  return value === "archive.today" || value === "archive.is" || value === "archive.ph";
}

function mapArchiveError(error: unknown): {
  statusCode: number;
  message: string;
  code: string;
} {
  if (error instanceof ArchiveIsError) {
    return {
      statusCode: mapArchiveStatusCode(error),
      message: error.message,
      code: error.code
    };
  }

  return {
    statusCode: 500,
    message: error instanceof Error ? error.message : "Archive.is service failed.",
    code: "internal_error"
  };
}

function mapArchiveStatusCode(error: ArchiveIsError): number {
  switch (error.code) {
    case "invalid_input":
      return 400;
    case "no_captures":
      return 404;
    case "upstream_rate_limited":
      return 429;
    case "upstream_timeout":
      return 504;
    case "parse_failure":
    case "upstream_fetch_failed":
    case "upstream_http_error":
      return 502;
  }
}
