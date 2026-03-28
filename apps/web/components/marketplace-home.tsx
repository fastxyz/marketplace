"use client";

import React from "react";
import Link from "next/link";
import { useDeferredValue, useMemo, useState } from "react";
import { ArrowRight, Search, Sparkles } from "lucide-react";
import type { ServiceSummary } from "@marketplace/shared";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

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
      const haystack = [service.name, service.ownerName, service.tagline, ...service.categories].join(" ").toLowerCase();

      return matchesCategory && (!search || haystack.includes(search));
    });
  }, [category, deferredQuery, services]);

  const marketplaceCount = services.filter((service) => service.serviceType === "marketplace_proxy").length;
  const endpointCount = services.reduce((sum, service) => sum + service.endpointCount, 0);

  return (
    <main className="page-main">
      <section className="page-section">
        <div className="app-container page-stack">
          <div className="grid gap-6 xl:grid-cols-[1.1fr_0.9fr] xl:items-end">
            <div className="page-header max-w-none">
              <Badge variant="eyebrow">Go Fast</Badge>
              <h1 className="page-title">APIs for agents</h1>
              <p className="page-copy">
                Browse Fast-native paid services, compare marketplace-executed routes against discovery-only listings,
                and route demand toward the next provider supply worth shipping.
              </p>
            </div>

            <div className="grid gap-3 md:grid-cols-3">
              <MetricCard label="Services" value={String(services.length)} />
              <MetricCard label="Marketplace" value={String(marketplaceCount)} />
              <MetricCard label="Endpoints" value={String(endpointCount)} />
            </div>
          </div>

          <Card className="overflow-visible">
            <CardContent className="grid gap-4 pt-6 md:grid-cols-[1fr_220px]">
              <label className="relative block">
                <span className="sr-only">Search services, owners, or categories</span>
                <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search services, owners, or categories"
                  className="pl-10"
                />
              </label>

              <Select value={category} onValueChange={setCategory}>
                <SelectTrigger>
                  <SelectValue placeholder="Filter by category" />
                </SelectTrigger>
                <SelectContent>
                  {categories.map((item) => (
                    <SelectItem key={item} value={item}>
                      {item}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </CardContent>
          </Card>

          <div className="grid gap-4 lg:grid-cols-2">
            {filtered.map((service) => {
              const isMarketplaceService = service.serviceType === "marketplace_proxy";

              return (
                <Link key={service.slug} href={`/services/${service.slug}`} className="block">
                  <Card className="h-full transition-transform duration-200 hover:-translate-y-1">
                    <CardHeader>
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge variant="outline">{service.ownerName}</Badge>
                        {isMarketplaceService ? (
                          <>
                            <Badge variant={service.settlementMode === "verified_escrow" ? "default" : "secondary"}>
                              {service.settlementLabel}
                            </Badge>
                            <Badge variant="secondary">{formatSummaryPriceRange(service.priceRange)}</Badge>
                          </>
                        ) : (
                          <Badge variant="secondary">{service.accessModelLabel}</Badge>
                        )}
                      </div>
                      <div className="space-y-2">
                        <CardTitle className="text-3xl">{service.name}</CardTitle>
                        <CardDescription>{service.tagline}</CardDescription>
                      </div>
                    </CardHeader>

                    <CardContent className="grid gap-6">
                      <p className="text-sm leading-7 text-muted-foreground">
                        {isMarketplaceService ? service.settlementDescription : service.accessModelDescription}
                      </p>

                      <div className="grid gap-3 sm:grid-cols-3">
                        <MetricTile label="Endpoints" value={String(service.endpointCount)} />
                        <MetricTile
                          label={isMarketplaceService ? "Calls" : "Access"}
                          value={isMarketplaceService ? String(service.totalCalls) : "Direct"}
                        />
                        <MetricTile
                          label={isMarketplaceService ? "Revenue" : "Website"}
                          value={isMarketplaceService ? `$${service.revenue}` : service.websiteUrl ? new URL(service.websiteUrl).hostname : "N/A"}
                        />
                      </div>

                      <div className="flex items-center justify-between text-sm text-muted-foreground">
                        <div className="inline-flex items-center gap-2">
                          <Sparkles className="size-4" />
                          <span>{service.categories.slice(0, 2).join(" · ") || "General"}</span>
                        </div>
                        <span className="inline-flex items-center gap-2 text-foreground">
                          Open service
                          <ArrowRight className="size-4" />
                        </span>
                      </div>
                    </CardContent>
                  </Card>
                </Link>
              );
            })}
          </div>

          {filtered.length === 0 ? (
            <Card>
              <CardContent className="pt-6 text-sm text-muted-foreground">
                No services matched the current search and category filters.
              </CardContent>
            </Card>
          ) : null}
        </div>
      </section>
    </main>
  );
}

function MetricCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="metric-tile">
      <div className="metric-label">{label}</div>
      <div className="metric-value">{value}</div>
    </div>
  );
}

function MetricTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="metric-tile gap-1 rounded-xl px-4 py-4">
      <div className="metric-label">{label}</div>
      <div className="text-base font-medium tracking-[-0.02em]">{value}</div>
    </div>
  );
}
