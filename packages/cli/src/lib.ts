import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { stderr, stdin as input } from "node:process";
import { createInterface } from "node:readline/promises";

import { getPublicKeyAsync } from "@noble/ed25519";
import { FastProvider, FastWallet, encodeFastAddress } from "@fastxyz/sdk";
import { x402Pay } from "@fastxyz/x402-client";
import {
  PAYMENT_IDENTIFIER_HEADER,
  buildRouteRef,
  createOpaqueToken,
  decimalToRawString,
  normalizeFastWalletAddress,
  rawToDecimalString,
  resolveMarketplaceNetworkConfig,
  serializeQueryInput,
  validateJsonSchema,
  type CatalogSearchFilters,
  type CatalogSearchResult,
  type HttpMethod,
  type JsonSchema,
  type MarketplaceRouteDetail,
  type MarketplaceDeploymentNetwork,
  type ServiceDetail
} from "@marketplace/shared";

export interface CliConfig {
  defaultKeyfile?: string;
  defaultNetwork?: MarketplaceDeploymentNetwork;
  spendControls?: {
    maxPerCallRaw?: string;
    dailyCapRaw?: string;
    allowlist?: string[];
    manualApprovalAboveRaw?: string;
  };
  spendLedger?: {
    day: string;
    spentRaw: string;
  };
}

export interface LoadedWallet {
  keyfilePath: string;
  wallet: FastWallet;
  paymentWallet: {
    type: "fast";
    privateKey: string;
    publicKey: string;
    address: string;
    rpcUrl: string;
  };
}

export interface MarketplaceChallenge {
  wallet: string;
  resourceType: "job" | "api";
  resourceId: string;
  nonce: string;
  expiresAt: string;
  message: string;
}

export interface CliDependencies {
  fetchImpl: typeof fetch;
  confirm(message: string): Promise<boolean>;
  now(): Date;
  print(message: string): void;
  error(message: string): void;
}

interface PublishedRouteCatalogEntry {
  ref: string;
  routeId: string;
  provider: string;
  operation: string;
  method: HttpMethod;
  requestSchemaJson: JsonSchema;
  authRequirement: MarketplaceRouteDetail["authRequirement"];
}

export interface UseRouteResult {
  ref: string;
  statusCode: number;
  body: unknown;
  authFlow: "x402" | "wallet_session" | "none";
  jobToken: string | null;
}

const DEFAULT_CONFIG_PATH = "~/.fast-marketplace/config.json";
const DEFAULT_KEYFILE_PATH = "~/.fast/keys/default.json";

export function normalizePrivateKeyHex(privateKey: string): string {
  const normalized = privateKey.startsWith("0x") ? privateKey.slice(2) : privateKey;
  if (!/^[0-9a-fA-F]{64}$/.test(normalized)) {
    throw new Error("Fast private key must be a 32-byte hex string.");
  }

  return normalized.toLowerCase();
}

export function defaultCliDependencies(): CliDependencies {
  return {
    fetchImpl: fetch,
    async confirm(message: string) {
      const rl = createInterface({ input, output: stderr });
      try {
        const answer = await rl.question(`${message} [y/N] `);
        return answer.trim().toLowerCase() === "y";
      } finally {
        rl.close();
      }
    },
    now: () => new Date(),
    print: (message) => {
      console.log(message);
    },
    error: (message) => {
      console.error(message);
    }
  };
}

export function expandHome(filePath: string): string {
  if (filePath.startsWith("~/")) {
    return resolve(homedir(), filePath.slice(2));
  }

  if (filePath === "~") {
    return homedir();
  }

  return resolve(filePath);
}

export async function readCliConfig(configPath = DEFAULT_CONFIG_PATH): Promise<CliConfig> {
  const resolved = expandHome(configPath);
  try {
    const raw = await readFile(resolved, "utf8");
    return JSON.parse(raw) as CliConfig;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("ENOENT")) {
      return {};
    }

    throw error;
  }
}

