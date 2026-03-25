import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { config as loadDotenv } from "dotenv";
import { z } from "zod";
import { normalizeFastWalletAddress, type CreateProviderEndpointDraftInput, type CreateProviderServiceInput, type MarketplaceDeploymentNetwork, type ProviderEndpointDraftRecord, type ProviderServiceDetailRecord, type ProviderServiceRecord, type ProviderVerificationRecord, type UpdateProviderEndpointDraftInput, type UpdateProviderServiceInput, type UpsertProviderAccountInput } from "@marketplace/shared";

import { defaultCliDependencies, expandHome, loadWallet, loadWalletFromPrivateKey, type CliDependencies, type LoadedWallet } from "./lib.js";

interface ProviderSiteChallenge {
  wallet: string;
  resourceType: "site";
  resourceId: string;
  nonce: string;
  expiresAt: string;
  message: string;
}

interface ProviderSiteSession {
  accessToken: string;
  wallet: string;
  resourceType: "site";
  resourceId: string;
  tokenType?: string;
}

interface ProviderRuntimeKeySummary {
  id: string;
  keyPrefix: string;
  createdAt: string;
  updatedAt: string;
}

interface ProviderRuntimeKeyResponse {
  runtimeKey: ProviderRuntimeKeySummary | null;
  plaintextKey?: string;
}

interface ProviderVerificationChallengeResponse {
  verificationId: string;
  token: string;
  expectedUrl: string;
}

const providerAccountSchema = z.object({
  displayName: z.string().min(2).max(120),
  bio: z.string().max(1_000).optional().nullable(),
  websiteUrl: z.string().url().optional().nullable(),
  contactEmail: z.string().email().optional().nullable()
}).strict();

const providerServiceTypeSchema = z.enum(["marketplace_proxy", "external_registry"]);
const routeBillingTypeSchema = z.enum(["fixed_x402", "topup_x402_variable", "prepaid_credit", "free"]);
const decimalAmountSchema = z.string().regex(/^\d+(?:\.\d{1,6})?$/);

const providerServiceSpecSchema = z.object({
  serviceType: providerServiceTypeSchema,
  slug: z.string().regex(/^[a-z0-9-]{3,64}$/),
  apiNamespace: z.string().regex(/^[a-z0-9-]{3,64}$/).optional().nullable(),
  name: z.string().min(2).max(120),
  tagline: z.string().min(5).max(240),
  about: z.string().min(20).max(4_000),
  categories: z.array(z.string().min(2).max(40)).min(1).max(8),
  promptIntro: z.string().min(10).max(500),
  setupInstructions: z.array(z.string().min(3).max(240)).min(1).max(10),
  websiteUrl: z.string().url().optional().nullable(),
  payoutWallet: z.string().min(1).optional().nullable()
}).strict().superRefine((value, ctx) => {
  if (value.serviceType === "marketplace_proxy" && !value.apiNamespace) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "apiNamespace is required when serviceType=marketplace_proxy.",
      path: ["apiNamespace"]
    });
  }
});

const marketplaceEndpointSpecSchema = z.object({
  endpointType: z.literal("marketplace_proxy"),
  operation: z.string().regex(/^[a-z0-9-]{2,64}$/),
  title: z.string().min(2).max(120),
  description: z.string().min(10).max(500),
  billingType: routeBillingTypeSchema,
  price: z.string().regex(/^\$\d+(?:\.\d{1,6})?$/).optional().nullable(),
  minAmount: decimalAmountSchema.optional().nullable(),
  maxAmount: decimalAmountSchema.optional().nullable(),
  method: z.enum(["GET", "POST"]),
  mode: z.enum(["sync", "async"]),
  asyncStrategy: z.enum(["poll", "webhook"]).optional().nullable(),
  asyncTimeoutMs: z.number().int().positive().optional().nullable(),
  pollPath: z.string().startsWith("/").optional().nullable(),
  requestSchemaJson: z.record(z.string(), z.unknown()),
  responseSchemaJson: z.record(z.string(), z.unknown()),
  requestExample: z.unknown(),
  responseExample: z.unknown(),
  usageNotes: z.string().max(1_000).optional().nullable(),
  upstreamBaseUrl: z.string().url().optional().nullable(),
  upstreamPath: z.string().startsWith("/").optional().nullable(),
  upstreamAuthMode: z.enum(["none", "bearer", "header"]).optional().nullable(),
  upstreamAuthHeaderName: z.string().min(1).max(120).optional().nullable(),
  upstreamSecret: z.string().min(1).max(4_000).optional()
}).strict();

