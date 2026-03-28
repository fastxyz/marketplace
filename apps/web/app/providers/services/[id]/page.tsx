import { ProviderServiceEditor } from "@/components/provider-service-editor";
import { getClientApiBaseUrl } from "@/lib/api-base-url";
import { resolveWebDeploymentNetwork } from "@/lib/network";

export const dynamic = "force-dynamic";

export default async function ProviderServiceEditorPage({
  params
}: {
  params: Promise<{ id: string }>;
}) {
  const apiBaseUrl = getClientApiBaseUrl();
  const deploymentNetwork = resolveWebDeploymentNetwork(process.env.MARKETPLACE_FAST_NETWORK).deploymentNetwork;
  const { id } = await params;

  return (
    <main className="page-main">
      <section className="page-section">
        <div className="app-container">
          <ProviderServiceEditor
            apiBaseUrl={apiBaseUrl}
            deploymentNetwork={deploymentNetwork}
            serviceId={id}
          />
        </div>
      </section>
    </main>
  );
}