export async function writeCliConfig(config: CliConfig, configPath = DEFAULT_CONFIG_PATH): Promise<void> {
  const resolved = expandHome(configPath);
  await mkdir(dirname(resolved), { recursive: true });
  await writeFile(resolved, JSON.stringify(config, null, 2), "utf8");
}

export async function initializeWallet(input: {
  keyfilePath?: string;
  configPath?: string;
  network?: MarketplaceDeploymentNetwork;
  rpcUrl?: string;
}): Promise<{ keyfilePath: string; address: string }> {
  const keyfilePath = expandHome(input.keyfilePath ?? DEFAULT_KEYFILE_PATH);
  const provider = createProvider({
    deploymentNetwork: input.network,
    rpcUrl: input.rpcUrl
  });
  const wallet = await FastWallet.generate(provider);
  await wallet.saveToKeyfile(keyfilePath);

  const config = await readCliConfig(input.configPath);
  config.defaultKeyfile = keyfilePath;
  config.defaultNetwork = input.network ?? config.defaultNetwork ?? "mainnet";
  await writeCliConfig(config, input.configPath);

  return {
    keyfilePath,
    address: wallet.address
  };
}

export async function setSpendControls(input: {
  configPath?: string;
  maxPerCall?: string;
  dailyCap?: string;
  allowlist?: string[];
  manualApprovalAbove?: string;
}): Promise<CliConfig> {
  const config = await readCliConfig(input.configPath);
  config.spendControls = {
    maxPerCallRaw: input.maxPerCall ? decimalToRawString(input.maxPerCall, 6) : config.spendControls?.maxPerCallRaw,
    dailyCapRaw: input.dailyCap ? decimalToRawString(input.dailyCap, 6) : config.spendControls?.dailyCapRaw,
    allowlist: input.allowlist ?? config.spendControls?.allowlist,
    manualApprovalAboveRaw: input.manualApprovalAbove
      ? decimalToRawString(input.manualApprovalAbove, 6)
      : config.spendControls?.manualApprovalAboveRaw
  };
  await writeCliConfig(config, input.configPath);
  return config;
}

export async function loadWallet(input: {
  privateKey?: string;
  keyfilePath?: string;
  configPath?: string;
  network?: MarketplaceDeploymentNetwork;
  rpcUrl?: string;
}): Promise<LoadedWallet> {
  if (input.privateKey) {
    return loadWalletFromPrivateKey({
      privateKey: input.privateKey,
      sourceLabel: "env:FAST_PRIVATE_KEY",
      configPath: input.configPath,
      network: input.network,
      rpcUrl: input.rpcUrl
    });
  }

  const config = await readCliConfig(input.configPath);
  const keyfilePath = expandHome(input.keyfilePath ?? config.defaultKeyfile ?? DEFAULT_KEYFILE_PATH);
  const keyfile = JSON.parse(await readFile(keyfilePath, "utf8")) as {
    privateKey: string;
  };

  const privateKey = keyfile.privateKey;
  if (!privateKey) {
    throw new Error(`Keyfile is missing privateKey: ${keyfilePath}`);
  }

  return loadWalletFromPrivateKey({
    privateKey,
    sourceLabel: keyfilePath,
    configPath: input.configPath,
    network: input.network,
    rpcUrl: input.rpcUrl
  });
}

export async function loadWalletFromPrivateKey(input: {
  privateKey: string;
  sourceLabel?: string;
  configPath?: string;
  network?: MarketplaceDeploymentNetwork;
  rpcUrl?: string;
}): Promise<LoadedWallet> {
  const config = await readCliConfig(input.configPath);
  const network = resolveCliNetwork(input.network, config.defaultNetwork, input.rpcUrl);
  const privateKey = normalizePrivateKeyHex(input.privateKey);
  const publicKey = Buffer.from(await getPublicKeyAsync(Buffer.from(privateKey, "hex"))).toString("hex");
  const address = encodeFastAddress(Buffer.from(publicKey, "hex"));
  const provider = createProvider({
    deploymentNetwork: network.deploymentNetwork,
    rpcUrl: network.rpcUrl
  });
  const wallet = await FastWallet.fromPrivateKey(privateKey, provider);

  return {
    keyfilePath: input.sourceLabel ?? "env:private-key",
    wallet,
    paymentWallet: {
      type: "fast",
      privateKey,
      publicKey,
      address: normalizeFastWalletAddress(address),
      rpcUrl: network.rpcUrl
    }
  };
}

