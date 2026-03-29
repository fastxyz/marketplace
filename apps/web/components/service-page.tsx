"use client";

import React from "react";
import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import type { MarketplaceServiceCatalogEndpoint, ServiceDetail } from "@marketplace/shared";
import type { WebDeploymentNetwork } from "@/lib/network";

import { CopyButton } from "@/components/copy-button";
import { EndpointBrowserRunner } from "@/components/endpoint-browser-runner";
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
    <main className="page-main">
      <section className="page-section">
        <div className="app-container page-stack">
          <div className={isMarketplaceService ? "page-stack" : "grid gap-6 xl:grid-cols-[1.08fr_0.92fr] xl:items-start"}>
            <div className="page-stack">
              <div className="page-header max-w-none">
                <Link href="/" className="page-link">
                  Back to marketplace
                </Link>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="outline">{service.summary.ownerName}</Badge>
                  {isMarketplaceService ? (
                    <>
                      <Badge variant={service.summary.settlementMode === "verified_escrow" ? "default" : "secondary"}>
                        {service.summary.settlementLabel}
                      </Badge>
                      <Badge variant="secondary">{formatSummaryPriceRange(service.summary.priceRange)}</Badge>
                    </>
                  ) : (
                    <>
                      <Badge variant="secondary">{service.summary.accessModelLabel}</Badge>
                      {service.websiteUrl ? <Badge variant="outline">{new URL(service.websiteUrl).hostname}</Badge> : null}
                    </>
                  )}
                </div>
                <h1 className="section-title">{service.summary.name}</h1>
                <p className="page-copy">{service.summary.tagline}</p>
                <p className="max-w-3xl text-sm leading-7 text-muted-foreground">
                  {isMarketplaceService ? service.summary.settlementDescription : service.summary.accessModelDescription}
                </p>
              </div>
            </div>

            {isMarketplaceService ? null : (
              <Card>
                <CardHeader>
                  <Badge variant="eyebrow">Direct access</Badge>
                  <CardTitle>Provider-owned integration</CardTitle>
                  <CardDescription>
                    This listing is discovery-only. Calls go straight to the provider and follow the provider&apos;s docs
                    and auth model.
                  </CardDescription>
                </CardHeader>
                <CardContent className="grid gap-3 text-sm text-muted-foreground">
                  <div className="metric-tile">
                    <div className="metric-label">Marketplace execution</div>
                    <div className="text-base font-medium text-foreground">Disabled</div>
                  </div>
                  <div className="metric-tile">
                    <div className="metric-label">Auth and payment</div>
                    <div className="text-base font-medium text-foreground">Provider-defined</div>
                  </div>
                </CardContent>
              </Card>
            )}
          </div>

          <div className="grid gap-6 xl:grid-cols-[0.9fr_1.1fr]">
            <Card>
              <CardHeader>
                <Badge variant="eyebrow">About this service</Badge>
                <CardTitle>Service profile</CardTitle>
              </CardHeader>
              <CardContent className="grid gap-6 text-sm leading-7 text-muted-foreground">
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

            <PromptBlock
              prompt={service.useThisServicePrompt}
              description={
                isMarketplaceService
                  ? "Includes setup, the marketplace skill, and exact call parameters for each available endpoint."
                  : "Includes setup, direct endpoint URLs, and provider-auth details for each available endpoint."
              }
              skillUrl={service.skillUrl}
            />
          </div>

          <Card>
            <CardHeader>
              <Badge variant="eyebrow">Available endpoints ({service.endpoints.length})</Badge>
              <CardTitle>{isMarketplaceService ? "Request docs, pricing, and examples" : "Direct endpoint docs and examples"}</CardTitle>
            </CardHeader>
            <CardContent>
              <Accordion type="single" collapsible className="w-full">
                {isMarketplaceService
                  ? service.endpoints.map((endpoint) => (
                      <AccordionItem key={endpoint.routeId} value={endpoint.routeId}>
                        <AccordionTrigger>
                          <div className="grid flex-1 gap-3 md:grid-cols-[auto_1fr_auto] md:items-center">
                            <Badge variant="secondary" className="w-fit">
                              {endpoint.method}
                            </Badge>
                            <div className="text-left">
                              <div className="text-lg font-medium tracking-[-0.03em]">{endpoint.title}</div>
                              <div className="text-sm leading-7 text-muted-foreground">{endpoint.description}</div>
                            </div>
                            <div className="text-sm font-medium text-foreground">
                              {endpoint.price}
                              {usesTokenPrice(endpoint.billingType) ? ` ${endpoint.tokenSymbol}` : ""}
                            </div>
                          </div>
                        </AccordionTrigger>
                        <AccordionContent>
                          <div className="grid gap-5 lg:grid-cols-2">
                            <DetailCard title="Direct marketplace route" label="Proxy URL" value={endpoint.proxyUrl} copyValue={endpoint.proxyUrl} notes={endpoint.usageNotes} />
                            <ExampleBlock label="Request example" value={JSON.stringify(endpoint.requestExample, null, 2)} />
                            <ExampleBlock label="Response example" value={JSON.stringify(endpoint.responseExample, null, 2)} />
                            <EndpointBrowserRunner endpoint={endpoint} deploymentNetwork={deploymentNetwork} />
                          </div>
                        </AccordionContent>
                      </AccordionItem>
                    ))
                  : service.endpoints.map((endpoint) => (
                      <AccordionItem key={endpoint.endpointId} value={endpoint.endpointId}>
                        <AccordionTrigger>
                          <div className="grid flex-1 gap-3 md:grid-cols-[auto_1fr] md:items-center">
                            <Badge variant="secondary" className="w-fit">
                              {endpoint.method}
                            </Badge>
                            <div className="text-left">
                              <div className="text-lg font-medium tracking-[-0.03em]">{endpoint.title}</div>
                              <div className="text-sm leading-7 text-muted-foreground">{endpoint.description}</div>
                            </div>
                          </div>
                        </AccordionTrigger>
                        <AccordionContent>
                          <div className="grid gap-5 lg:grid-cols-2">
                            <Card className="h-full">
                              <CardHeader className="pb-4">
                                <Badge variant="eyebrow">Direct URLs</Badge>
                                <CardTitle className="text-xl">Provider endpoint</CardTitle>
                              </CardHeader>
                              <CardContent className="grid gap-4">
                                <DetailRow label="Public URL" value={endpoint.publicUrl} copyValue={endpoint.publicUrl} />
                                <DetailRow label="Docs URL" value={endpoint.docsUrl} copyValue={endpoint.docsUrl} />
                                {endpoint.authNotes ? <p className="text-sm leading-7 text-muted-foreground">Auth: {endpoint.authNotes}</p> : null}
                                {endpoint.usageNotes ? <p className="text-sm leading-7 text-muted-foreground">{endpoint.usageNotes}</p> : null}
                              </CardContent>
                            </Card>
                            <ExampleBlock label="Request example" value={JSON.stringify(endpoint.requestExample, null, 2)} />
                            <ExampleBlock label="Response example" value={JSON.stringify(endpoint.responseExample, null, 2)} />
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

function PromptBlock({
  prompt,
  description,
  skillUrl
}: {
  prompt: string;
  description: string;
  skillUrl?: string | null;
}) {
  return (
    <div className="terminal-surface">
      <div className="terminal-toolbar">
        <div className="text-sm font-medium">Agent-ready prompt block</div>
        <CopyButton value={prompt} />
      </div>
      <div className="terminal-body">
        <div className="terminal-label">Setup and exact call parameters</div>
        <p className="max-w-3xl text-sm leading-7 text-white/70">{description}</p>
        <pre className="terminal-code overflow-x-auto whitespace-pre-wrap">{prompt}</pre>
        {skillUrl ? (
          <Link href={skillUrl} className="inline-flex items-center gap-2 text-sm text-white/72 transition-opacity hover:opacity-100">
            Open canonical SKILL.md
            <ArrowUpRight className="size-4" />
          </Link>
        ) : null}
      </div>
    </div>
  );
}

function DetailCard({
  title,
  label,
  value,
  copyValue,
  notes
}: {
  title: string;
  label: string;
  value: string;
  copyValue: string;
  notes?: string | null;
}) {
  return (
    <Card className="h-full">
      <CardHeader className="pb-4">
        <Badge variant="eyebrow">{label}</Badge>
        <CardTitle className="text-xl">{title}</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4">
        <DetailRow label={label} value={value} copyValue={copyValue} />
        {notes ? <p className="text-sm leading-7 text-muted-foreground">{notes}</p> : null}
      </CardContent>
    </Card>
  );
}

function DetailRow({
  label,
  value,
  copyValue
}: {
  label: string;
  value: string;
  copyValue: string;
}) {
  return (
    <div className="detail-pair">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="detail-key">{label}</div>
          <div className="detail-value mt-1">{value}</div>
        </div>
        <CopyButton value={copyValue} />
      </div>
    </div>
  );
}

function ExampleBlock({ label, value }: { label: string; value: string }) {
  return (
    <div className="terminal-surface h-full">
      <div className="terminal-toolbar">
        <div className="text-sm font-medium">{label}</div>
        <CopyButton value={value} />
      </div>
      <div className="terminal-body">
        <pre className="terminal-code overflow-x-auto whitespace-pre-wrap text-sm">{value}</pre>
      </div>
    </div>
  );
}
