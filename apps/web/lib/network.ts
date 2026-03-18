export type WebDeploymentNetwork = "mainnet" | "testnet";

export function resolveWebDeploymentNetwork(input: string | undefined | null): {
  deploymentNetwork: WebDeploymentNetwork;
  networkLabel: string;
} {
  if (input === "testnet") {
    return {
      deploymentNetwork: "testnet",
      networkLabel: "Testnet"
    };
  }

  return {
    deploymentNetwork: "mainnet",
    networkLabel: "Mainnet"
  };
}