export async function walletAddress(input: {
  privateKey?: string;
  keyfilePath?: string;
  configPath?: string;
  network?: MarketplaceDeploymentNetwork;
  rpcUrl?: string;
}) {
  const loaded = await loadWallet(input);
  return {
    address: loaded.paymentWallet.address,
    keyfilePath: loaded.keyfilePath
  };
}

export async function walletBalance(input: {
  token?: string;
  privateKey?: string;
  keyfilePath?: string;
  configPath?: string;
  network?: MarketplaceDeploymentNetwork;
  rpcUrl?: string;
}) {
  const config = await readCliConfig(input.configPath);
  const loaded = await loadWallet(input);
  const network = resolveCliNetwork(input.network, config.defaultNetwork, input.rpcUrl);
  return loaded.wallet.balance(input.token ?? network.tokenSymbol);
}

export async function searchMarketplace(
  input: {
    apiUrl: string;
    q?: string;
    category?: string;
    billingType?: CatalogSearchFilters["billingType"];
    mode?: CatalogSearchFilters["mode"];
    settlementMode?: CatalogSearchFilters["settlementMode"];
    limit?: number;
  },
  deps: CliDependencies = defaultCliDependencies()
): Promise<{ results: CatalogSearchResult[] }> {
  return fetchMarketplaceJson<{ results: CatalogSearchResult[] }>(
    deps,
    buildSearchRequestUrl(input.apiUrl, input)
  );
}

export async function showMarketplaceItem(
  input: {
    apiUrl: string;
    ref: string;
  },
  deps: CliDependencies = defaultCliDependencies()
): Promise<ServiceDetail | MarketplaceRouteDetail> {
  const routeRef = parseRouteRef(input.ref);
  if (routeRef) {
    return fetchRouteDetail(input.apiUrl, routeRef.provider, routeRef.operation, deps);
  }

  return fetchServiceDetail(input.apiUrl, input.ref, deps);
}

export async function useMarketplaceRoute(
  input: {
    apiUrl: string;
    ref: string;
    body: unknown;
    privateKey?: string;
    keyfilePath?: string;
    configPath?: string;
    network?: MarketplaceDeploymentNetwork;
    rpcUrl?: string;
    autoApproveExpensive?: boolean;
    verbose?: boolean;
  },
  deps: CliDependencies = defaultCliDependencies()
): Promise<UseRouteResult> {
  const routeRef = parseRouteRef(input.ref);
  if (!routeRef) {
    throw new Error(`Route ref must use provider.operation: ${input.ref}`);
  }

  return invokePaidRoute(
    {
      apiUrl: input.apiUrl,
      provider: routeRef.provider,
      operation: routeRef.operation,
      body: input.body,
      privateKey: input.privateKey,
      keyfilePath: input.keyfilePath,
      configPath: input.configPath,
      network: input.network,
      rpcUrl: input.rpcUrl,
      autoApproveExpensive: input.autoApproveExpensive,
      verbose: input.verbose
    },
    deps
  );
}