const externalEndpointSpecSchema = z.object({
  endpointType: z.literal("external_registry"),
  title: z.string().min(2).max(120),
  description: z.string().min(10).max(500),
  method: z.enum(["GET", "POST"]),
  publicUrl: z.string().url(),
  docsUrl: z.string().url(),
  authNotes: z.string().max(1_000).optional().nullable(),
  requestExample: z.unknown(),
  responseExample: z.unknown(),
  usageNotes: z.string().max(1_000).optional().nullable()
}).strict();

const providerEndpointSpecSchema = z.discriminatedUnion("endpointType", [
  marketplaceEndpointSpecSchema,
  externalEndpointSpecSchema
]);

const providerSyncSpecSchema = z.object({
  profile: providerAccountSchema,
  service: providerServiceSpecSchema,
  endpoints: z.array(providerEndpointSpecSchema).min(1)
}).strict().superRefine((value, ctx) => {
  for (const endpoint of value.endpoints) {
    if (endpoint.endpointType !== value.service.serviceType) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "All endpoint drafts must match the serviceType.",
        path: ["endpoints"]
      });
      break;
    }
  }

  const seenKeys = new Set<string>();
  for (const endpoint of value.endpoints) {
    const key = specEndpointKey(endpoint);
    if (seenKeys.has(key)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Duplicate endpoint match key: ${key}`,
        path: ["endpoints"]
      });
      break;
    }
    seenKeys.add(key);
  }
});

export type ProviderSyncSpec = z.infer<typeof providerSyncSpecSchema>;

class MarketplaceApiError extends Error {
  statusCode: number;
  body: unknown;

  constructor(statusCode: number, body: unknown) {
    super(errorMessage(body, statusCode));
    this.statusCode = statusCode;
    this.body = body;
  }
}

export function loadProviderCommandEnv(cwd = process.cwd()): void {
  loadDotenv({ path: resolve(cwd, ".env"), override: false, quiet: true });
}

export async function createProviderSiteSession(input: {
  apiUrl?: string;
  keyfilePath?: string;
  configPath?: string;
  network?: MarketplaceDeploymentNetwork;
  rpcUrl?: string;
}, deps: CliDependencies = defaultCliDependencies()) {
  loadProviderCommandEnv();
  const apiUrl = resolveProviderApiUrl(input.apiUrl);
  const wallet = await loadProviderWallet({
    keyfilePath: input.keyfilePath,
    configPath: input.configPath,
    network: resolveProviderNetwork(input.network),
    rpcUrl: input.rpcUrl
  });
  const baseUrl = apiUrl.replace(/\/$/, "");

  const challenge = await requestJson<ProviderSiteChallenge>(deps, `${baseUrl}/auth/wallet/challenge`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      wallet: wallet.paymentWallet.address
    })
  });
  const signed = await wallet.wallet.sign({ message: challenge.message });
  const session = await requestJson<ProviderSiteSession>(deps, `${baseUrl}/auth/wallet/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      wallet: wallet.paymentWallet.address,
      nonce: challenge.nonce,
      expiresAt: challenge.expiresAt,
      signature: signed.signature
    })
  });

  return {
    apiUrl,
    accessToken: session.accessToken,
    resourceId: session.resourceId,
    wallet: wallet.paymentWallet.address,
    keySource: wallet.keyfilePath
  };
}

