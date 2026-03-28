import { CatalogSnapshotCard } from "@/components/catalog-snapshot-card";
import { fetchServices } from "@/lib/api";

export const dynamic = "force-dynamic";

export default async function StatsPage() {
  const services = await fetchServices();

  return (
    <main className="page-main">
      <section className="page-section">
        <div className="app-container page-stack">
          <div className="page-header">
            <p className="page-eyebrow">Stats</p>
            <h1 className="section-title">Marketplace totals</h1>
            <p className="page-copy">
              A live snapshot of catalog coverage and paid request volume across the public marketplace.
            </p>
          </div>

          <CatalogSnapshotCard services={services} />
        </div>
      </section>
    </main>
  );
}
