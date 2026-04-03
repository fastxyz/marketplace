import type { MarketplaceDeploymentNetwork } from "@/lib/marketplace-shared";

export interface StoredWalletSession {
  accessToken: string;
  wallet: string;
  deploymentNetwork: MarketplaceDeploymentNetwork;
  resourceId: string;
}

export const WALLET_SESSION_STORAGE_KEY = "fast-marketplace-wallet-session";
export const WALLET_SESSION_CHANGE_EVENT = "fast-marketplace-wallet-session-change";

function emitWalletSessionChange(): void {
  if (typeof window === "undefined") {
    return;
  }

  window.dispatchEvent(new Event(WALLET_SESSION_CHANGE_EVENT));
}

export function normalizeWalletConnectorNetwork(value: string | null | undefined): MarketplaceDeploymentNetwork | null {
  const normalized = value?.trim().toLowerCase();

  if (!normalized) {
    return null;
  }

  if (normalized === "testnet" || normalized === "fast-testnet") {
    return "testnet";
  }

  if (normalized === "mainnet" || normalized === "fast-mainnet") {
    return "mainnet";
  }

  return null;
}

export function shortenWalletAddress(wallet: string): string {
  if (wallet.length <= 16) {
    return wallet;
  }

  return `${wallet.slice(0, 8)}...${wallet.slice(-6)}`;
}

function isStoredWalletSession(value: unknown): value is StoredWalletSession {
  return Boolean(
    value &&
      typeof value === "object" &&
      "accessToken" in value &&
      "wallet" in value &&
      "deploymentNetwork" in value &&
      "resourceId" in value
  );
}

export function readStoredWalletSession(expectedNetwork: MarketplaceDeploymentNetwork): StoredWalletSession | null {
  if (typeof window === "undefined") {
    return null;
  }

  const raw = window.localStorage.getItem(WALLET_SESSION_STORAGE_KEY);
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isStoredWalletSession(parsed)) {
      window.localStorage.removeItem(WALLET_SESSION_STORAGE_KEY);
      return null;
    }

    if (parsed.deploymentNetwork !== expectedNetwork) {
      window.localStorage.removeItem(WALLET_SESSION_STORAGE_KEY);
      emitWalletSessionChange();
      return null;
    }

    if (parsed.resourceId !== window.location.origin) {
      window.localStorage.removeItem(WALLET_SESSION_STORAGE_KEY);
      emitWalletSessionChange();
      return null;
    }

    return parsed;
  } catch {
    window.localStorage.removeItem(WALLET_SESSION_STORAGE_KEY);
    emitWalletSessionChange();
    return null;
  }
}

export function writeStoredWalletSession(session: StoredWalletSession): void {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.setItem(WALLET_SESSION_STORAGE_KEY, JSON.stringify(session));
  emitWalletSessionChange();
}

export function clearStoredWalletSession(): void {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.removeItem(WALLET_SESSION_STORAGE_KEY);
  emitWalletSessionChange();
}