export async function invokePaidRoute(
  input: {
    apiUrl: string;
    provider: string;
    operation: string;
    body: unknown;
    privateKey?: string;
    keyfilePath?: string;
    configPath?: string;
    network?: MarketplaceDeploymentNetwork;
    rpcUrl?: string;
    autoApproveExpensive?: boolean;
    verbose?: boolean;
  },
  deps: CliDependencies = defaultCliDependencies()
): Promise<UseRouteResult> {
  const route = await resolvePublishedRoute(input.apiUrl, input.provider, input.operation, deps);
  const requestTarget = buildInvocationTarget({
    apiUrl: input.apiUrl,
    provider: input.provider,
    operation: input.operation,
    method: route.method,
    requestSchemaJson: route.requestSchemaJson,
    body: input.body
  });

  if (route.authRequirement.type === "wallet_session") {
    const session = await createScopedSession(
      {
        apiUrl: input.apiUrl,
        resourceType: "api",
        resourceId: route.routeId,
        privateKey: input.privateKey,
        keyfilePath: input.keyfilePath,
        configPath: input.configPath,
        network: input.network,
        rpcUrl: input.rpcUrl
      },
      deps
    );

    const response = await deps.fetchImpl(
      requestTarget.url,
      buildInvocationInit(route.method, {
        authorization: `Bearer ${session.accessToken}`
      }, requestTarget.body)
    );

    return buildUseRouteResult(route.ref, response.status, await safeJson(response), "wallet_session");
  }

  if (route.authRequirement.type === "none") {
    const response = await deps.fetchImpl(
      requestTarget.url,
      buildInvocationInit(route.method, {}, requestTarget.body)
    );

    return buildUseRouteResult(route.ref, response.status, await safeJson(response), "none");
  }

  const config = await readCliConfig(input.configPath);
  const network = resolveCliNetwork(input.network, config.defaultNetwork, input.rpcUrl);
  const loaded = await loadWallet(input);
  const paymentId = createOpaqueToken("payment");
  const headers = buildClientHeaders(config, paymentId);
  const preflight = await deps.fetchImpl(requestTarget.url, buildInvocationInit(route.method, headers, requestTarget.body));
  if (preflight.status !== 402) {
    return buildUseRouteResult(route.ref, preflight.status, await safeJson(preflight), "x402");
  }

  const paymentRequired = await preflight.json() as {
    accepts?: Array<{ maxAmountRequired: string }>;
  };
  const maxAmountRequired = paymentRequired.accepts?.[0]?.maxAmountRequired;
  if (!maxAmountRequired) {
    throw new Error("Marketplace did not return a usable payment requirement.");
  }
  const amountRaw = decimalToRawString(maxAmountRequired, 6);

  await enforceSpendControls({
    routeKey: route.ref,
    amountRaw,
    tokenSymbol: network.tokenSymbol,
    config,
    deps,
    autoApproveExpensive: input.autoApproveExpensive ?? false
  });

  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (...args) => normalizeMarketplacePaymentRequirement(await deps.fetchImpl(...args));

  let result: {
    success: boolean;
    statusCode: number;
    body: unknown;
  };
  try {
    result = await x402Pay({
      url: requestTarget.url,
      method: route.method,
      ...(requestTarget.body ? { body: requestTarget.body } : {}),
      headers: {
        ...headers
      },
      wallet: loaded.paymentWallet,
      verbose: input.verbose
    }) as {
      success: boolean;
      statusCode: number;
      body: unknown;
    };
  } finally {
    globalThis.fetch = previousFetch;
  }

  if (result.success) {
    await recordSpend(config, amountRaw, input.configPath, deps.now());
  }

  return buildUseRouteResult(route.ref, result.statusCode, result.body, "x402");
}

async function resolvePublishedRoute(
  apiUrl: string,
  provider: string,
  operation: string,
  deps: CliDependencies
): Promise<PublishedRouteCatalogEntry> {
  const route = await fetchRouteDetail(apiUrl, provider, operation, deps);
  if (route.method !== "GET" && route.method !== "POST") {
    throw new Error(`Published route metadata not found for ${provider}.${operation}.`);
  }

  return {
    ref: route.ref,
    routeId: route.routeId,
    provider: route.provider,
    operation: route.operation,
    method: route.method,
    requestSchemaJson: route.requestSchemaJson,
    authRequirement: route.authRequirement
  };
}

