"use client";

import React from "react";
import { useDeferredValue, useMemo, useState } from "react";
import type { ServiceSummary } from "@marketplace/shared";

import { Input } from "@/components/ui/input";
import { ServicesDataTable } from "@/components/services-data-table";

export function MarketplaceHome({ services }: { services: ServiceSummary[] }) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("");
  const deferredQuery = useDeferredValue(query);

  const categories = useMemo(
    () => [...new Set(services.flatMap((service) => service.categories))].sort((left, right) => left.localeCompare(right)),
    [services]
  );

  const filtered = useMemo(() => {
    const search = deferredQuery.trim().toLowerCase();

    return services.filter((service) => {
      const haystack = [service.name, service.ownerName, service.tagline, ...service.categories]
        .join(" ")
        .toLowerCase();
      const matchesCategory = !category || service.categories.includes(category);

      return (!search || haystack.includes(search)) && matchesCategory;
    });
  }, [category, deferredQuery, services]);

  const providerCount = useMemo(() => new Set(services.map((service) => service.ownerName)).size, [services]);
  const endpointCount = useMemo(() => services.reduce((sum, service) => sum + service.endpointCount, 0), [services]);

  return (
    <main>
      <section className="py-8">
        <div className="page-main page-stack">
          <div className="grid gap-8 lg:grid-cols-[minmax(0,1.2fr)_minmax(320px,0.8fr)] lg:items-start">
            <div className="page-header">
              <h1 className="section-title">APIs for agents</h1>
              <p className="page-copy">Browse live web services, compare pricing and performance, and pay with USDC on Fast.xyz</p>
            </div>

            <div className="grid justify-items-start gap-3 lg:justify-items-end">
              <div className="terminal-label">AI Agents start here</div>
              <div className="terminal-surface w-fit overflow-hidden">
                <div className="terminal-body">
                <pre className="terminal-code overflow-x-auto whitespace-pre-wrap text-sm">{`curl -L https://marketplace.fast.xyz/skill.md`}</pre>
                </div>
              </div>
            </div>
          </div>

          <div className="glass-card-elevated p-6">
            <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_240px]">
              <label className="grid gap-3">
                <span className="page-eyebrow">Search services, owners, or categories</span>
                <Input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search services, owners, or categories"
                />
              </label>

              <label className="grid gap-3">
                <span className="page-eyebrow">Category</span>
                <select
                  className="native-select min-h-12"
                  value={category}
                  onChange={(event) => setCategory(event.target.value)}
                  aria-label="Filter by category"
                >
                  <option value="">All categories</option>
                  {categories.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <div className="mt-6">
              <ServicesDataTable services={filtered} />
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}
