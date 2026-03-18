export type MarketplaceDeploymentNetwork = "mainnet" | "testnet";
export type MarketplacePaymentNetwork = "fast-mainnet" | "fast-testnet";
export type MarketplaceTokenSymbol = "fastUSDC" | "testUSDC";

export interface MarketplaceNetworkConfig {
  deploymentNetwork: MarketplaceDeploymentNetwork;
  paymentNetwork: MarketplacePaymentNetwork;
  tokenSymbol: MarketplaceTokenSymbol;
  rpcUrl: string;
  explorerUrl: string;
  displayName: string;
  shortLabel: string;
}

const MAINNET_RPC_URL = "https://api.fast.xyz/proxy";
const TESTNET_RPC_URL = "https://testnet.api.fast.xyz/proxy";
const DEFAULT_EXPLORER_URL = "https://explorer.fast.xyz";

export function normalizeMarketplaceDeploymentNetwork(value: string | undefined | null): MarketplaceDeploymentNetwork {
  return value === "testnet" ? "testnet" : "mainnet";
}

export function resolveMarketplaceNetworkConfig(input?: {
  deploymentNetwork?: string | null;
  rpcUrl?: string | null;
  explorerUrl?: string | null;
}): MarketplaceNetworkConfig {
  const deploymentNetwork = normalizeMarketplaceDeploymentNetwork(input?.deploymentNetwork);

  if (deploymentNetwork === "testnet") {
    return {
      deploymentNetwork,
      paymentNetwork: "fast-testnet",
      tokenSymbol: "testUSDC",
      rpcUrl: input?.rpcUrl?.trim() || TESTNET_RPC_URL,
      explorerUrl: input?.explorerUrl?.trim() || DEFAULT_EXPLORER_URL,
      displayName: "Fast Testnet",
      shortLabel: "Testnet"
    };
  }

  return {
    deploymentNetwork,
    paymentNetwork: "fast-mainnet",
    tokenSymbol: "fastUSDC",
    rpcUrl: input?.rpcUrl?.trim() || MAINNET_RPC_URL,
    explorerUrl: input?.explorerUrl?.trim() || DEFAULT_EXPLORER_URL,
    displayName: "Fast Mainnet",
    shortLabel: "Mainnet"
  };
}

export function getDefaultMarketplaceNetworkConfig(): MarketplaceNetworkConfig {
  return resolveMarketplaceNetworkConfig({
    deploymentNetwork: process.env.MARKETPLACE_FAST_NETWORK,
    rpcUrl: process.env.MARKETPLACE_FAST_RPC_URL,
    explorerUrl: process.env.MARKETPLACE_FAST_EXPLORER_URL
  });
}