function buildInvocationTarget(input: {
  apiUrl: string;
  provider: string;
  operation: string;
  method: HttpMethod;
  requestSchemaJson: JsonSchema;
  body: unknown;
}): { url: string; body?: string } {
  const baseUrl = `${input.apiUrl.replace(/\/$/, "")}/api/${input.provider}/${input.operation}`;
  if (input.method === "GET") {
    return {
      url: `${baseUrl}${serializeQueryInput({
        schema: input.requestSchemaJson,
        value: input.body,
        label: `${input.provider}.${input.operation} GET input`
      })}`
    };
  }

  validateJsonSchema({
    schema: input.requestSchemaJson,
    value: input.body,
    label: `${buildRouteRef({ provider: input.provider, operation: input.operation })} POST input`
  });

  return {
    url: baseUrl,
    body: JSON.stringify(input.body)
  };
}

function buildInvocationInit(
  method: HttpMethod,
  headers: Record<string, string>,
  body?: string
): RequestInit {
  if (method === "GET") {
    return {
      method,
      headers
    };
  }

  return {
    method,
    headers: {
      "content-type": "application/json",
      ...headers
    },
    body
  };
}

function buildSearchRequestUrl(
  apiUrl: string,
  filters: {
    q?: string;
    category?: string;
    billingType?: CatalogSearchFilters["billingType"];
    mode?: CatalogSearchFilters["mode"];
    settlementMode?: CatalogSearchFilters["settlementMode"];
    limit?: number;
  }
): string {
  const params = new URLSearchParams();
  if (filters.q) {
    params.set("q", filters.q);
  }
  if (filters.category) {
    params.set("category", filters.category);
  }
  if (filters.billingType) {
    params.set("billingType", filters.billingType);
  }
  if (filters.mode) {
    params.set("mode", filters.mode);
  }
  if (filters.settlementMode) {
    params.set("settlementMode", filters.settlementMode);
  }
  if (typeof filters.limit === "number") {
    params.set("limit", String(filters.limit));
  }

  const baseUrl = `${apiUrl.replace(/\/$/, "")}/catalog/search`;
  const query = params.toString();
  return query ? `${baseUrl}?${query}` : baseUrl;
}

function parseRouteRef(ref: string): { provider: string; operation: string } | null {
  const [provider, operation, extra] = ref.split(".");
  if (!provider || !operation || extra) {
    return null;
  }

  return { provider, operation };
}

async function fetchMarketplaceJson<T>(deps: CliDependencies, url: string): Promise<T> {
  const response = await deps.fetchImpl(url);
  if (!response.ok) {
    const body = await safeJson(response);
    const message = typeof body === "string"
      ? body
      : typeof body === "object" && body && "error" in body && typeof body.error === "string"
        ? body.error
        : `Marketplace request failed with status ${response.status}`;
    throw new Error(message);
  }

  return await response.json() as T;
}

async function fetchServiceDetail(apiUrl: string, slug: string, deps: CliDependencies): Promise<ServiceDetail> {
  return fetchMarketplaceJson<ServiceDetail>(
    deps,
    `${apiUrl.replace(/\/$/, "")}/catalog/services/${encodeURIComponent(slug)}`
  );
}

async function fetchRouteDetail(
  apiUrl: string,
  provider: string,
  operation: string,
  deps: CliDependencies
): Promise<MarketplaceRouteDetail> {
  return fetchMarketplaceJson<MarketplaceRouteDetail>(
    deps,
    `${apiUrl.replace(/\/$/, "")}/catalog/routes/${encodeURIComponent(provider)}/${encodeURIComponent(operation)}`
  );
}

function extractJobToken(body: unknown): string | null {
  if (!body || typeof body !== "object") {
    return null;
  }

  return typeof (body as { jobToken?: unknown }).jobToken === "string"
    ? (body as { jobToken: string }).jobToken
    : null;
}

function buildUseRouteResult(
  ref: string,
  statusCode: number,
  body: unknown,
  authFlow: UseRouteResult["authFlow"]
): UseRouteResult {
  return {
    ref,
    statusCode,
    body,
    authFlow,
    jobToken: extractJobToken(body)
  };
}

