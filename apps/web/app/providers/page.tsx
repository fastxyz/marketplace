import { ProviderDashboard } from "@/components/provider-dashboard";
import { getClientApiBaseUrl } from "@/lib/api-base-url";
import { resolveWebDeploymentNetwork } from "@/lib/network";

export const dynamic = "force-dynamic";

export default function ProvidersPage() {
  const apiBaseUrl = getClientApiBaseUrl();
  const deploymentNetwork = resolveWebDeploymentNetwork(process.env.MARKETPLACE_FAST_NETWORK).deploymentNetwork;

  return (
    <main className="page-main">
      <section className="page-section">
        <div className="app-container">
          <ProviderDashboard apiBaseUrl={apiBaseUrl} deploymentNetwork={deploymentNetwork} />
        </div>
      </section>
    </main>
  );
}
