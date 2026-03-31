import { MarketplaceHome } from "@/components/marketplace-home";
import { fetchServices } from "@/lib/api";
import type { ServiceSummary } from "@marketplace/shared";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  let services: ServiceSummary[] = [];

  try {
    services = await fetchServices();
  } catch (error) {
    console.error("Failed to load marketplace services for homepage render.", error);
  }

  return <MarketplaceHome services={services} />;
}
