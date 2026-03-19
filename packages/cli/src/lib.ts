import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";

import { getPublicKeyAsync } from "@noble/ed25519";
import { FastProvider, FastWallet, encodeFastAddress } from "@fastxyz/sdk";
import { x402Pay } from "@fastxyz/x402-client";
import {
  PAYMENT_IDENTIFIER_HEADER,
  createOpaqueToken,
  decimalToRawString,
  normalizeFastWalletAddress,
  rawToDecimalString,
  resolveMarketplaceNetworkConfig,
  type MarketplaceDeploymentNetwork
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

const DEFAULT_CONFIG_PATH = "~/.fast-marketplace/config.json";
const DEFAULT_KEYFILE_PATH = "~/.fast/keys/default.json";

export function defaultCliDependencies(): CliDependencies {
  return {
    fetchImpl: fetch,
    async confirm(message: string) {
      const rl = createInterface({ input, output });
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
  keyfilePath?: string;
  configPath?: string;
  network?: MarketplaceDeploymentNetwork;
  rpcUrl?: string;
}): Promise<LoadedWallet> {
  const config = await readCliConfig(input.configPath);
  const keyfilePath = expandHome(input.keyfilePath ?? config.defaultKeyfile ?? DEFAULT_KEYFILE_PATH);
  const network = resolveCliNetwork(input.network, config.defaultNetwork, input.rpcUrl);
  const keyfile = JSON.parse(await readFile(keyfilePath, "utf8")) as {
    privateKey: string;
    publicKey?: string;
    address?: string;
  };

  const privateKey = keyfile.privateKey;
  if (!privateKey) {
    throw new Error(`Keyfile is missing privateKey: ${keyfilePath}`);
  }

  const publicKey = keyfile.publicKey ?? Buffer.from(await getPublicKeyAsync(Buffer.from(privateKey, "hex"))).toString("hex");
  const address = keyfile.address ?? encodeFastAddress(Buffer.from(publicKey, "hex"));
  const provider = createProvider({
    deploymentNetwork: network.deploymentNetwork,
    rpcUrl: network.rpcUrl
  });
  const wallet = await FastWallet.fromPrivateKey(privateKey, provider);

  return {
    keyfilePath,
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

export async function invokePaidRoute(
  input: {
    apiUrl: string;
    provider: string;
    operation: string;
    body: unknown;
    keyfilePath?: string;
    configPath?: string;
    network?: MarketplaceDeploymentNetwork;
    rpcUrl?: string;
    autoApproveExpensive?: boolean;
    verbose?: boolean;
  },
  deps: CliDependencies = defaultCliDependencies()
) {
  const loaded = await loadWallet(input);
  const config = await readCliConfig(input.configPath);
  const network = resolveCliNetwork(input.network, config.defaultNetwork, input.rpcUrl);
  const endpoint = `${input.apiUrl.replace(/\/$/, "")}/api/${input.provider}/${input.operation}`;
  const routeKey = `${input.provider}.${input.operation}`;
  const paymentId = createOpaqueToken("payment");
  const bodyString = JSON.stringify(input.body);
  const headers = buildClientHeaders(config, paymentId);

  const preflight = await deps.fetchImpl(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...headers
    },
    body: bodyString
  });

  if (preflight.status === 401 || preflight.status === 403) {
    const routeId = `${input.provider}.${input.operation}.v1`;
    const session = await createScopedSession(
      {
        apiUrl: input.apiUrl,
        resourceType: "api",
        resourceId: routeId,
        keyfilePath: input.keyfilePath,
        configPath: input.configPath,
        network: input.network,
        rpcUrl: input.rpcUrl
      },
      deps
    );

    const response = await deps.fetchImpl(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${session.accessToken}`
      },
      body: bodyString
    });

    return {
      statusCode: response.status,
      body: await safeJson(response),
      note: "Request used wallet-session auth."
    };
  }

  if (preflight.status !== 402) {
    return {
      statusCode: preflight.status,
      body: await safeJson(preflight),
      note: "Request did not require payment."
    };
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
    routeKey,
    amountRaw,
    tokenSymbol: network.tokenSymbol,
    config,
    deps,
    autoApproveExpensive: input.autoApproveExpensive ?? false
  });

  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (...args) => normalizeMarketplacePaymentRequirement(await deps.fetchImpl(...args));

  let result;
  try {
    result = await x402Pay({
      url: endpoint,
      method: "POST",
      body: bodyString,
      headers: {
        "content-type": "application/json",
        ...headers
      },
      wallet: loaded.paymentWallet,
      verbose: input.verbose
    });
  } finally {
    globalThis.fetch = previousFetch;
  }

  if (result.success) {
    await recordSpend(config, amountRaw, input.configPath, deps.now());
  }

  return result;
}

export async function fetchJobResult(
  input: {
    apiUrl: string;
    jobToken: string;
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
    keyfilePath?: string;
    configPath?: string;
    network?: MarketplaceDeploymentNetwork;
    rpcUrl?: string;
  },
  deps: CliDependencies = defaultCliDependencies()
) {
  return createScopedSession(
    {
      apiUrl: input.apiUrl,
      resourceType: "api",
      resourceId: `${input.provider}.${input.operation}.v1`,
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
