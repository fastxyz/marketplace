import { mkdir, readFile, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { dirname } from "node:path";

import { bcsSchema } from "@fastxyz/schema";
import {
  FastProvider,
  Signer,
  TransactionBuilder,
  fromFastAddress,
  fromHex,
  hashHex,
  toFastAddress,
  toHex
} from "@fastxyz/sdk";

import { decimalToRawString } from "./amounts.js";
import type { MarketplaceTokenSymbol } from "./network.js";

function normalizePrivateKeyHex(privateKey: string): string {
  const normalized = privateKey.startsWith("0x") ? privateKey.slice(2) : privateKey;
  if (!/^[0-9a-fA-F]{64}$/.test(normalized)) {
    throw new Error("Fast private key must be a 32-byte hex string.");
  }

  return normalized.toLowerCase();
}

function tokenConfig(token: MarketplaceTokenSymbol): { tokenId: string; networkId: "fast:mainnet" | "fast:testnet" } {
  if (token === "testUSDC") {
    return {
      tokenId: "0xd73a0679a2be46981e2a8aedecd951c8b6690e7d5f8502b34ed3ff4cc2163b46",
      networkId: "fast:testnet"
    };
  }

  return {
    tokenId: "0x125b60bb2e805336f0934077d4f9fdb36f45bec9ded8d7b0e637516cc43a86eb",
    networkId: "fast:mainnet"
  };
}

export class MarketplaceFastWallet {
  private readonly privateKeyHex: string;
  private readonly signer: Signer;
  private readonly provider: FastProvider;
  private readonly addressPromise: Promise<string>;
  private readonly publicKeyPromise: Promise<Uint8Array>;

  private constructor(privateKeyHex: string, provider: FastProvider) {
    this.privateKeyHex = privateKeyHex;
    this.signer = new Signer(privateKeyHex);
    this.provider = provider;
    this.addressPromise = this.signer.getFastAddress();
    this.publicKeyPromise = this.signer.getPublicKey();
  }

  static async generate(provider: FastProvider): Promise<MarketplaceFastWallet> {
    return new MarketplaceFastWallet(randomBytes(32).toString("hex"), provider);
  }

  static async fromPrivateKey(privateKey: string, provider: FastProvider): Promise<MarketplaceFastWallet> {
    return new MarketplaceFastWallet(normalizePrivateKeyHex(privateKey), provider);
  }

  static async fromKeyfile(
    input: { keyFile: string; createIfMissing: boolean },
    provider: FastProvider
  ): Promise<MarketplaceFastWallet> {
    try {
      const raw = await readFile(input.keyFile, "utf8");
      const parsed = JSON.parse(raw) as { privateKey?: string };
      if (!parsed.privateKey) {
        throw new Error(`Keyfile is missing privateKey: ${input.keyFile}`);
      }

      return MarketplaceFastWallet.fromPrivateKey(parsed.privateKey, provider);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("ENOENT") || !input.createIfMissing) {
        throw error;
      }

      const wallet = await MarketplaceFastWallet.generate(provider);
      await wallet.saveToKeyfile(input.keyFile);
      return wallet;
    }
  }

  get address(): Promise<string> {
    return this.addressPromise;
  }

  async exportKeys(): Promise<{ privateKey: string; publicKey: string; address: string }> {
    const publicKey = await this.publicKeyPromise;
    return {
      privateKey: this.privateKeyHex,
      publicKey: Buffer.from(publicKey).toString("hex"),
      address: await this.addressPromise
    };
  }

  async saveToKeyfile(keyFile: string): Promise<void> {
    await mkdir(dirname(keyFile), { recursive: true });
    await writeFile(keyFile, JSON.stringify({ privateKey: this.privateKeyHex }, null, 2), "utf8");
  }

  async sign(input: { message: string | Uint8Array }): Promise<{ signature: string }> {
    const message =
      typeof input.message === "string" ? new TextEncoder().encode(input.message) : input.message;
    const signature = await this.signer.signMessage(message);
    return {
      signature: toHex(signature)
    };
  }

  async balance(token: MarketplaceTokenSymbol): Promise<bigint> {
    const { tokenId } = tokenConfig(token);
    const accountInfo = await this.provider.getAccountInfo({
      address: await this.publicKeyPromise,
      tokenBalancesFilter: null,
      stateKeyFilter: null,
      certificateByNonce: null
    });

    const normalizedTokenId = tokenId.replace(/^0x/, "");
    for (const [candidateTokenId, balance] of accountInfo.tokenBalance) {
      if (toHex(candidateTokenId).replace(/^0x/, "") === normalizedTokenId) {
        return balance;
      }
    }

    return 0n;
  }

  async send(input: { to: string; amount: string; token: MarketplaceTokenSymbol }): Promise<{ txHash: string }> {
    const { tokenId, networkId } = tokenConfig(input.token);
    const accountInfo = await this.provider.getAccountInfo({
      address: await this.publicKeyPromise,
      tokenBalancesFilter: null,
      stateKeyFilter: null,
      certificateByNonce: null
    });
    const recipient = input.to.startsWith("fast1") ? fromFastAddress(input.to) : fromHex(input.to);
    const envelope = await new TransactionBuilder({
      networkId,
      signer: this.signer,
      nonce: accountInfo.nextNonce
    })
      .addTokenTransfer({
        tokenId: fromHex(tokenId),
        recipient,
        amount: BigInt(decimalToRawString(input.amount, 6)),
        userData: null
      })
      .sign();

    const submitResult = await this.provider.submitTransaction(envelope);
    if (submitResult.type !== "Success") {
      throw new Error(`Transaction submission failed: ${submitResult.type}`);
    }

    const tx = submitResult.value.envelope.transaction;
    return {
      txHash: await hashHex(bcsSchema.VersionedTransaction, { [tx.type]: tx.value } as never)
    };
  }
}

export function normalizeFastAddressBytes(address: string): Uint8Array {
  return address.startsWith("fast1") ? fromFastAddress(address) : fromHex(address);
}

export function normalizeFastAddress(address: string): string {
  return toFastAddress(normalizeFastAddressBytes(address));
}