export async function syncProviderSpec(input: {
  specPath: string;
  apiUrl?: string;
  keyfilePath?: string;
  configPath?: string;
  network?: MarketplaceDeploymentNetwork;
  rpcUrl?: string;
}, deps: CliDependencies = defaultCliDependencies()) {
  loadProviderCommandEnv();
  const spec = await readProviderSpec(input.specPath);
  const session = await createProviderSiteSession(input, deps);
  const profile = await upsertProviderAccount(session.apiUrl, session.accessToken, spec.profile, deps);

  const existing = await findProviderServiceBySlug(session.apiUrl, session.accessToken, spec.service.slug, deps);
  const servicePayload = buildServicePayload(spec, session.wallet);
  const initialSyncState = existing
    ? await syncExistingProviderService(session.apiUrl, session.accessToken, existing.service.id, servicePayload, deps)
    : {
        detail: await createProviderService(session.apiUrl, session.accessToken, servicePayload, deps),
        resetDeleted: [] as string[]
      };

  const runtimeKey = await ensureRuntimeKey(session.apiUrl, session.accessToken, initialSyncState.detail, deps);
  const detailBeforeReconcile = await fetchProviderService(
    session.apiUrl,
    session.accessToken,
    initialSyncState.detail.service.id,
    deps
  );
  const endpointChanges = await reconcileEndpointDrafts({
    apiUrl: session.apiUrl,
    accessToken: session.accessToken,
    detail: detailBeforeReconcile,
    spec,
    deps
  });
  const finalDetail = await fetchProviderService(
    session.apiUrl,
    session.accessToken,
    initialSyncState.detail.service.id,
    deps
  );

  return {
    status: "synced",
    wallet: session.wallet,
    keySource: session.keySource,
    account: {
      id: profile.id,
      ownerWallet: profile.ownerWallet,
      displayName: profile.displayName
    },
    service: summarizeService(finalDetail),
    runtimeKey,
    endpoints: {
      ...endpointChanges,
      deleted: [...initialSyncState.resetDeleted, ...endpointChanges.deleted]
    },
    verification: summarizeVerification(finalDetail.verification)
  };
}

export async function verifyProviderService(input: {
  serviceRef: string;
  apiUrl?: string;
  keyfilePath?: string;
  configPath?: string;
  network?: MarketplaceDeploymentNetwork;
  rpcUrl?: string;
}, deps: CliDependencies = defaultCliDependencies()) {
  loadProviderCommandEnv();
  const session = await createProviderSiteSession(input, deps);
  const detail = await resolveProviderService(session.apiUrl, session.accessToken, input.serviceRef, deps);
  const challenge = await createVerificationChallenge(session.apiUrl, session.accessToken, detail.service.id, deps);
  const instructions = verificationInstructions(challenge);
  const confirmed = await deps.confirm([
    `Host the verification token for ${detail.service.slug} before continuing.`,
    `Expected URL: ${challenge.expectedUrl}`,
    `Token: ${challenge.token}`,
    "Verify ownership now?"
  ].join("\n"));

  if (!confirmed) {
    return {
      status: "action_required",
      service: summarizeService(detail),
      challenge,
      instructions
    };
  }

  try {
    const verification = await verifyServiceOwnership(session.apiUrl, session.accessToken, detail.service.id, deps);
    return {
      status: "verified",
      service: summarizeService(detail),
      challenge,
      instructions,
      verification: summarizeVerification(verification)
    };
  } catch (error) {
    if (error instanceof MarketplaceApiError && (error.statusCode === 400 || error.statusCode === 502)) {
      return {
        status: "action_required",
        service: summarizeService(detail),
        challenge,
        instructions,
        error: error.message,
        verification: summarizeVerification(extractVerificationRecord(error.body))
      };
    }

    throw error;
  }
}

export async function submitProviderService(input: {
  serviceRef: string;
  apiUrl?: string;
  keyfilePath?: string;
  configPath?: string;
  network?: MarketplaceDeploymentNetwork;
  rpcUrl?: string;
}, deps: CliDependencies = defaultCliDependencies()) {
  loadProviderCommandEnv();
  const session = await createProviderSiteSession(input, deps);
  const detail = await resolveProviderService(session.apiUrl, session.accessToken, input.serviceRef, deps);

  if (!isVerificationReady(detail)) {
    return {
      status: "action_required",
      service: summarizeService(detail),
      error: "Website verification is incomplete. Run `fast-marketplace provider verify --service <slug-or-id>` after hosting the current verification token."
    };
  }

  try {
    const submitted = await submitProviderDraft(session.apiUrl, session.accessToken, detail.service.id, deps);
    return {
      status: "submitted",
      service: summarizeService(submitted),
      verification: summarizeVerification(submitted.verification),
      review: submitted.latestReview
    };
  } catch (error) {
    if (error instanceof MarketplaceApiError && error.statusCode === 400) {
      return {
        status: "action_required",
        service: summarizeService(detail),
        error: error.message
      };
    }

    throw error;
  }
}

async function readProviderSpec(specPath: string): Promise<ProviderSyncSpec> {
  const resolved = expandHome(specPath);
  const raw = await readFile(resolved, "utf8");

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Provider spec must be valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }

  return providerSyncSpecSchema.parse(parsed);
}

