import React from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import type { ProviderServiceStatus } from "@/lib/marketplace-shared";

import { adminLogoutAction } from "@/app/actions";
import { AdminNav } from "@/components/admin-nav";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { fetchAdminProviderServices } from "@/lib/api";
import { isAdminAuthenticated } from "@/lib/admin-auth";

export const dynamic = "force-dynamic";

const serviceStatusFilters: Array<"all" | ProviderServiceStatus> = [
  "all",
  "draft",
  "pending_review",
  "changes_requested",
  "published",
  "suspended",
  "archived"
];

function getSingleParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function parseStatus(value: string | undefined): ProviderServiceStatus | undefined {
  return value === "draft"
    || value === "pending_review"
    || value === "changes_requested"
    || value === "published"
    || value === "suspended"
    || value === "archived"
    ? value
    : undefined;
}

export default async function AdminProviderServicesPage({
  searchParams
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (!(await isAdminAuthenticated())) {
    redirect("/admin/login");
  }

  const params = await searchParams;
  const statusFilter = parseStatus(getSingleParam(params.status));
  const services = await fetchAdminProviderServices(statusFilter);

  return (
    <main className="page-shell">
      <section className="section-sep">
        <div className="section-container section-stack">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div className="space-y-4">
              <Link href="/" className="fast-link">
                Back to marketplace
              </Link>
              <div className="space-y-4">
                <p className="eyebrow">Admin review</p>
                <h1 className="section-title">Provider services</h1>
                <p className="body-copy">
                  Review submitted provider supply, assign settlement for marketplace-proxied services, and publish or suspend services.
                </p>
              </div>
            </div>
            <form action={adminLogoutAction}>
              <Button type="submit" variant="outline">
                Log out
              </Button>
            </form>
          </div>

          <AdminNav current="services" />

          <section className="mt-4 flex flex-wrap gap-2">
            {serviceStatusFilters.map((status) => {
              const href = status === "all" ? "/admin/services" : `/admin/services?status=${status}`;
              const isActive = (status === "all" && !statusFilter) || statusFilter === status;

              return (
                <Link key={status} href={href} className={isActive ? "filter-chip filter-chip-active" : "filter-chip"}>
                  {status}
                </Link>
              );
            })}
          </section>

          <section className="mt-8 grid gap-4">
            {services.length === 0 ? (
              <Card variant="frosted">
                <CardContent className="p-6 text-sm text-muted-foreground">
                  No provider services match this filter.
                </CardContent>
              </Card>
            ) : null}

            {services.map((detail) => (
              <Card key={detail.service.id} variant="frosted">
                <CardHeader className="gap-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="space-y-2">
                      <div className="flex flex-wrap gap-2">
                        <Badge variant="secondary">{detail.service.status}</Badge>
                        {detail.service.serviceType === "marketplace_proxy" ? (
                          <Badge variant={detail.service.settlementMode === "verified_escrow" ? "default" : "outline"}>
                            {detail.service.settlementMode === "verified_escrow" ? "Verified" : "Community"}
                          </Badge>
                        ) : (
                          <Badge variant="outline">External API</Badge>
                        )}
                        {detail.verification ? (
                          <Badge variant="outline">verification: {detail.verification.status}</Badge>
                        ) : null}
                        {detail.latestReview ? (
                          <Badge variant="outline">review: {detail.latestReview.status}</Badge>
                        ) : null}
                      </div>
                      <CardTitle>{detail.service.name}</CardTitle>
                      <CardDescription>
                        {detail.service.serviceType === "marketplace_proxy"
                          ? detail.service.apiNamespace
                          : "discovery-only external registry"}{" "}
                        · {detail.account.displayName} · {detail.endpoints.length} endpoint
                        {detail.endpoints.length === 1 ? "" : "s"}
                      </CardDescription>
                    </div>
                    <div className="flex gap-2">
                      <Link href={`/admin/services/${detail.service.id}`} className="btn-fast btn-fast-secondary">
                        Review
                      </Link>
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="grid gap-2 text-sm text-muted-foreground">
                  <div>Website: {detail.service.websiteUrl ?? "not set"}</div>
                  {detail.service.serviceType === "marketplace_proxy" ? (
                    <div>Payout wallet: {detail.service.payoutWallet ?? "not set"}</div>
                  ) : (
                    <div>Access model: discovery-only external API listing</div>
                  )}
                  <div>Updated: {detail.service.updatedAt.slice(0, 10)}</div>
                </CardContent>
              </Card>
            ))}
          </section>
        </div>
      </section>
    </main>
  );
}
