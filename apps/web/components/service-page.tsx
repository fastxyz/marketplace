"use client";

import React from "react";
import Link from "next/link";
import type { ReactNode } from "react";
import { ArrowLeftRight, ArrowUpRight, Command, DatabaseZap, Sparkle } from "lucide-react";
import type { MarketplaceServiceCatalogEndpoint, ServiceDetail } from "@marketplace/shared";
import type { WebDeploymentNetwork } from "@/lib/network";

import { CopyButton } from "@/components/copy-button";
import { EndpointBrowserRunner } from "@/components/endpoint-browser-runner";
import { VolumeChart } from "@/components/volume-chart";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

function usesTokenPrice(billingType: MarketplaceServiceCatalogEndpoint["billingType"]): boolean {
  return billingType === "fixed_x402" || billingType === "topup_x402_variable";
}

function formatSummaryPriceRange(priceRange: string): string {
  return priceRange === "Free" ? priceRange : `${priceRange} per call`;
}

export function ServicePage({
  service,
  deploymentNetwork
}: {
  service: ServiceDetail;
  deploymentNetwork: WebDeploymentNetwork;
}) {
  const isMarketplaceService = service.serviceType === "marketplace_proxy";

  return (
    <main className="page-shell">
      <section className="section-sep">
        <div className="section-container section-stack">
          <div className={`grid gap-10 ${isMarketplaceService ? "lg:grid-cols-[1.12fr_0.88fr]" : "lg:grid-cols-[1fr_0.9fr]"}`}>
            <div className="space-y-8">
              <div className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
                <Link href="/" className="fast-link">
                  Marketplace
                </Link>
                <span>/</span>
                <span>{service.summary.name}</span>
              </div>

              <div className="space-y-5">
                <div className="flex flex-wrap items-center gap-3">
                  <Badge variant="outline">{service.summary.ownerName}</Badge>
                  {isMarketplaceService ? (
                    <>
                      <Badge variant={service.summary.settlementMode === "verified_escrow" ? "default" : "secondary"}>
                        {service.summary.settlementLabel}
                      </Badge>
                      <span className="text-sm tracking-headline text-muted-foreground">
                        {formatSummaryPriceRange(service.summary.priceRange)}
                      </span>
                    </>
                  ) : (
                    <>
                      <Badge variant="secondary">{service.summary.accessModelLabel}</Badge>
                      {service.websiteUrl ? (
                        <Badge variant="outline">{new URL(service.websiteUrl).hostname}</Badge>
                      ) : null}
                    </>
                  )}
                </div>
                <div className="space-y-4">
                  <h1 className="section-title">{service.summary.name}</h1>
                  <p className="body-copy">{service.summary.tagline}</p>
                  <p className="text-sm leading-7 text-muted-foreground">
                    {isMarketplaceService ? service.summary.settlementDescription : service.summary.accessModelDescription}
                  </p>
                </div>
              </div>

              {isMarketplaceService ? (
                <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                  <StatCard label="Total Calls" value={String(service.summary.totalCalls)} icon={<Sparkle className="h-4 w-4" />} />
                  <StatCard label="Revenue" value={`$${service.summary.revenue}`} icon={<DatabaseZap className="h-4 w-4" />} />
                  <StatCard label="Endpoints" value={String(service.summary.endpointCount)} icon={<ArrowLeftRight className="h-4 w-4" />} />
                  <StatCard
                    label="Success Rate (30d)"
                    value={`${service.summary.successRate30d.toFixed(1)}%`}
                    icon={<Command className="h-4 w-4" />}
                  />
                </div>
              ) : (
                <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                  <StatCard label="Endpoints" value={String(service.summary.endpointCount)} icon={<ArrowLeftRight className="h-4 w-4" />} />
                  <StatCard label="Access" value="Direct API" icon={<ArrowUpRight className="h-4 w-4" />} />
                  <StatCard label="Marketplace role" value="Discovery" icon={<Command className="h-4 w-4" />} />
                </div>
              )}
            </div>

            {isMarketplaceService ? (
              <Card variant="frosted">
                <CardHeader>
                  <Badge variant="eyebrow">Transaction volume</Badge>
                  <CardTitle className="text-3xl">Marketplace call flow over time</CardTitle>
                  <CardDescription>Thirty-day volume across live marketplace traffic.</CardDescription>
                </CardHeader>
                <CardContent>
                  <VolumeChart points={service.summary.volume30d} tokenSymbol={service.summary.settlementToken} />
                </CardContent>
              </Card>
            ) : (
              <Card variant="frosted">
                <CardHeader>
                  <Badge variant="eyebrow">Direct Access</Badge>
                  <CardTitle className="text-3xl">Provider-owned integration</CardTitle>
                  <CardDescription>
                    This listing is discovery-only. Calls go straight to the provider and follow the provider&apos;s docs and auth model.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4 text-sm text-muted-foreground">
                  <div>Marketplace execution: disabled</div>
                  <div>Auth and payment: provider-defined</div>
                  <div>Use the endpoint docs below for exact direct URLs.</div>
                </CardContent>
              </Card>
            )}
          </div>
        </div>
      </section>

      <section className="section-sep">
        <div className="section-container section-stack">
          <div className="grid gap-6 lg:grid-cols-[0.9fr_1.1fr]">
            <Card variant="frosted">
              <CardHeader>
                <Badge variant="eyebrow">About this service</Badge>
                <CardTitle className="text-3xl">Service profile</CardTitle>
              </CardHeader>
              <CardContent className="space-y-6 text-sm leading-7 text-muted-foreground">
                <p>{service.about}</p>
                <div className="flex flex-wrap gap-3">
                  <Button onClick={() => window.location.assign(`/suggest?service=${service.summary.slug}&type=endpoint`)}>
                    Suggest an endpoint
                  </Button>
                  <Button variant="outline" onClick={() => window.location.assign("/suggest?type=source")}>
                    Suggest a source
                  </Button>
                </div>
              </CardContent>
            </Card>

            <div className="terminal-shell">
              <div className="terminal-topbar">
                <div className="terminal-lights" aria-hidden="true">
                  <span className="terminal-light-red" />
                  <span className="terminal-light-amber" />
                  <span className="terminal-light-green" />
                </div>
                <div className="terminal-title">Agent-ready prompt block</div>
                <CopyButton value={service.useThisServicePrompt} className="terminal-copy" />
              </div>
              <div className="terminal-body space-y-5">
                <div className="terminal-kicker">Setup and exact call parameters</div>
                <p className="max-w-3xl text-sm leading-7 text-white/70">
                  {isMarketplaceService
                    ? "Includes setup, the marketplace skill, and exact call parameters for each available endpoint."
                    : "Includes setup, direct endpoint URLs, and provider-auth details for each available endpoint."}
                </p>
                <pre className="terminal-command overflow-x-auto whitespace-pre-wrap">{service.useThisServicePrompt}</pre>
                {service.skillUrl ? (
                  <Link href={service.skillUrl} className="terminal-meta inline-flex items-center gap-2">
                    Open canonical SKILL.md
                    <ArrowUpRight className="h-4 w-4" />
                  </Link>
                ) : null}
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="section-sep">
        <div className="section-container section-stack">
          <Card variant="frosted">
            <CardHeader>
              <Badge variant="eyebrow">Available endpoints ({service.endpoints.length})</Badge>
              <CardTitle className="text-3xl">
                {isMarketplaceService ? "Request docs, pricing, and examples" : "Direct endpoint docs and examples"}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <Accordion type="single" collapsible className="w-full">
                {isMarketplaceService
                  ? service.endpoints.map((endpoint) => (
                      <AccordionItem key={endpoint.routeId} value={endpoint.routeId}>
                        <AccordionTrigger>
                          <div className="grid flex-1 gap-3 md:grid-cols-[auto_1fr_auto] md:items-center">
                            <div className="metric-label">{endpoint.method}</div>
                            <div>
                              <div className="text-lg font-medium tracking-headline text-foreground">{endpoint.title}</div>
                              <div className="text-sm leading-7 text-muted-foreground">{endpoint.description}</div>
                            </div>
                            <div className="text-sm font-medium tracking-headline text-foreground">
                              {endpoint.price}{usesTokenPrice(endpoint.billingType) ? ` ${endpoint.tokenSymbol}` : ""}
                            </div>
                          </div>
                        </AccordionTrigger>
                        <AccordionContent>
                          <div className="grid gap-5 lg:grid-cols-2">
                            <Card className="h-full">
                              <CardHeader className="pb-4">
                                <Badge variant="eyebrow">Proxy URL</Badge>
                                <CardTitle className="text-xl">Direct marketplace route</CardTitle>
                              </CardHeader>
                              <CardContent className="space-y-4">
                                <div className="flex items-start justify-between gap-4">
                                  <div className="break-all text-sm leading-7 text-muted-foreground">{endpoint.proxyUrl}</div>
                                  <CopyButton value={endpoint.proxyUrl} />
                                </div>
                                {endpoint.usageNotes ? (
                                  <p className="text-sm leading-7 text-muted-foreground">{endpoint.usageNotes}</p>
                                ) : null}
                              </CardContent>
                            </Card>

                            <ExampleBlock label="Request Example" value={JSON.stringify(endpoint.requestExample, null, 2)} />
                            <ExampleBlock label="Response Example" value={JSON.stringify(endpoint.responseExample, null, 2)} />
                            <EndpointBrowserRunner endpoint={endpoint} deploymentNetwork={deploymentNetwork} />
                          </div>
                        </AccordionContent>
                      </AccordionItem>
                    ))
                  : service.endpoints.map((endpoint) => (
                      <AccordionItem key={endpoint.endpointId} value={endpoint.endpointId}>
                        <AccordionTrigger>
                          <div className="grid flex-1 gap-3 md:grid-cols-[auto_1fr] md:items-center">
                            <div className="metric-label">{endpoint.method}</div>
                            <div>
                              <div className="text-lg font-medium tracking-headline text-foreground">{endpoint.title}</div>
                              <div className="text-sm leading-7 text-muted-foreground">{endpoint.description}</div>
                            </div>
                          </div>
                        </AccordionTrigger>
                        <AccordionContent>
                          <div className="grid gap-5 lg:grid-cols-2">
                            <Card className="h-full">
                              <CardHeader className="pb-4">
                                <Badge variant="eyebrow">Direct URL</Badge>
                                <CardTitle className="text-xl">Provider endpoint</CardTitle>
                              </CardHeader>
                              <CardContent className="space-y-4">
                                <div className="flex items-start justify-between gap-4">
                                  <div className="break-all text-sm leading-7 text-muted-foreground">{endpoint.publicUrl}</div>
                                  <CopyButton value={endpoint.publicUrl} />
                                </div>
                                <div className="flex items-start justify-between gap-4">
                                  <div className="break-all text-sm leading-7 text-muted-foreground">{endpoint.docsUrl}</div>
                                  <CopyButton value={endpoint.docsUrl} />
                                </div>
                                {endpoint.authNotes ? (
                                  <p className="text-sm leading-7 text-muted-foreground">Auth: {endpoint.authNotes}</p>
                                ) : null}
                                {endpoint.usageNotes ? (
                                  <p className="text-sm leading-7 text-muted-foreground">{endpoint.usageNotes}</p>
                                ) : null}
                              </CardContent>
                            </Card>

                            <ExampleBlock label="Request Example" value={JSON.stringify(endpoint.requestExample, null, 2)} />
                            <ExampleBlock label="Response Example" value={JSON.stringify(endpoint.responseExample, null, 2)} />
                          </div>
                        </AccordionContent>
                      </AccordionItem>
                    ))}
              </Accordion>
            </CardContent>
          </Card>
        </div>
      </section>
    </main>
  );
}

function StatCard({
  label,
  value,
  icon
}: {
  label: string;
  value: string;
  icon: ReactNode;
}) {
  return (
    <Card variant="frosted">
      <CardContent className="p-6">
        <div className="flex items-center justify-between gap-3 text-muted-foreground">
          <div className="metric-label">{label}</div>
          {icon}
        </div>
        <div className="mt-4 text-3xl font-medium tracking-m">{value}</div>
      </CardContent>
    </Card>
  );
}

function ExampleBlock({ label, value }: { label: string; value: string }) {
  return (
    <div className="terminal-shell h-full">
      <div className="terminal-topbar">
        <div className="terminal-title">{label}</div>
        <CopyButton value={value} className="terminal-copy" />
      </div>
      <div className="terminal-body pt-6">
        <pre className="terminal-command overflow-x-auto whitespace-pre-wrap text-sm">{value}</pre>
      </div>
    </div>
  );
}