export async function fetchJobResult(
  input: {
    apiUrl: string;
    jobToken: string;
    privateKey?: string;
    keyfilePath?: string;
    configPath?: string;
    network?: MarketplaceDeploymentNetwork;
    rpcUrl?: string;
  },
  deps: CliDependencies = defaultCliDependencies()
) {
  const session = await createScopedSession(
    {
      apiUrl: input.apiUrl,
      resourceType: "job",
      resourceId: input.jobToken,
      privateKey: input.privateKey,
      keyfilePath: input.keyfilePath,
      configPath: input.configPath,
      network: input.network,
      rpcUrl: input.rpcUrl
    },
    deps
  );

  const jobResponse = await deps.fetchImpl(`${input.apiUrl.replace(/\/$/, "")}/api/jobs/${input.jobToken}`, {
    headers: {
      authorization: `Bearer ${session.accessToken}`
    }
  });

  return {
    statusCode: jobResponse.status,
    body: await safeJson(jobResponse)
  };
}

export async function createApiSession(
  input: {
    apiUrl: string;
    provider: string;
    operation: string;
    privateKey?: string;
    keyfilePath?: string;
    configPath?: string;
    network?: MarketplaceDeploymentNetwork;
    rpcUrl?: string;
  },
  deps: CliDependencies = defaultCliDependencies()
) {
  const route = await fetchRouteDetail(input.apiUrl, input.provider, input.operation, deps);
  return createScopedSession(
    {
      apiUrl: input.apiUrl,
      resourceType: "api",
      resourceId: route.routeId,
      privateKey: input.privateKey,
      keyfilePath: input.keyfilePath,
      configPath: input.configPath,
      network: input.network,
      rpcUrl: input.rpcUrl
    },
    deps
  );
}