async function loadProviderWallet(input: {
  keyfilePath?: string;
  configPath?: string;
  network?: MarketplaceDeploymentNetwork;
  rpcUrl?: string;
}): Promise<LoadedWallet> {
  if (input.keyfilePath) {
    return loadWallet(input);
  }

  const envPrivateKey = process.env.AGENT_WALLET_KEY;
  if (envPrivateKey) {
    return loadWalletFromPrivateKey({
      privateKey: envPrivateKey,
      sourceLabel: "env:AGENT_WALLET_KEY",
      configPath: input.configPath,
      network: input.network,
      rpcUrl: input.rpcUrl
    });
  }

  return loadWallet(input);
}

function resolveProviderApiUrl(apiUrl?: string): string {
  return apiUrl ?? process.env.MARKETPLACE_API_BASE_URL ?? "http://localhost:3000";
}

function resolveProviderNetwork(network?: MarketplaceDeploymentNetwork): MarketplaceDeploymentNetwork {
  const candidate = network ?? process.env.MARKETPLACE_FAST_NETWORK ?? "mainnet";
  if (candidate !== "mainnet" && candidate !== "testnet") {
    throw new Error("MARKETPLACE_FAST_NETWORK must be mainnet or testnet.");
  }

  return candidate;
}

async function requestJson<T>(
  deps: CliDependencies,
  url: string,
  init?: RequestInit
): Promise<T> {
  const response = await deps.fetchImpl(url, init);
  if (response.status === 204) {
    return undefined as T;
  }

  const body = await readResponseBody(response);
  if (!response.ok) {
    throw new MarketplaceApiError(response.status, body);
  }

  return body as T;
}

async function readResponseBody(response: Response): Promise<unknown> {
  const bodyText = await response.text();
  if (bodyText.length === 0) {
    return undefined;
  }

  try {
    return JSON.parse(bodyText) as unknown;
  } catch {
    return bodyText;
  }
}

function errorMessage(body: unknown, statusCode: number): string {
  if (typeof body === "string" && body.trim().length > 0) {
    return body;
  }

  if (body && typeof body === "object" && "error" in body && typeof body.error === "string") {
    return body.error;
  }

  return `Marketplace request failed with status ${statusCode}`;
}

function providerHeaders(accessToken: string): Record<string, string> {
  return {
    authorization: `Bearer ${accessToken}`
  };
}

async function upsertProviderAccount(
  apiUrl: string,
  accessToken: string,
  input: UpsertProviderAccountInput,
  deps: CliDependencies
) {
  return requestJson<ProviderServiceDetailRecord["account"]>(deps, `${apiUrl.replace(/\/$/, "")}/provider/me`, {
    method: "POST",
    headers: {
      ...providerHeaders(accessToken),
      "content-type": "application/json"
    },
    body: JSON.stringify(input)
  });
}

async function listProviderServices(apiUrl: string, accessToken: string, deps: CliDependencies) {
  const body = await requestJson<{ services: ProviderServiceDetailRecord[] }>(
    deps,
    `${apiUrl.replace(/\/$/, "")}/provider/services`,
    {
      headers: providerHeaders(accessToken)
    }
  );
  return body.services;
}

async function findProviderServiceBySlug(
  apiUrl: string,
  accessToken: string,
  slug: string,
  deps: CliDependencies
) {
  const services = await listProviderServices(apiUrl, accessToken, deps);
  return services.find((candidate) => candidate.service.slug === slug) ?? null;
}

async function resolveProviderService(
  apiUrl: string,
  accessToken: string,
  serviceRef: string,
  deps: CliDependencies
) {
  const services = await listProviderServices(apiUrl, accessToken, deps);
  const match = services.find((candidate) => candidate.service.id === serviceRef || candidate.service.slug === serviceRef);
  if (!match) {
    throw new Error(`Provider service not found: ${serviceRef}`);
  }

  return fetchProviderService(apiUrl, accessToken, match.service.id, deps);
}

async function createProviderService(
  apiUrl: string,
  accessToken: string,
  input: CreateProviderServiceInput,
  deps: CliDependencies
) {
  return requestJson<ProviderServiceDetailRecord>(deps, `${apiUrl.replace(/\/$/, "")}/provider/services`, {
    method: "POST",
    headers: {
      ...providerHeaders(accessToken),
      "content-type": "application/json"
    },
    body: JSON.stringify(input)
  });
}

async function updateProviderService(
  apiUrl: string,
  accessToken: string,
  serviceId: string,
  input: UpdateProviderServiceInput,
  deps: CliDependencies
) {
  return requestJson<ProviderServiceRecord>(deps, `${apiUrl.replace(/\/$/, "")}/provider/services/${serviceId}`, {
    method: "PATCH",
    headers: {
      ...providerHeaders(accessToken),
      "content-type": "application/json"
    },
    body: JSON.stringify(input)
  });
}

