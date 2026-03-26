"use client";

import React from "react";
import Link from "next/link";
import { useDeferredValue, useMemo, useState } from "react";
import { ArrowRight, Search } from "lucide-react";
import type { ServiceSummary } from "@marketplace/shared";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

function formatSummaryPriceRange(priceRange: string): string {
  return priceRange === "Free" ? priceRange : `${priceRange} per call`;
}

export function MarketplaceHome({ services }: { services: ServiceSummary[] }) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("All");
  const deferredQuery = useDeferredValue(query);

  const categories = useMemo(
    () => ["All", ...Array.from(new Set(services.flatMap((service) => service.categories))).sort()],
    [services]
  );

  const filtered = useMemo(() => {
    const search = deferredQuery.trim().toLowerCase();

    return services.filter((service) => {
      const matchesCategory = category === "All" || service.categories.includes(category);
      const haystack = [service.name, service.ownerName, service.tagline, ...service.categories]
        .join(" ")
        .toLowerCase();

      return matchesCategory && (!search || haystack.includes(search));
    });
  }, [category, deferredQuery, services]);

  return (
    <main className="page-shell">
      <section className="section-sep">
        <div className="section-container section-stack">
          <div className="page-intro max-w-4xl">
            <Badge variant="eyebrow">Go Fast</Badge>
            <div className="space-y-6">
              <h1 className="page-title">
                Data APIs for agents
                <span
                  className="ml-3 inline-block h-[0.9em] w-3 rounded-pill bg-foreground align-[-0.1em]"
                  style={{ animation: "blink 1.2s infinite" }}
                />
              </h1>
              <p className="body-copy">
                Paid APIs for agents, presented like a real marketplace. Browse live Fast-native services, compare
                pricing and performance, and route demand toward the next supply providers should ship.
              </p>

              <div className="grid gap-4 lg:grid-cols-[minmax(24rem,32rem)_1fr] lg:items-start">
                <label className="relative block lg:min-w-[24rem]">
                  <span className="sr-only">Search services, owners, or categories</span>
                  <Search className="pointer-events-none absolute left-5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="Search services, owners, or categories"
                    className="pl-12"
                  />
                </label>
                {/* <div className="flex flex-wrap gap-2 lg:justify-end">
                  {categories.map((item) => (
                    <button
                      key={item}
                      type="button"
                      onClick={() => setCategory(item)}
                      className={item === category ? "filter-chip filter-chip-active" : "filter-chip"}
                    >
                      {item}
                    </button>
                  ))}
                </div> */}
              </div>
            </div>
          </div>
        </div>
      </section>

      <section id="catalog" className="section-sep">
        <div className="section-container section-stack">
          <div className="mt-8 grid gap-5 lg:grid-cols-2">
            {filtered.map((service) => (
              <Link key={service.slug} href={`/services/${service.slug}`} className="group">
                <Card variant="frosted" className="h-full transition-transform duration-300 ease-out group-hover:-translate-y-1">
                  <CardHeader>
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="outline">{service.ownerName}</Badge>
                      {service.serviceType === "marketplace_proxy" ? (
                        <>
                          <Badge variant={service.settlementMode === "verified_escrow" ? "default" : "secondary"}>
                            {service.settlementLabel}
                          </Badge>
                          <span className="text-sm tracking-headline text-muted-foreground">
                            {formatSummaryPriceRange(service.priceRange)}
                          </span>
                        </>
                      ) : (
                        <Badge variant="secondary">{service.accessModelLabel}</Badge>
                      )}
                    </div>
                    <div className="space-y-3">
                      <CardTitle className="text-3xl">{service.name}</CardTitle>
                      <CardDescription>{service.tagline}</CardDescription>
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-6">
                    <p className="text-sm leading-7 text-muted-foreground">
                      {service.serviceType === "marketplace_proxy" ? service.settlementDescription : service.accessModelDescription}
                    </p>

                    {service.serviceType === "marketplace_proxy" ? (
                      // <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                      //   <Metric label="Calls" value={String(service.totalCalls)} compact />
                      //   <Metric label="Revenue" value={`$${service.revenue}`} compact />
                      //   <Metric label="Endpoints" value={String(service.endpointCount)} compact />
                      //   <Metric label="30d success" value={`${service.successRate30d.toFixed(1)}%`} compact />
                      // </div>
                      null
                    ) : (
                      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                        <Metric label="Endpoints" value={String(service.endpointCount)} compact />
                        <Metric label="Access" value="Direct API" compact />
                        <Metric label="Website" value={service.websiteUrl ? new URL(service.websiteUrl).hostname : "N/A"} compact />
                      </div>
                    )}

                    <div className="flex items-center justify-between border-t border-border pt-5 text-sm tracking-headline text-muted-foreground">
                      <span>Open service</span>
                      <ArrowRight className="h-4 w-4" />
                    </div>
                  </CardContent>
                </Card>
              </Link>
            ))}
          </div>

          {filtered.length === 0 ? (
            <div className="mt-8 rounded-card border border-border px-6 py-8 text-sm text-muted-foreground">
              No services matched your current search and category filters.
            </div>
          ) : null}
        </div>
      </section>
    </main>
  );
}

function Metric({
  label,
  value,
  compact = false
}: {
  label: string;
  value: string;
  compact?: boolean;
}) {
  return (
    <div className="space-y-2">
      <div className="metric-label">{label}</div>
      <div className={compact ? "text-2xl font-medium tracking-m" : "metric-value"}>{value}</div>
    </div>
  );
}
