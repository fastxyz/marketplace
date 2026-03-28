import { ProviderOnboard } from "@/components/provider-onboard";
import { getClientApiBaseUrl } from "@/lib/api-base-url";
import { resolveWebDeploymentNetwork } from "@/lib/network";

export const dynamic = "force-dynamic";

export default function ProviderOnboardPage() {
  const apiBaseUrl = getClientApiBaseUrl();
  const deploymentNetwork = resolveWebDeploymentNetwork(process.env.MARKETPLACE_FAST_NETWORK).deploymentNetwork;

  return (
    <main className="page-main">
      <section className="page-section">
        <div className="app-container">
          <ProviderOnboard apiBaseUrl={apiBaseUrl} deploymentNetwork={deploymentNetwork} />
        </div>
      </section>
    </main>
  );
}
