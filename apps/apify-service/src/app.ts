import express, { type Express } from "express";

import { getApifyProxyRoutes } from "./operations.js";
import { buildApifyOpenApiDocument } from "./openapi.js";

export interface ApifyServiceOptions {
  apifyApiToken: string;
  actorId: string;
  apifyApiBaseUrl?: string;
  serviceName?: string;
  serviceDescription?: string;
  verificationToken?: string | null;
  defaultPollAfterMs?: number;
  datasetItemLimit?: number;
}

const DEFAULT_APIFY_API_BASE_URL = "https://api.apify.com/v2";
const DEFAULT_SERVICE_NAME = "Apify Actor Proxy";
const DEFAULT_SERVICE_DESCRIPTION =
  "Thin async proxy for a single Apify actor. The service starts actor runs and polls Apify for completion.";
const DEFAULT_POLL_AFTER_MS = 5000;
const DEFAULT_DATASET_ITEM_LIMIT = 100;

class ApifyResultFetchError extends Error {
  constructor(
    message: string,
    readonly permanent: boolean
  ) {
    super(message);
  }
}

export function createApifyServiceApp(options: ApifyServiceOptions): Express {
  const app = express();
  const upstreamBaseUrl = normalizeUpstreamBaseUrl(options.apifyApiBaseUrl ?? DEFAULT_APIFY_API_BASE_URL);
  const serviceName = options.serviceName?.trim() || DEFAULT_SERVICE_NAME;
  const serviceDescription = options.serviceDescription?.trim() || DEFAULT_SERVICE_DESCRIPTION;
  const datasetItemLimit = Math.max(1, options.datasetItemLimit ?? DEFAULT_DATASET_ITEM_LIMIT);
  const defaultPollAfterMs = Math.max(1000, options.defaultPollAfterMs ?? DEFAULT_POLL_AFTER_MS);
  const proxyRoutes = getApifyProxyRoutes(options.actorId);

  app.use(express.json({ limit: "1mb" }));

  app.get("/health", (_req, res) => {
    res.json({
      ok: true,
      actorId: options.actorId,
      upstreamBaseUrl
    });
  });

  app.get("/openapi.json", (_req, res) => {
    res.json(buildApifyOpenApiDocument({
      actorId: options.actorId,
      serviceName,
      serviceDescription,
      routes: proxyRoutes
    }));
  });

  app.get("/.well-known/fast-marketplace-verification.txt", (_req, res) => {
    if (!options.verificationToken) {
      return res.status(404).type("text/plain").send("Verification token is not configured.");
    }

    return res.type("text/plain").send(options.verificationToken);
  });

  const runHandler: express.RequestHandler = async (req, res) => {
    let response: globalThis.Response;
    try {
      response = await fetch(buildActorRunUrl(upstreamBaseUrl, options.actorId), {
        method: "POST",
        headers: {
          authorization: `Bearer ${options.apifyApiToken}`,
          "content-type": "application/json"
        },
        body: JSON.stringify(req.body ?? {})
      });
    } catch (error) {
      return res.status(502).json({
        error: error instanceof Error ? error.message : "Apify request failed."
      });
    }

    const body = await safeResponseBody(response);
    if (!response.ok) {
      return res.status(response.status).json(wrapErrorBody(body, "Apify run request failed."));
    }

    const run = extractRunRecord(body);
    if (!run.id) {
      return res.status(502).json({
        error: "Apify run response did not include a run id."
      });
    }

    return res.status(202).json({
      status: "accepted",
      providerJobId: run.id,
      pollAfterMs: defaultPollAfterMs,
      providerState: {
        actorId: options.actorId,
        datasetId: run.defaultDatasetId ?? null,
        keyValueStoreId: run.defaultKeyValueStoreId ?? null
      }
    });
  };

  app.post("/run", runHandler);
  for (const route of proxyRoutes) {
    if (route.path === "/run") {
      continue;
    }

    app.post(route.path, runHandler);
  }

  app.post("/runs/poll", async (req, res) => {
    const providerJobId = typeof req.body?.providerJobId === "string" ? req.body.providerJobId.trim() : "";
    const providerState = isJsonObject(req.body?.providerState) ? req.body.providerState : {};

    if (!providerJobId) {
      return res.status(400).json({
        error: "providerJobId is required."
      });
    }

    let runResponse: globalThis.Response;
    try {
      runResponse = await fetch(buildRunStatusUrl(upstreamBaseUrl, providerJobId), {
        method: "GET",
        headers: {
          authorization: `Bearer ${options.apifyApiToken}`
        }
      });
    } catch (error) {
      return res.status(502).json({
        error: error instanceof Error ? error.message : "Apify poll request failed."
      });
    }

    const runBody = await safeResponseBody(runResponse);
    if (!runResponse.ok) {
      return res.status(runResponse.status).json(wrapErrorBody(runBody, "Apify run status request failed."));
    }

    const run = extractRunRecord(runBody);
    const nextProviderState = {
      actorId: options.actorId,
      datasetId: run.defaultDatasetId ?? providerState.datasetId ?? null,
      keyValueStoreId: run.defaultKeyValueStoreId ?? providerState.keyValueStoreId ?? null
    };
    const normalizedStatus = String(run.status ?? "").toUpperCase();

    if (normalizedStatus === "SUCCEEDED") {
      let result: Awaited<ReturnType<typeof fetchApifyResult>>;
      try {
        result = await fetchApifyResult({
          upstreamBaseUrl,
          token: options.apifyApiToken,
          datasetId: typeof nextProviderState.datasetId === "string" ? nextProviderState.datasetId : null,
          keyValueStoreId: typeof nextProviderState.keyValueStoreId === "string" ? nextProviderState.keyValueStoreId : null,
          limit: datasetItemLimit
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Apify result fetch failed.";
        return res.json({
          status: "failed",
          permanent: error instanceof ApifyResultFetchError ? error.permanent : false,
          error: message,
          providerState: nextProviderState
        });
      }

      return res.json({
        status: "completed",
        result: {
          runId: run.id ?? providerJobId,
          actorId: options.actorId,
          status: normalizedStatus,
          items: result.items,
          output: result.output ?? null
        }
      });
    }

    if (isPendingApifyStatus(normalizedStatus)) {
      return res.json({
        status: "pending",
        pollAfterMs: defaultPollAfterMs,
        providerState: nextProviderState
      });
    }

    return res.json({
      status: "failed",
      permanent: true,
      error: buildFailureMessage(run, providerJobId),
      providerState: nextProviderState
    });
  });

  return app;
}

function normalizeUpstreamBaseUrl(input: string): string {
  return new URL(input).toString().replace(/\/+$/, "");
}

function buildActorRunUrl(baseUrl: string, actorId: string): string {
  return `${baseUrl}/acts/${encodeURIComponent(actorId)}/runs`;
}

function buildRunStatusUrl(baseUrl: string, runId: string): string {
  return `${baseUrl}/actor-runs/${encodeURIComponent(runId)}`;
}

function buildDatasetItemsUrl(baseUrl: string, datasetId: string, limit: number): string {
  const url = new URL(`${baseUrl}/datasets/${encodeURIComponent(datasetId)}/items`);
  url.searchParams.set("format", "json");
  url.searchParams.set("clean", "true");
  url.searchParams.set("limit", String(limit));
  return url.toString();
}

function buildOutputRecordUrl(baseUrl: string, keyValueStoreId: string): string {
  return `${baseUrl}/key-value-stores/${encodeURIComponent(keyValueStoreId)}/records/OUTPUT`;
}

async function fetchApifyResult(input: {
  upstreamBaseUrl: string;
  token: string;
  datasetId: string | null;
  keyValueStoreId: string | null;
  limit: number;
}): Promise<{ items: unknown[]; output?: unknown }> {
  const failures: ApifyResultFetchError[] = [];

  if (input.datasetId) {
    let response: globalThis.Response;
    try {
      response = await fetch(buildDatasetItemsUrl(input.upstreamBaseUrl, input.datasetId, input.limit), {
        method: "GET",
        headers: {
          authorization: `Bearer ${input.token}`
        }
      });
    } catch (error) {
      failures.push(new ApifyResultFetchError(
        error instanceof Error ? error.message : "Apify dataset fetch failed.",
        false
      ));
      response = null as never;
    }

    if (response?.ok) {
      const body = await safeResponseBody(response);
      return {
        items: Array.isArray(body) ? body : []
      };
    }

    if (response && !response.ok) {
      failures.push(new ApifyResultFetchError(
        `Apify dataset fetch failed with status ${response.status}.`,
        response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429
      ));
    }
  }

  if (input.keyValueStoreId) {
    let response: globalThis.Response;
    try {
      response = await fetch(buildOutputRecordUrl(input.upstreamBaseUrl, input.keyValueStoreId), {
        method: "GET",
        headers: {
          authorization: `Bearer ${input.token}`
        }
      });
    } catch (error) {
      failures.push(new ApifyResultFetchError(
        error instanceof Error ? error.message : "Apify output fetch failed.",
        false
      ));
      response = null as never;
    }

    if (response?.ok) {
      return {
        items: [],
        output: await safeResponseBody(response)
      };
    }

    if (response && !response.ok) {
      failures.push(new ApifyResultFetchError(
        `Apify output fetch failed with status ${response.status}.`,
        response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429
      ));
    }
  }

  if (failures.length > 0) {
    throw new ApifyResultFetchError(
      failures.map((failure) => failure.message).join(" "),
      failures.every((failure) => failure.permanent)
    );
  }

  return {
    items: []
  };
}

function extractRunRecord(body: unknown): {
  id: string | null;
  status: string | null;
  defaultDatasetId: string | null;
  defaultKeyValueStoreId: string | null;
  statusMessage: string | null;
  statusMessageActor: string | null;
} {
  const candidate = isJsonObject(body) && isJsonObject(body.data) ? body.data : body;
  if (!isJsonObject(candidate)) {
    return {
      id: null,
      status: null,
      defaultDatasetId: null,
      defaultKeyValueStoreId: null,
      statusMessage: null,
      statusMessageActor: null
    };
  }

  return {
    id: typeof candidate.id === "string" ? candidate.id : null,
    status: typeof candidate.status === "string" ? candidate.status : null,
    defaultDatasetId: typeof candidate.defaultDatasetId === "string" ? candidate.defaultDatasetId : null,
    defaultKeyValueStoreId: typeof candidate.defaultKeyValueStoreId === "string" ? candidate.defaultKeyValueStoreId : null,
    statusMessage: typeof candidate.statusMessage === "string" ? candidate.statusMessage : null,
    statusMessageActor: typeof candidate.statusMessageActor === "string" ? candidate.statusMessageActor : null
  };
}

function isPendingApifyStatus(status: string): boolean {
  return status !== "" && !["SUCCEEDED", "FAILED", "ABORTED", "TIMED-OUT"].includes(status);
}

function buildFailureMessage(
  run: ReturnType<typeof extractRunRecord>,
  providerJobId: string
): string {
  return run.statusMessageActor
    ?? run.statusMessage
    ?? `Apify run ${run.id ?? providerJobId} finished with status ${run.status ?? "UNKNOWN"}.`;
}

function wrapErrorBody(body: unknown, fallback: string): Record<string, unknown> {
  if (isJsonObject(body) && typeof body.error === "string") {
    return body;
  }

  return {
    error: fallback,
    upstreamBody: body
  };
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function safeResponseBody(response: globalThis.Response): Promise<unknown> {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return response.json();
  }

  return response.text();
}
