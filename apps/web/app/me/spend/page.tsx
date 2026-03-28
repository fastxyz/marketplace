import { SpendDashboard } from "@/components/spend-dashboard";
import { getClientApiBaseUrl } from "@/lib/api-base-url";
import { resolveWebDeploymentNetwork } from "@/lib/network";

export const dynamic = "force-dynamic";

export default function SpendPage() {
  const apiBaseUrl = getClientApiBaseUrl();
  const network = resolveWebDeploymentNetwork(process.env.MARKETPLACE_FAST_NETWORK);

  return (
    <main className="page-main">
      <section className="page-section">
        <div className="app-container page-stack">
          <div className="page-header">
            <p className="page-eyebrow">Spend</p>
            <h1 className="section-title">Buyer activity</h1>
            <p className="page-copy">Wallet-authenticated marketplace spend, grouped by service.</p>
          </div>

          <SpendDashboard apiBaseUrl={apiBaseUrl} deploymentNetwork={network.deploymentNetwork} />
        </div>
      </section>
    </main>
  );
}