async function createScopedSession(
  input: {
    apiUrl: string;
    resourceType: "job" | "api";
    resourceId: string;
    privateKey?: string;
    keyfilePath?: string;
    configPath?: string;
    network?: MarketplaceDeploymentNetwork;
    rpcUrl?: string;
  },
  deps: CliDependencies = defaultCliDependencies()
) {
  const loaded = await loadWallet(input);
  const baseUrl = input.apiUrl.replace(/\/$/, "");
  const challengeResponse = await deps.fetchImpl(`${baseUrl}/auth/challenge`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      wallet: loaded.paymentWallet.address,
      resourceType: input.resourceType,
      resourceId: input.resourceId
    })
  });

  if (!challengeResponse.ok) {
    throw new Error(`Challenge request failed with status ${challengeResponse.status}`);
  }

  const challenge = await challengeResponse.json() as MarketplaceChallenge;
  const signed = await loaded.wallet.sign({ message: challenge.message });

  const sessionResponse = await deps.fetchImpl(`${baseUrl}/auth/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      wallet: loaded.paymentWallet.address,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      nonce: challenge.nonce,
      expiresAt: challenge.expiresAt,
      signature: signed.signature
    })
  });

  if (!sessionResponse.ok) {
    throw new Error(`Session request failed with status ${sessionResponse.status}`);
  }

  return await sessionResponse.json() as { accessToken: string; tokenType?: string };
}

async function enforceSpendControls(input: {
  routeKey: string;
  amountRaw: string;
  tokenSymbol: string;
  config: CliConfig;
  deps: CliDependencies;
  autoApproveExpensive: boolean;
}) {
  const controls = input.config.spendControls;
  if (!controls) {
    return;
  }

  if (controls.allowlist && controls.allowlist.length > 0 && !controls.allowlist.includes(input.routeKey)) {
    throw new Error(`Route ${input.routeKey} is not in the local allowlist.`);
  }

  if (controls.maxPerCallRaw && BigInt(input.amountRaw) > BigInt(controls.maxPerCallRaw)) {
    throw new Error(
      `Route price ${rawToDecimalString(input.amountRaw, 6)} exceeds max per call ${rawToDecimalString(
        controls.maxPerCallRaw,
        6
      )}.`
    );
  }

  const spendLedger = currentSpendLedger(input.config, input.deps.now());
  if (controls.dailyCapRaw && BigInt(spendLedger.spentRaw) + BigInt(input.amountRaw) > BigInt(controls.dailyCapRaw)) {
    throw new Error(
      `Daily cap ${rawToDecimalString(controls.dailyCapRaw, 6)} would be exceeded by this call.`
    );
  }

  if (controls.manualApprovalAboveRaw && BigInt(input.amountRaw) > BigInt(controls.manualApprovalAboveRaw)) {
    if (!input.autoApproveExpensive) {
      const approved = await input.deps.confirm(
        `Approve expensive call for ${rawToDecimalString(input.amountRaw, 6)} ${input.tokenSymbol} on ${input.routeKey}?`
      );
      if (!approved) {
        throw new Error("Manual approval rejected.");
      }
    }
  }
}

function buildClientHeaders(config: CliConfig, paymentId: string): Record<string, string> {
  return {
    [PAYMENT_IDENTIFIER_HEADER]: paymentId,
    ...(config.spendControls?.maxPerCallRaw
      ? { "X-MARKETPLACE-SPEND-MAX-PER-CALL": config.spendControls.maxPerCallRaw }
      : {}),
    ...(config.spendControls?.dailyCapRaw
      ? { "X-MARKETPLACE-SPEND-DAILY-CAP": config.spendControls.dailyCapRaw }
      : {}),
    ...(config.spendControls?.manualApprovalAboveRaw
      ? { "X-MARKETPLACE-SPEND-MANUAL-APPROVAL": config.spendControls.manualApprovalAboveRaw }
      : {})
  };
}

async function recordSpend(config: CliConfig, amountRaw: string, configPath: string | undefined, now: Date) {
  const ledger = currentSpendLedger(config, now);
  config.spendLedger = {
    day: ledger.day,
    spentRaw: (BigInt(ledger.spentRaw) + BigInt(amountRaw)).toString()
  };
  await writeCliConfig(config, configPath);
}

function currentSpendLedger(config: CliConfig, now: Date) {
  const day = now.toISOString().slice(0, 10);
  if (!config.spendLedger || config.spendLedger.day !== day) {
    return { day, spentRaw: "0" };
  }

  return config.spendLedger;
}

function resolveCliNetwork(
  deploymentNetwork?: MarketplaceDeploymentNetwork,
  fallbackNetwork?: MarketplaceDeploymentNetwork,
  rpcUrl?: string
) {
  return resolveMarketplaceNetworkConfig({
    deploymentNetwork: deploymentNetwork ?? fallbackNetwork ?? "mainnet",
    rpcUrl
  });
}

function createProvider(input: {
  deploymentNetwork?: MarketplaceDeploymentNetwork;
  rpcUrl?: string;
}) {
  const network = resolveMarketplaceNetworkConfig({
    deploymentNetwork: input.deploymentNetwork,
    rpcUrl: input.rpcUrl
  });
  return new FastProvider({
    network: network.deploymentNetwork,
    networks: {
      [network.deploymentNetwork]: {
        rpc: network.rpcUrl,
        explorer: network.explorerUrl
      }
    }
  });
}

async function normalizeMarketplacePaymentRequirement(response: Response): Promise<Response> {
  if (response.status !== 402) {
    return response;
  }

  let paymentRequired: {
    accepts?: Array<Record<string, unknown> & { maxAmountRequired?: string }>;
  };
  try {
    const responseForParsing =
      "clone" in response && typeof response.clone === "function" ? response.clone() : response;
    paymentRequired = await responseForParsing.json() as {
      accepts?: Array<Record<string, unknown> & { maxAmountRequired?: string }>;
    };
  } catch {
    return response;
  }

  if (!paymentRequired.accepts?.length) {
    return response;
  }

  return new Response(
    JSON.stringify({
      ...paymentRequired,
      accepts: paymentRequired.accepts.map((accept) => ({
        ...accept,
        ...(accept.maxAmountRequired
          ? { maxAmountRequired: decimalToRawString(accept.maxAmountRequired, 6) }
          : {})
      }))
    }),
    {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers
    }
  );
}

async function safeJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return await response.text();
  }
}
