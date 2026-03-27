import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

import { hashes, verifyAsync } from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha2.js";
import { decodeFastAddress, encodeFastAddress, hexToBytes } from "@fastxyz/sdk";
import { utf8ToBytes } from "@fastxyz/sdk/core";

import {
  AUTH_CHALLENGE_TTL_MS,
  AUTH_SESSION_TTL_MS
} from "./constants.js";
import type { ChallengePayload, ResourceType, SessionTokenPayload } from "./types.js";

hashes.sha512 = sha512;

function base64UrlEncode(input: string): string {
  return Buffer.from(input, "utf8").toString("base64url");
}

function base64UrlDecode(input: string): string {
  return Buffer.from(input, "base64url").toString("utf8");
}

function signValue(value: string, secret: string): string {
  return createHmac("sha256", secret).update(value).digest("base64url");
}

export function normalizeFastWalletAddress(addressOrHex: string): string {
  if (addressOrHex.startsWith("fast1")) {
    const decoded = decodeFastAddress(addressOrHex);
    return encodeFastAddress(decoded.bytes);
  }

  const normalized = addressOrHex.startsWith("0x") ? addressOrHex.slice(2) : addressOrHex;

  if (normalized.length !== 64) {
    throw new Error("Fast wallet payer must be a canonical fast address or 32-byte hex public key.");
  }

  return encodeFastAddress(hexToBytes(normalized));
}

export function createChallenge(input: {
  wallet: string;
  resourceType: ResourceType;
  resourceId: string;
  now?: Date;
}): ChallengePayload & { message: string } {
  const now = input.now ?? new Date();
  const expiresAt = new Date(now.getTime() + AUTH_CHALLENGE_TTL_MS).toISOString();
  const payload: ChallengePayload = {
    wallet: normalizeFastWalletAddress(input.wallet),
    resourceType: input.resourceType,
    resourceId: input.resourceId,
    nonce: randomUUID(),
    expiresAt
  };

  return {
    ...payload,
    message: challengeMessage(payload)
  };
}

export function challengeMessage(payload: ChallengePayload): string {
  return [
    "Fast Marketplace Access",
    `Wallet: ${payload.wallet}`,
    `Resource: ${payload.resourceType}/${payload.resourceId}`,
    `Nonce: ${payload.nonce}`,
    `Expires: ${payload.expiresAt}`
  ].join("\n");
}

export async function verifyWalletChallenge(input: {
  wallet: string;
  signature: string;
  challenge: ChallengePayload;
  now?: Date;
}): Promise<boolean> {
  const normalizedWallet = normalizeFastWalletAddress(input.wallet);

  if (normalizedWallet !== normalizeFastWalletAddress(input.challenge.wallet)) {
    return false;
  }

  const expiresAtMs = Date.parse(input.challenge.expiresAt);
  if (Number.isNaN(expiresAtMs) || expiresAtMs <= (input.now ?? new Date()).getTime()) {
    return false;
  }

  const publicKey = decodeFastAddress(normalizedWallet).bytes;
  const message = utf8ToBytes(challengeMessage(input.challenge));
  const signature = hexToBytes(input.signature.startsWith("0x") ? input.signature.slice(2) : input.signature);

  return verifyAsync(signature, message, publicKey);
}

export function createSessionToken(input: {
  wallet: string;
  resourceType: ResourceType;
  resourceId: string;
  secret: string;
  now?: Date;
}): string {
  const now = input.now ?? new Date();
  const payload: SessionTokenPayload = {
    wallet: normalizeFastWalletAddress(input.wallet),
    resourceType: input.resourceType,
    resourceId: input.resourceId,
    expiresAt: new Date(now.getTime() + AUTH_SESSION_TTL_MS).toISOString()
  };

  const serialized = JSON.stringify(payload);
  const encoded = base64UrlEncode(serialized);
  const signature = signValue(encoded, input.secret);
  return `${encoded}.${signature}`;
}

export function verifySessionToken(token: string, secret: string, now: Date = new Date()): SessionTokenPayload | null {
  const [encoded, signature] = token.split(".");
  if (!encoded || !signature) {
    return null;
  }

  const expectedSignature = signValue(encoded, secret);
  if (signature.length !== expectedSignature.length) {
    return null;
  }

  const validSignature = timingSafeEqual(
    Buffer.from(signature, "utf8"),
    Buffer.from(expectedSignature, "utf8")
  );

  if (!validSignature) {
    return null;
  }

  let payload: SessionTokenPayload;
  try {
    payload = JSON.parse(base64UrlDecode(encoded)) as SessionTokenPayload;
  } catch {
    return null;
  }

  if (Date.parse(payload.expiresAt) <= now.getTime()) {
    return null;
  }

  return {
    ...payload,
    wallet: normalizeFastWalletAddress(payload.wallet)
  };
}

export function parseBearerToken(headerValue: string | undefined): string | null {
  if (!headerValue) {
    return null;
  }

  const [scheme, token] = headerValue.split(" ");
  if (scheme?.toLowerCase() !== "bearer" || !token) {
    return null;
  }

  return token;
}
