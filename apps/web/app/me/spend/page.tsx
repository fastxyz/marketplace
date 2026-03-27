import { SpendDashboard } from "@/components/spend-dashboard";
import { getClientApiBaseUrl } from "@/lib/api-base-url";
import { resolveWebDeploymentNetwork } from "@/lib/network";

export const dynamic = "force-dynamic";

export default function SpendPage() {
  const apiBaseUrl = getClientApiBaseUrl();
  const network = resolveWebDeploymentNetwork(process.env.MARKETPLACE_FAST_NETWORK);

  return (
    <main className="page-shell">
      <section className="section-sep">
        <div className="section-container section-stack">
          <div className="page-intro">
            <p className="eyebrow">Spend</p>
            <div className="space-y-4">
              <h1 className="section-title">Buyer activity</h1>
              <p className="body-copy">
                Wallet-authenticated marketplace spend, grouped by service.
              </p>
            </div>
          </div>

          <SpendDashboard
            apiBaseUrl={apiBaseUrl}
            deploymentNetwork={network.deploymentNetwork}
          />
        </div>
      </section>
    </main>
  );
}
