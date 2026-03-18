"use client";

import React from "react";
import Link from "next/link";
import type { ReactNode } from "react";
import { ArrowLeftRight, ArrowUpRight, Command, DatabaseZap, Sparkle } from "lucide-react";
import type { ServiceDetail } from "@marketplace/shared";

import { CopyButton } from "@/components/copy-button";
import { VolumeChart } from "@/components/volume-chart";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export function ServicePage({ service }: { service: ServiceDetail }) {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-7xl flex-col gap-8 px-6 py-8 md:px-10 md:py-12">
      <section className="grid gap-6 rounded-[36px] border border-border/70 bg-[radial-gradient(circle_at_top_left,rgba(125,211,252,0.14),transparent_24%),radial-gradient(circle_at_85%_20%,rgba(52,211,153,0.12),transparent_24%),linear-gradient(160deg,rgba(10,14,26,0.94),rgba(9,12,20,0.96))] p-8 shadow-[0_40px_120px_-70px_rgba(0,0,0,1)] lg:grid-cols-[1.3fr_0.9fr]">
        <div className="space-y-6">
          <div className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
            <Link href="/" className="font-medium text-foreground hover:text-foreground/80">
              Marketplace
            </Link>
            <span>/</span>
            <span>{service.summary.name}</span>
          </div>

          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-3">
              <Badge>{service.summary.ownerName}</Badge>
              <span className="text-sm uppercase tracking-[0.18em] text-muted-foreground">
                {service.summary.priceRange} per call
              </span>
            </div>
            <div>
              <h1 className="text-4xl font-semibold tracking-tight md:text-6xl">{service.summary.name}</h1>
              <p className="mt-4 max-w-3xl text-lg leading-8 text-foreground/72">{service.summary.tagline}</p>
            </div>
            <div className="flex flex-wrap gap-2">
              {service.summary.categories.map((category) => (
                <Badge key={category} className="bg-background/80">
                  {category}
                </Badge>
              ))}
            </div>
          </div>

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
        </div>

        <Card className="bg-black/20">
          <CardHeader>
            <CardDescription>Transaction Volume (30d)</CardDescription>
            <CardTitle className="text-2xl">Paid call flow over time</CardTitle>
          </CardHeader>
          <CardContent>
            <VolumeChart points={service.summary.volume30d} tokenSymbol={service.summary.settlementToken} />
          </CardContent>
        </Card>
      </section>

      <section className="grid gap-6 lg:grid-cols-[0.9fr_1.1fr]">
        <Card>
          <CardHeader>
            <CardDescription>About this service</CardDescription>
            <CardTitle className="text-2xl">Service profile</CardTitle>
          </CardHeader>
          <CardContent className="space-y-5 text-sm leading-7 text-foreground/80">
            <p>{service.about}</p>
            <div className="flex flex-wrap gap-3">
              <Button onClick={() => window.location.assign(`/suggest?service=${service.summary.slug}&type=endpoint`)}>
                Suggest an endpoint
              </Button>
              <Button variant="secondary" onClick={() => window.location.assign("/suggest?type=source")}>
                Suggest a source
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="gap-4">
            <div className="flex items-center justify-between gap-4">
              <div>
                <CardDescription>Use this service</CardDescription>
                <CardTitle className="text-2xl">Agent-ready prompt block</CardTitle>
              </div>
              <CopyButton value={service.useThisServicePrompt} />
            </div>
            <CardDescription>
              Includes setup, the marketplace skill, and exact call parameters for each available endpoint.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="rounded-[24px] border border-border/70 bg-black/25 p-4">
              <pre className="overflow-x-auto whitespace-pre-wrap text-sm leading-7 text-foreground/82">
                {service.useThisServicePrompt}
              </pre>
            </div>
            <Link
              href={service.skillUrl}
              className="inline-flex items-center gap-2 text-sm font-medium text-foreground hover:text-foreground/75"
            >
              Open canonical SKILL.md
              <ArrowUpRight className="h-4 w-4" />
            </Link>
          </CardContent>
        </Card>
      </section>

      <section>
        <Card>
          <CardHeader>
            <CardDescription>Available Endpoints ({service.endpoints.length})</CardDescription>
            <CardTitle className="text-3xl">Request docs, pricing, and examples</CardTitle>
          </CardHeader>
          <CardContent>
            <Accordion type="single" collapsible className="w-full">
              {service.endpoints.map((endpoint) => (
                <AccordionItem key={endpoint.routeId} value={endpoint.routeId}>
                  <AccordionTrigger>
                    <div className="grid flex-1 gap-2 md:grid-cols-[auto_1fr_auto] md:items-center">
                      <div className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                        {endpoint.method}
                      </div>
                      <div>
                        <div className="text-base font-semibold text-foreground">{endpoint.title}</div>
                        <div className="text-sm text-muted-foreground">{endpoint.description}</div>
                      </div>
                      <div className="text-sm font-medium text-foreground">
                        {endpoint.price} {endpoint.tokenSymbol}
                      </div>
                    </div>
                  </AccordionTrigger>
                  <AccordionContent>
                    <div className="grid gap-5 lg:grid-cols-2">
                      <div className="space-y-4 rounded-[24px] border border-border/70 bg-black/20 p-4">
                        <div className="flex items-center justify-between gap-3">
                          <div>
                            <div className="text-xs uppercase tracking-[0.18em] text-muted-foreground">Proxy URL</div>
                            <div className="mt-1 break-all text-sm font-medium">{endpoint.proxyUrl}</div>
                          </div>
                          <CopyButton value={endpoint.proxyUrl} />
                        </div>

                        {endpoint.usageNotes ? (
                          <p className="text-sm leading-7 text-muted-foreground">{endpoint.usageNotes}</p>
                        ) : null}
                      </div>

                      <ExampleBlock label="Request Example" value={JSON.stringify(endpoint.requestExample, null, 2)} />
                      <ExampleBlock label="Response Example" value={JSON.stringify(endpoint.responseExample, null, 2)} />
                    </div>
                  </AccordionContent>
                </AccordionItem>
              ))}
            </Accordion>
          </CardContent>
        </Card>
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
    <div className="rounded-[24px] border border-border/70 bg-black/20 p-4">
      <div className="flex items-center justify-between gap-3 text-muted-foreground">
        <div className="text-[11px] uppercase tracking-[0.2em]">{label}</div>
        {icon}
      </div>
      <div className="mt-4 text-3xl font-semibold">{value}</div>
    </div>
  );
}

function ExampleBlock({ label, value }: { label: string; value: string }) {
  return (
    <div className="space-y-3 rounded-[24px] border border-border/70 bg-black/20 p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="text-xs uppercase tracking-[0.18em] text-muted-foreground">{label}</div>
        <CopyButton value={value} />
      </div>
      <pre className="overflow-x-auto whitespace-pre-wrap text-sm leading-7 text-foreground/80">{value}</pre>
    </div>
  );
}
