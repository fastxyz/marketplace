import { normalizeFastWalletAddress } from "@/lib/marketplace-shared";

import { SpendDashboard } from "@/components/spend-dashboard";
import { getClientApiBaseUrl } from "@/lib/api-base-url";
import { resolveWebDeploymentNetwork } from "@/lib/network";

export const dynamic = "force-dynamic";

function getSingleParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function SpendPage({
  searchParams
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const requestedAddress = getSingleParam(params.address)?.trim();
  let requestedWallet: string | null = null;
  let invalidRequestedWallet: string | null = null;

  if (requestedAddress) {
    try {
      requestedWallet = normalizeFastWalletAddress(requestedAddress);
    } catch {
      invalidRequestedWallet = requestedAddress;
    }
  }

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
              <p className="body-copy">Wallet-authenticated marketplace spend, grouped by service.</p>
            </div>
          </div>

          <SpendDashboard
            apiBaseUrl={apiBaseUrl}
            deploymentNetwork={network.deploymentNetwork}
            requestedWallet={requestedWallet}
            invalidRequestedWallet={invalidRequestedWallet}
          />
        </div>
      </section>
    </main>
  );
}
