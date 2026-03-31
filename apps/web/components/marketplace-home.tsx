"use client";

import React from "react";
import { useDeferredValue, useMemo, useState } from "react";
import type { ServiceSummary } from "@marketplace/shared";

import { Input } from "@/components/ui/input";
import { ServicesDataTable } from "@/components/services-data-table";

export function MarketplaceHome({ services }: { services: ServiceSummary[] }) {
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);

  const filtered = useMemo(() => {
    const search = deferredQuery.trim().toLowerCase();

    return services.filter((service) => {
      const haystack = [service.name, service.ownerName, service.tagline, ...service.categories]
        .join(" ")
        .toLowerCase();

      return !search || haystack.includes(search);
    });
  }, [deferredQuery, services]);

  const providerCount = useMemo(() => new Set(services.map((service) => service.ownerName)).size, [services]);
  const endpointCount = useMemo(() => services.reduce((sum, service) => sum + service.endpointCount, 0), [services]);

  return (
    <main>
      <section className="py-16">
        <div className="page-main page-stack">
          <div className="page-header">
            <h1 className="section-title">APIs for agents</h1>
            <p className="page-copy">Search and sort every public service through the AllSet-inspired marketplace shell.</p>
          </div>

          <div className="glass-card-elevated p-6">
            <label className="grid gap-3">
              <span className="page-eyebrow">Search services, owners, or categories</span>
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search services, owners, or categories"
              />
            </label>

            <div className="mt-6">
              <ServicesDataTable services={filtered} />
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}