async function fetchProviderService(
  apiUrl: string,
  accessToken: string,
  serviceId: string,
  deps: CliDependencies
) {
  return requestJson<ProviderServiceDetailRecord>(deps, `${apiUrl.replace(/\/$/, "")}/provider/services/${serviceId}`, {
    headers: providerHeaders(accessToken)
  });
}

async function fetchProviderRuntimeKey(
  apiUrl: string,
  accessToken: string,
  serviceId: string,
  deps: CliDependencies
) {
  return requestJson<ProviderRuntimeKeyResponse>(
    deps,
    `${apiUrl.replace(/\/$/, "")}/provider/services/${serviceId}/runtime-key`,
    {
      headers: providerHeaders(accessToken)
    }
  );
}

async function rotateProviderRuntimeKey(
  apiUrl: string,
  accessToken: string,
  serviceId: string,
  deps: CliDependencies
) {
  return requestJson<ProviderRuntimeKeyResponse>(
    deps,
    `${apiUrl.replace(/\/$/, "")}/provider/services/${serviceId}/runtime-key`,
    {
      method: "POST",
      headers: {
        ...providerHeaders(accessToken),
        "content-type": "application/json"
      },
      body: JSON.stringify({})
    }
  );
}

async function createProviderEndpoint(
  apiUrl: string,
  accessToken: string,
  serviceId: string,
  input: CreateProviderEndpointDraftInput,
  deps: CliDependencies
) {
  return requestJson<ProviderEndpointDraftRecord>(
    deps,
    `${apiUrl.replace(/\/$/, "")}/provider/services/${serviceId}/endpoints`,
    {
      method: "POST",
      headers: {
        ...providerHeaders(accessToken),
        "content-type": "application/json"
      },
      body: JSON.stringify(input)
    }
  );
}

async function updateProviderEndpoint(
  apiUrl: string,
  accessToken: string,
  serviceId: string,
  endpointId: string,
  input: UpdateProviderEndpointDraftInput,
  deps: CliDependencies
) {
  return requestJson<ProviderEndpointDraftRecord>(
    deps,
    `${apiUrl.replace(/\/$/, "")}/provider/services/${serviceId}/endpoints/${endpointId}`,
    {
      method: "PATCH",
      headers: {
        ...providerHeaders(accessToken),
        "content-type": "application/json"
      },
      body: JSON.stringify(input)
    }
  );
}

async function deleteProviderEndpoint(
  apiUrl: string,
  accessToken: string,
  serviceId: string,
  endpointId: string,
  deps: CliDependencies
) {
  return requestJson<void>(
    deps,
    `${apiUrl.replace(/\/$/, "")}/provider/services/${serviceId}/endpoints/${endpointId}`,
    {
      method: "DELETE",
      headers: providerHeaders(accessToken)
    }
  );
}

async function createVerificationChallenge(
  apiUrl: string,
  accessToken: string,
  serviceId: string,
  deps: CliDependencies
) {
  return requestJson<ProviderVerificationChallengeResponse>(
    deps,
    `${apiUrl.replace(/\/$/, "")}/provider/services/${serviceId}/verification-challenge`,
    {
      method: "POST",
      headers: providerHeaders(accessToken)
    }
  );
}

async function verifyServiceOwnership(
  apiUrl: string,
  accessToken: string,
  serviceId: string,
  deps: CliDependencies
) {
  return requestJson<ProviderVerificationRecord>(
    deps,
    `${apiUrl.replace(/\/$/, "")}/provider/services/${serviceId}/verify`,
    {
      method: "POST",
      headers: providerHeaders(accessToken)
    }
  );
}

async function submitProviderDraft(
  apiUrl: string,
  accessToken: string,
  serviceId: string,
  deps: CliDependencies
) {
  return requestJson<ProviderServiceDetailRecord>(
    deps,
    `${apiUrl.replace(/\/$/, "")}/provider/services/${serviceId}/submit`,
    {
      method: "POST",
      headers: providerHeaders(accessToken)
    }
  );
}

function buildServicePayload(spec: ProviderSyncSpec, walletAddress: string): CreateProviderServiceInput {
  return {
    ...spec.service,
    apiNamespace: spec.service.serviceType === "marketplace_proxy" ? spec.service.apiNamespace ?? null : null,
    payoutWallet: spec.service.serviceType === "marketplace_proxy"
      ? normalizeFastWalletAddress(spec.service.payoutWallet ?? walletAddress)
      : null
  };
}

