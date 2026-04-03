import React from "react";
import type { ServiceSummary } from "@/lib/marketplace-shared";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

function buildMarketplaceTotals(services: ServiceSummary[]) {
  return services.reduce(
    (totals, service) => {
      if (service.serviceType === "marketplace_proxy") {
        totals.calls += service.totalCalls;
        totals.revenue += Number(service.revenue);
      }
      totals.endpoints += service.endpointCount;
      return totals;
    },
    { calls: 0, revenue: 0, endpoints: 0 }
  );
}

export function CatalogSnapshotCard({ services }: { services: ServiceSummary[] }) {
  const totals = buildMarketplaceTotals(services);

  return (
    <Card variant="frosted">
      <CardHeader>
        <CardDescription>Marketplace totals</CardDescription>
        <CardTitle className="text-3xl">Catalog snapshot</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-6 sm:grid-cols-2 xl:grid-cols-4">
        <Metric label="Services" value={String(services.length)} />
        <Metric label="Endpoints" value={String(totals.endpoints)} />
        <Metric label="Call volume" value={String(totals.calls)} />
        <Metric label="Revenue" value={`$${totals.revenue.toFixed(2)}`} />
      </CardContent>
    </Card>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="space-y-2 rounded-card border border-border bg-background/70 px-5 py-6 dark:bg-background/20">
      <div className="metric-label">{label}</div>
      <div className="text-3xl font-medium tracking-m">{value}</div>
    </div>
  );
}
