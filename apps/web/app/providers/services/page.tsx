import { ProviderServicesDashboard } from "@/components/provider-services-dashboard";
import { getClientApiBaseUrl } from "@/lib/api-base-url";
import { resolveWebDeploymentNetwork } from "@/lib/network";

export const dynamic = "force-dynamic";

export default function ProviderServicesPage() {
  const apiBaseUrl = getClientApiBaseUrl();
  const deploymentNetwork = resolveWebDeploymentNetwork(process.env.MARKETPLACE_FAST_NETWORK).deploymentNetwork;

  return (
    <main className="page-main">
      <section className="page-section">
        <div className="app-container">
          <ProviderServicesDashboard apiBaseUrl={apiBaseUrl} deploymentNetwork={deploymentNetwork} />
        </div>
      </section>
    </main>
  );
}