async function syncExistingProviderService(
  apiUrl: string,
  accessToken: string,
  serviceId: string,
  input: UpdateProviderServiceInput,
  deps: CliDependencies
) {
  const existingDetail = await fetchProviderService(apiUrl, accessToken, serviceId, deps);
  let resetState: { deleted: string[]; endpoints: ProviderEndpointDraftRecord[] } = {
    deleted: [],
    endpoints: []
  };
  try {
    await resetEndpointsBeforeServiceUpdate(apiUrl, accessToken, existingDetail, input, deps, resetState);
    await updateProviderService(apiUrl, accessToken, serviceId, input, deps);
  } catch (error) {
    if (resetState.endpoints.length > 0) {
      await rollbackEndpointReset(apiUrl, accessToken, serviceId, resetState.endpoints, deps, error);
    }
    throw error;
  }

  return {
    detail: await fetchProviderService(apiUrl, accessToken, serviceId, deps),
    resetDeleted: resetState.deleted
  };
}

async function resetEndpointsBeforeServiceUpdate(
  apiUrl: string,
  accessToken: string,
  detail: ProviderServiceDetailRecord,
  input: UpdateProviderServiceInput,
  deps: CliDependencies,
  state: { deleted: string[]; endpoints: ProviderEndpointDraftRecord[] }
) {
  if (!requiresEndpointResetBeforeServiceUpdate(detail, input)) {
    return;
  }

  ensureEndpointResetCanRollback(detail);

  for (const endpoint of detail.endpoints) {
    const key = draftEndpointKey(endpoint);
    if (!key) {
      continue;
    }

    await deleteProviderEndpoint(apiUrl, accessToken, detail.service.id, endpoint.id, deps);
    state.deleted.push(key);
    state.endpoints.push(endpoint);
  }
}

async function rollbackEndpointReset(
  apiUrl: string,
  accessToken: string,
  serviceId: string,
  deletedEndpoints: ProviderEndpointDraftRecord[],
  deps: CliDependencies,
  originalError: unknown
) {
  try {
    for (const endpoint of deletedEndpoints) {
      await createProviderEndpoint(
        apiUrl,
        accessToken,
        serviceId,
        buildEndpointCreatePayloadFromDraft(endpoint),
        deps
      );
    }
  } catch (rollbackError) {
    const originalMessage = originalError instanceof Error ? originalError.message : String(originalError);
    const rollbackMessage = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
    throw new Error(
      `Provider sync failed after resetting endpoint drafts and rollback also failed. Update error: ${originalMessage}. Rollback error: ${rollbackMessage}`
    );
  }
}

function requiresEndpointResetBeforeServiceUpdate(
  detail: ProviderServiceDetailRecord,
  input: UpdateProviderServiceInput
) {
  const nextServiceType = input.serviceType ?? detail.service.serviceType;
  const nextApiNamespace = input.apiNamespace === undefined ? detail.service.apiNamespace : input.apiNamespace;
  return nextServiceType === "marketplace_proxy"
    && nextApiNamespace !== null
    && nextApiNamespace !== detail.service.apiNamespace
    && detail.endpoints.length > 0;
}

function ensureEndpointResetCanRollback(detail: ProviderServiceDetailRecord) {
  const secretBackedEndpoint = detail.endpoints.find(
    (endpoint) => endpoint.endpointType === "marketplace_proxy" && endpoint.hasUpstreamSecret
  );
  if (!secretBackedEndpoint) {
    return;
  }

  throw new Error(
    `Cannot automatically change apiNamespace for service ${detail.service.slug} because endpoint ${secretBackedEndpoint.operation} uses a stored upstream secret that cannot be restored from provider detail responses.`
  );
}

async function ensureRuntimeKey(
  apiUrl: string,
  accessToken: string,
  detail: ProviderServiceDetailRecord,
  deps: CliDependencies
) {
  if (detail.service.serviceType !== "marketplace_proxy") {
    return {
      created: false,
      keyPrefix: null as string | null
    };
  }

  const runtimeKey = await fetchProviderRuntimeKey(apiUrl, accessToken, detail.service.id, deps);
  if (runtimeKey.runtimeKey) {
    return {
      created: false,
      keyPrefix: runtimeKey.runtimeKey.keyPrefix
    };
  }

  const created = await rotateProviderRuntimeKey(apiUrl, accessToken, detail.service.id, deps);
  return {
    created: true,
    keyPrefix: created.runtimeKey?.keyPrefix ?? null,
    plaintextKey: created.plaintextKey
  };
}

