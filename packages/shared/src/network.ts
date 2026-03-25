export type MarketplaceDeploymentNetwork = "mainnet" | "testnet";
export type MarketplacePaymentNetwork = "fast-mainnet" | "fast-testnet";
export type MarketplaceTokenSymbol = "USDC" | "testUSDC";

const FAST_MAINNET_USDC_ASSET_ID = "0xc655a12330da6af361d281b197996d2bc135aaed3b66278e729c2222291e9130";
const FAST_TESTNET_USDC_ASSET_ID = "0xd73a0679a2be46981e2a8aedecd951c8b6690e7d5f8502b34ed3ff4cc2163b46";

export interface MarketplaceNetworkConfig {
  deploymentNetwork: MarketplaceDeploymentNetwork;
  paymentNetwork: MarketplacePaymentNetwork;
  tokenSymbol: MarketplaceTokenSymbol;
  assetId: string;
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
      assetId: FAST_TESTNET_USDC_ASSET_ID,
      rpcUrl: input?.rpcUrl?.trim() || TESTNET_RPC_URL,
      explorerUrl: input?.explorerUrl?.trim() || DEFAULT_EXPLORER_URL,
      displayName: "Fast Testnet",
      shortLabel: "Testnet"
    };
  }

  return {
    deploymentNetwork,
    paymentNetwork: "fast-mainnet",
    tokenSymbol: "USDC",
    assetId: FAST_MAINNET_USDC_ASSET_ID,
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

export function getMarketplaceAssetId(paymentNetwork: MarketplacePaymentNetwork): string {
  return paymentNetwork === "fast-testnet" ? FAST_TESTNET_USDC_ASSET_ID : FAST_MAINNET_USDC_ASSET_ID;
}
