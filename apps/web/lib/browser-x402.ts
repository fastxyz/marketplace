import type { WebDeploymentNetwork } from "@/lib/network";

export interface BrowserPaymentRequirement {
  scheme: string;
  network: string;
  maxAmountRequired: string;
  payTo: string;
  asset?: string;
}

export interface BrowserPaymentRequired {
  x402Version?: number;
  accepts?: BrowserPaymentRequirement[];
}

export interface BrowserX402Result {
  paymentId: string;
  paymentRequirement: BrowserPaymentRequirement | null;
}

export interface BrowserConnectorLike {
  connect(): Promise<boolean>;
  exportKeys(): Promise<{ address: string; publicKey: string }>;
  getActiveNetwork?(): Promise<string>;
  sign(params: { message: string | Uint8Array }): Promise<{ signature: string }>;
  transfer(params: {
    amount: string;
    recipient: string;
    token?: string;
  }): Promise<{
    txHash: string;
    certificate: unknown;
    explorerUrl?: string | null;
  }>;
}

export function paymentNetworkForDeployment(
  deploymentNetwork: WebDeploymentNetwork
): "fast-mainnet" | "fast-testnet" {
  return deploymentNetwork === "testnet" ? "fast-testnet" : "fast-mainnet";
}

export function rawAmountToHex(amountRaw: string): string {
  if (!/^\d+$/.test(amountRaw)) {
    throw new Error(`Invalid raw payment amount: ${amountRaw}`);
  }

  return `0x${BigInt(amountRaw).toString(16)}`;
}

export function createPaymentIdentifier(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `payment_${crypto.randomUUID()}`;
  }

  return `payment_${Date.now()}`;
}

export function selectPaymentRequirement(
  paymentRequired: BrowserPaymentRequired,
  deploymentNetwork: WebDeploymentNetwork
): BrowserPaymentRequirement | null {
  const accepts = paymentRequired.accepts ?? [];
  const preferredNetwork = paymentNetworkForDeployment(deploymentNetwork);

  return (
    accepts.find((requirement) => requirement.network === preferredNetwork) ??
    accepts.find((requirement) => requirement.network.startsWith("fast-")) ??
    null
  );
}

export function encodeBrowserPaymentPayload(input: {
  paymentRequired: BrowserPaymentRequired;
  requirement: BrowserPaymentRequirement;
  certificate: unknown;
}): string {
  const payload = {
    x402Version: input.paymentRequired.x402Version ?? 1,
    scheme: input.requirement.scheme || "exact",
    network: input.requirement.network,
    payload: {
      type: "signAndSendTransaction",
      transactionCertificate: input.certificate
    }
  };

  return base64EncodeJson(payload);
}

export function formatResponseBody(body: unknown): string {
  if (typeof body === "string") {
    return body;
  }

  return JSON.stringify(body, null, 2);
}

async function createScopedAccessToken(input: {
  apiBaseUrl: string;
  wallet: string;
  resourceType: "job" | "api";
  resourceId: string;
  connector: BrowserConnectorLike;
}): Promise<string> {
  const challengeResponse = await fetch(`${input.apiBaseUrl.replace(/\/$/, "")}/auth/challenge`, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({
      wallet: input.wallet,
      resourceType: input.resourceType,
      resourceId: input.resourceId
    })
  });

  if (!challengeResponse.ok) {
    throw new Error(await challengeResponse.text());
  }

  const challenge = (await challengeResponse.json()) as {
    nonce: string;
    expiresAt: string;
    message: string;
  };
  const signed = await input.connector.sign({ message: challenge.message });

  const sessionResponse = await fetch(`${input.apiBaseUrl.replace(/\/$/, "")}/auth/session`, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({
      wallet: input.wallet,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      nonce: challenge.nonce,
      expiresAt: challenge.expiresAt,
      signature: signed.signature
    })
  });

  if (!sessionResponse.ok) {
    throw new Error(await sessionResponse.text());
  }

  const session = (await sessionResponse.json()) as { accessToken: string };
  return session.accessToken;
}

export async function createJobAccessToken(input: {
  apiBaseUrl: string;
  wallet: string;
  jobToken: string;
  connector: BrowserConnectorLike;
}): Promise<string> {
  return createScopedAccessToken({
    apiBaseUrl: input.apiBaseUrl,
    wallet: input.wallet,
    resourceType: "job",
    resourceId: input.jobToken,
    connector: input.connector
  });
}

export async function createApiAccessToken(input: {
  apiBaseUrl: string;
  wallet: string;
  routeId: string;
  connector: BrowserConnectorLike;
}): Promise<string> {
  return createScopedAccessToken({
    apiBaseUrl: input.apiBaseUrl,
    wallet: input.wallet,
    resourceType: "api",
    resourceId: input.routeId,
    connector: input.connector
  });
}

function base64EncodeJson(value: unknown): string {
  const json = JSON.stringify(value);
  const bytes = new TextEncoder().encode(json);
  let binary = "";

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary);
}