async function reconcileEndpointDrafts(input: {
  apiUrl: string;
  accessToken: string;
  detail: ProviderServiceDetailRecord;
  spec: ProviderSyncSpec;
  deps: CliDependencies;
}) {
  const desiredByKey = new Map(
    input.spec.endpoints.map((endpoint) => [specEndpointKey(endpoint), endpoint] as const)
  );
  const created: string[] = [];
  const updated: string[] = [];
  const deleted: string[] = [];

  for (const endpoint of input.detail.endpoints) {
    const key = draftEndpointKey(endpoint);
    if (!key) {
      continue;
    }

    const desired = desiredByKey.get(key);
    if (!desired) {
      await deleteProviderEndpoint(
        input.apiUrl,
        input.accessToken,
        input.detail.service.id,
        endpoint.id,
        input.deps
      );
      deleted.push(key);
      continue;
    }

    await updateProviderEndpoint(
      input.apiUrl,
      input.accessToken,
      input.detail.service.id,
      endpoint.id,
      buildEndpointUpdatePayload(desired),
      input.deps
    );
    updated.push(key);
    desiredByKey.delete(key);
  }

  for (const [key, endpoint] of desiredByKey) {
    await createProviderEndpoint(
      input.apiUrl,
      input.accessToken,
      input.detail.service.id,
      buildEndpointCreatePayload(endpoint),
      input.deps
    );
    created.push(key);
  }

  return {
    created,
    updated,
    deleted
  };
}

function specEndpointKey(endpoint: ProviderSyncSpec["endpoints"][number]) {
  return endpoint.endpointType === "marketplace_proxy"
    ? `marketplace:${endpoint.operation}`
    : `external:${endpoint.publicUrl}`;
}

function draftEndpointKey(endpoint: ProviderEndpointDraftRecord) {
  if (endpoint.endpointType === "marketplace_proxy") {
    return `marketplace:${endpoint.operation}`;
  }

  return `external:${endpoint.publicUrl}`;
}

function buildEndpointCreatePayload(endpoint: ProviderSyncSpec["endpoints"][number]): CreateProviderEndpointDraftInput {
  if (endpoint.endpointType === "marketplace_proxy") {
    return {
      endpointType: "marketplace_proxy",
      operation: endpoint.operation,
      method: endpoint.method,
      title: endpoint.title,
      description: endpoint.description,
      billingType: endpoint.billingType,
      ...(endpoint.price ? { price: endpoint.price } : {}),
      minAmount: endpoint.minAmount,
      maxAmount: endpoint.maxAmount,
      mode: endpoint.mode,
      asyncStrategy: endpoint.asyncStrategy,
      asyncTimeoutMs: endpoint.asyncTimeoutMs,
      pollPath: endpoint.pollPath,
      requestSchemaJson: endpoint.requestSchemaJson,
      responseSchemaJson: endpoint.responseSchemaJson,
      requestExample: endpoint.requestExample,
      responseExample: endpoint.responseExample,
      usageNotes: endpoint.usageNotes,
      upstreamBaseUrl: endpoint.upstreamBaseUrl,
      upstreamPath: endpoint.upstreamPath,
      upstreamAuthMode: endpoint.upstreamAuthMode,
      upstreamAuthHeaderName: endpoint.upstreamAuthHeaderName,
      upstreamSecret: endpoint.upstreamSecret
    };
  }

  return {
    endpointType: "external_registry",
    title: endpoint.title,
    description: endpoint.description,
    method: endpoint.method,
    publicUrl: endpoint.publicUrl,
    docsUrl: endpoint.docsUrl,
    authNotes: endpoint.authNotes,
    requestExample: endpoint.requestExample,
    responseExample: endpoint.responseExample,
    usageNotes: endpoint.usageNotes
  };
}

