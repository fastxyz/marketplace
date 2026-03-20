import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import {
  MARKETPLACE_IDENTITY_PAYMENT_HEADER,
  MARKETPLACE_IDENTITY_REQUEST_HEADER,
  MARKETPLACE_IDENTITY_SERVICE_HEADER,
  MARKETPLACE_IDENTITY_SIGNATURE_HEADER,
  MARKETPLACE_IDENTITY_TIMESTAMP_HEADER,
  MARKETPLACE_IDENTITY_WALLET_HEADER,
  UPSTREAM_SIGNATURE_MAX_AGE_MS
} from "./constants.js";
import { decryptSecret, encryptSecret } from "./secrets.js";

export interface ProviderRuntimeKeyMaterial {
  plaintextKey: string;
  keyPrefix: string;
  keyHash: string;
  ciphertext: string;
  iv: string;
  authTag: string;
}

export interface MarketplaceIdentityPayload {
  buyerWallet: string | null;
  serviceId: string;
  requestId: string;
  paymentId: string | null;
  timestamp: string;
}

function hashValue(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function signaturePayload(input: MarketplaceIdentityPayload): string {
  return [
    input.buyerWallet ?? "",
    input.serviceId,
    input.requestId,
    input.paymentId ?? "",
    input.timestamp
  ].join("\n");
}

export function createProviderRuntimeKeyMaterial(secret: string): ProviderRuntimeKeyMaterial {
  const keyPrefix = randomBytes(4).toString("hex");
  const plaintextKey = `rtk_${keyPrefix}_${randomBytes(24).toString("hex")}`;

  const encrypted = encryptSecret({
    plaintext: plaintextKey,
    secret
  });

  return {
    plaintextKey,
    keyPrefix,
    keyHash: hashValue(plaintextKey),
    ciphertext: encrypted.ciphertext,
    iv: encrypted.iv,
    authTag: encrypted.authTag
  };
}

export function hashProviderRuntimeKey(plaintextKey: string): string {
  return hashValue(plaintextKey);
}

export function runtimeKeyMatchesHash(plaintextKey: string, keyHash: string): boolean {
  const actual = hashProviderRuntimeKey(plaintextKey);
  if (actual.length !== keyHash.length) {
    return false;
  }

  return timingSafeEqual(Buffer.from(actual, "utf8"), Buffer.from(keyHash, "utf8"));
}

export function decryptProviderRuntimeKey(input: {
  ciphertext: string;
  iv: string;
  authTag: string;
  secret: string;
}): string {
  return decryptSecret(input);
}

export function buildMarketplaceIdentityHeaders(input: {
  buyerWallet?: string | null;
  serviceId: string;
  requestId: string;
  paymentId?: string | null;
  signingSecret: string;
  now?: Date;
}): Record<string, string> {
  const timestamp = (input.now ?? new Date()).toISOString();
  const payload: MarketplaceIdentityPayload = {
    buyerWallet: input.buyerWallet ?? null,
    serviceId: input.serviceId,
    requestId: input.requestId,
    paymentId: input.paymentId ?? null,
    timestamp
  };
  const signature = createHmac("sha256", input.signingSecret).update(signaturePayload(payload)).digest("base64url");

  return {
    [MARKETPLACE_IDENTITY_WALLET_HEADER]: payload.buyerWallet ?? "",
    [MARKETPLACE_IDENTITY_SERVICE_HEADER]: payload.serviceId,
    [MARKETPLACE_IDENTITY_REQUEST_HEADER]: payload.requestId,
    [MARKETPLACE_IDENTITY_PAYMENT_HEADER]: payload.paymentId ?? "",
    [MARKETPLACE_IDENTITY_TIMESTAMP_HEADER]: payload.timestamp,
    [MARKETPLACE_IDENTITY_SIGNATURE_HEADER]: signature
  };
}

export function verifyMarketplaceIdentityHeaders(input: {
  headers: Record<string, string | string[] | undefined>;
  signingSecret: string;
  now?: Date;
  maxAgeMs?: number;
}): MarketplaceIdentityPayload {
  const now = input.now ?? new Date();
  const maxAgeMs = input.maxAgeMs ?? UPSTREAM_SIGNATURE_MAX_AGE_MS;
  const read = (name: string): string => {
    const match = Object.entries(input.headers).find(([candidate]) => candidate.toLowerCase() === name.toLowerCase());
    const value = match ? (Array.isArray(match[1]) ? match[1][0] : match[1]) : null;
    if (!value) {
      throw new Error(`Missing identity header: ${name}`);
    }
    return value;
  };
  const readOptional = (name: string): string | null => {
    const match = Object.entries(input.headers).find(([candidate]) => candidate.toLowerCase() === name.toLowerCase());
    const value = match ? (Array.isArray(match[1]) ? match[1][0] : match[1]) : null;
    return value ?? null;
  };

  const payload: MarketplaceIdentityPayload = {
    buyerWallet: readOptional(MARKETPLACE_IDENTITY_WALLET_HEADER) || null,
    serviceId: read(MARKETPLACE_IDENTITY_SERVICE_HEADER),
    requestId: read(MARKETPLACE_IDENTITY_REQUEST_HEADER),
    paymentId: readOptional(MARKETPLACE_IDENTITY_PAYMENT_HEADER) || null,
    timestamp: read(MARKETPLACE_IDENTITY_TIMESTAMP_HEADER)
  };
  const signature = read(MARKETPLACE_IDENTITY_SIGNATURE_HEADER);
  const expected = createHmac("sha256", input.signingSecret).update(signaturePayload(payload)).digest("base64url");

  if (signature.length !== expected.length) {
    throw new Error("Invalid marketplace signature.");
  }

  if (!timingSafeEqual(Buffer.from(signature, "utf8"), Buffer.from(expected, "utf8"))) {
    throw new Error("Invalid marketplace signature.");
  }

  const ageMs = Math.abs(now.getTime() - Date.parse(payload.timestamp));
  if (Number.isNaN(ageMs) || ageMs > maxAgeMs) {
    throw new Error("Marketplace signature has expired.");
  }

  return payload;
}
