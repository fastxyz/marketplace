export type WebDeploymentNetwork = "mainnet" | "testnet";

export function resolveWebDeploymentNetwork(input: string | undefined | null): {
  deploymentNetwork: WebDeploymentNetwork;
  networkLabel: string;
  paymentNetwork: "fast-mainnet" | "fast-testnet";
  tokenSymbol: "USDC" | "testUSDC";
} {
  if (input === "testnet") {
    return {
      deploymentNetwork: "testnet",
      networkLabel: "Testnet",
      paymentNetwork: "fast-testnet",
      tokenSymbol: "testUSDC"
    };
  }

  return {
    deploymentNetwork: "mainnet",
    networkLabel: "Mainnet",
    paymentNetwork: "fast-mainnet",
    tokenSymbol: "USDC"
  };
}