function buildEndpointCreatePayloadFromDraft(endpoint: ProviderEndpointDraftRecord): CreateProviderEndpointDraftInput {
  if (endpoint.endpointType === "marketplace_proxy") {
    return {
      endpointType: "marketplace_proxy",
      operation: endpoint.operation,
      method: endpoint.method,
      title: endpoint.title,
      description: endpoint.description,
      billingType: endpoint.billing.type,
      ...(endpoint.billing.type === "fixed_x402" ? { price: endpoint.billing.price } : {}),
      minAmount: endpoint.billing.type === "topup_x402_variable" ? endpoint.billing.minAmount : null,
      maxAmount: endpoint.billing.type === "topup_x402_variable" ? endpoint.billing.maxAmount : null,
      mode: endpoint.mode,
      asyncStrategy: endpoint.asyncConfig?.strategy ?? null,
      asyncTimeoutMs: endpoint.asyncConfig?.timeoutMs ?? null,
      pollPath: endpoint.asyncConfig?.pollPath ?? null,
      requestSchemaJson: endpoint.requestSchemaJson,
      responseSchemaJson: endpoint.responseSchemaJson,
      requestExample: endpoint.requestExample,
      responseExample: endpoint.responseExample,
      usageNotes: endpoint.usageNotes,
      upstreamBaseUrl: endpoint.upstreamBaseUrl,
      upstreamPath: endpoint.upstreamPath,
      upstreamAuthMode: endpoint.upstreamAuthMode,
      upstreamAuthHeaderName: endpoint.upstreamAuthHeaderName
    };
  }

  return {
    endpointType: "external_registry",
    title: endpoint.title,
    description: endpoint.description,
    method: endpoint.method,
    publicUrl: endpoint.publicUrl,
    docsUrl: endpoint.docsUrl,
    authNotes: endpoint.authNotes,
    requestExample: endpoint.requestExample,
    responseExample: endpoint.responseExample,
    usageNotes: endpoint.usageNotes
  };
}

function buildEndpointUpdatePayload(endpoint: ProviderSyncSpec["endpoints"][number]): UpdateProviderEndpointDraftInput {
  if (endpoint.endpointType === "marketplace_proxy") {
    return {
      endpointType: "marketplace_proxy",
      operation: endpoint.operation,
      method: endpoint.method,
      title: endpoint.title,
      description: endpoint.description,
      billingType: endpoint.billingType,
      ...(endpoint.price ? { price: endpoint.price } : {}),
      minAmount: endpoint.minAmount,
      maxAmount: endpoint.maxAmount,
      requestSchemaJson: endpoint.requestSchemaJson,
      responseSchemaJson: endpoint.responseSchemaJson,
      requestExample: endpoint.requestExample,
      responseExample: endpoint.responseExample,
      usageNotes: endpoint.usageNotes,
      upstreamBaseUrl: endpoint.upstreamBaseUrl,
      upstreamPath: endpoint.upstreamPath,
      upstreamAuthMode: endpoint.upstreamAuthMode,
      upstreamAuthHeaderName: endpoint.upstreamAuthHeaderName,
      upstreamSecret: endpoint.upstreamSecret
    };
  }

  return {
    endpointType: "external_registry",
    title: endpoint.title,
    description: endpoint.description,
    method: endpoint.method,
    publicUrl: endpoint.publicUrl,
    docsUrl: endpoint.docsUrl,
    authNotes: endpoint.authNotes,
    requestExample: endpoint.requestExample,
    responseExample: endpoint.responseExample,
    usageNotes: endpoint.usageNotes
  };
}

function verificationInstructions(challenge: ProviderVerificationChallengeResponse): string[] {
  return [
    `Host the exact token at ${challenge.expectedUrl}.`,
    `Token: ${challenge.token}`,
    "Only confirm verification after the deployed website serves that token over HTTPS."
  ];
}

function isVerificationReady(detail: ProviderServiceDetailRecord): boolean {
  if (!detail.service.websiteUrl || !detail.verification || detail.verification.status !== "verified") {
    return false;
  }

  return new URL(detail.service.websiteUrl).hostname === detail.verification.verifiedHost;
}

function summarizeService(detail: ProviderServiceDetailRecord) {
  return {
    id: detail.service.id,
    slug: detail.service.slug,
    status: detail.service.status,
    serviceType: detail.service.serviceType,
    settlementMode: detail.service.settlementMode
  };
}

function summarizeVerification(verification: ProviderVerificationRecord | null) {
  if (!verification) {
    return null;
  }

  return {
    status: verification.status,
    verifiedHost: verification.verifiedHost,
    failureReason: verification.failureReason
  };
}

function extractVerificationRecord(body: unknown): ProviderVerificationRecord | null {
  if (!body || typeof body !== "object" || !("verification" in body)) {
    return null;
  }

  return body.verification as ProviderVerificationRecord | null;
}
