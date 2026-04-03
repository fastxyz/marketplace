"use client";

import React from "react";
import type {
  MarketplaceDeploymentNetwork,
  ProviderAccountRecord,
  ProviderRequestRecord,
  ProviderServiceDetailRecord,
} from "@/lib/marketplace-shared";

import { ProviderSessionGate } from "@/components/provider-session-gate";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  claimProviderRequest,
  fetchProviderAccount,
  fetchProviderRequests,
  fetchProviderServices
} from "@/lib/api";

export function ProviderDashboard({
  apiBaseUrl,
  deploymentNetwork
}: {
  apiBaseUrl: string;
  deploymentNetwork: MarketplaceDeploymentNetwork;
}) {
  return (
    <ProviderSessionGate
      deploymentNetwork={deploymentNetwork}
      title="Provider dashboard"
      description="Claim request intake and manage service drafts from the connected Fast wallet."
    >
      {(session) => (
        <ProviderDashboardInner
          apiBaseUrl={apiBaseUrl}
          accessToken={session.accessToken}
        />
      )}
    </ProviderSessionGate>
  );
}

function ProviderDashboardInner({
  apiBaseUrl,
  accessToken
}: {
  apiBaseUrl: string;
  accessToken: string;
}) {
  const [account, setAccount] = React.useState<ProviderAccountRecord | null | undefined>(undefined);
  const [services, setServices] = React.useState<ProviderServiceDetailRecord[]>([]);
  const [requests, setRequests] = React.useState<ProviderRequestRecord[]>([]);
  const [claimingRequestId, setClaimingRequestId] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;

    async function loadProviderDashboard() {
      setError(null);

      try {
        const nextAccount = await fetchProviderAccount(apiBaseUrl, accessToken);
        if (cancelled) {
          return;
        }
        setAccount(nextAccount);

        if (!nextAccount) {
          setServices([]);
          setRequests([]);
          return;
        }

        try {
          const [nextServices, nextRequests] = await Promise.all([
            fetchProviderServices(apiBaseUrl, accessToken),
            fetchProviderRequests(apiBaseUrl, accessToken)
          ]);
          if (cancelled) {
            return;
          }

          setServices(nextServices);
          setRequests(nextRequests);
        } catch (nextError) {
          if (cancelled) {
            return;
          }
          setServices([]);
          setRequests([]);
          setError(nextError instanceof Error ? nextError.message : "Failed to load provider dashboard.");
        }
      } catch (nextError) {
        if (cancelled) {
          return;
        }
        setError(nextError instanceof Error ? nextError.message : "Failed to load provider dashboard.");
        setAccount(null);
      }
    }

    void loadProviderDashboard();

    return () => {
      cancelled = true;
    };
  }, [accessToken, apiBaseUrl]);

  function onClaimRequest(requestId: string) {
    if (!account || claimingRequestId) {
      return;
    }

    setError(null);
    setClaimingRequestId(requestId);

    void (async () => {
      try {
        const updated = await claimProviderRequest(apiBaseUrl, accessToken, requestId);
        setRequests((current) =>
          sortRequests(
            current
              .filter((request) => request.id !== updated.id)
              .concat(updated)
          )
        );
      } catch (nextError) {
        setError(nextError instanceof Error ? nextError.message : "Failed to claim request.");
      } finally {
        setClaimingRequestId((current) => (current === requestId ? null : current));
      }
    })();
  }

  if (account === undefined) {
    return (
      <Card variant="frosted">
        <CardHeader>
          <CardTitle>Loading provider dashboard</CardTitle>
          <CardDescription>Fetching request intake and service drafts for the connected wallet.</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  if (!account) {
    return (
      <Card variant="frosted">
        <CardHeader>
          <CardTitle>Create your provider profile</CardTitle>
          <CardDescription>
            Claiming requests and publishing services is tied to the provider profile owned by this wallet session.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap gap-3">
            <Button onClick={() => window.location.assign("/providers/onboard")}>Open onboarding</Button>
            <Button variant="outline" onClick={() => window.location.assign("/providers/services")}>
              Open service drafts
            </Button>
          </div>
          {error ? <p className="text-sm text-muted-foreground">{error}</p> : null}
        </CardContent>
      </Card>
    );
  }

  const serviceCount = services.length;
  const publishedServiceCount = services.filter((service) => service.service.status === "published").length;
  const endpointDraftCount = services.reduce((sum, service) => sum + service.endpoints.length, 0);
  const claimedRequestCount = requests.filter((request) => request.claimedByCurrentProvider).length;
  const openRequestCount = requests.filter((request) => request.claimable).length;

  return (
    <div className="grid gap-6">
      <Card variant="frosted">
        <CardHeader className="gap-4">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="space-y-2">
              <Badge variant="eyebrow">Provider workspace</Badge>
              <CardTitle className="text-3xl">{account.displayName}</CardTitle>
              <CardDescription>
                Pick up request intake, then move the implementation into your service drafts and review flow.
              </CardDescription>
            </div>
            <div className="flex flex-wrap gap-3">
              <Button variant="outline" onClick={() => window.location.assign("/providers/onboard")}>
                Edit profile
              </Button>
              <Button onClick={() => window.location.assign("/providers/services")}>Open service drafts</Button>
            </div>
          </div>
        </CardHeader>
      </Card>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
        <MetricCard label="Service drafts" value={String(serviceCount)} />
        <MetricCard label="Published services" value={String(publishedServiceCount)} />
        <MetricCard label="Endpoint drafts" value={String(endpointDraftCount)} />
        <MetricCard label="Open requests" value={String(openRequestCount)} />
        <MetricCard label="Claimed requests" value={String(claimedRequestCount)} />
      </div>

      <div className="grid gap-6 xl:grid-cols-[1.2fr_0.8fr]">
        <Card variant="frosted">
          <CardHeader>
            <CardTitle className="text-3xl">Request intake</CardTitle>
            <CardDescription>
              Claim requests you want to build. Claimed items stay visible so you can route them into a service draft.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            {requests.length === 0 ? (
              <p className="text-sm text-muted-foreground">No provider-visible requests yet.</p>
            ) : null}

            {requests.map((request) => {
              const claimedByCurrentProvider = request.claimedByCurrentProvider;
              const claimedByOtherProvider = Boolean(request.claimedByProviderName) && !request.claimedByCurrentProvider;
              const isClaimable = request.claimable;
              const isClaimingThisRequest = claimingRequestId === request.id;

              return (
                <div key={request.id} className="rounded-card border border-border bg-background/70 p-5 dark:bg-background/20">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="space-y-3">
                      <div className="flex flex-wrap gap-2">
                        <Badge variant="outline">{request.type}</Badge>
                        <Badge variant="secondary">{request.status}</Badge>
                        {request.serviceSlug ? <Badge variant="outline">{request.serviceSlug}</Badge> : null}
                        {claimedByCurrentProvider ? <Badge variant="outline">Claimed by you</Badge> : null}
                        {claimedByOtherProvider && request.claimedByProviderName ? (
                          <Badge variant="outline">Claimed by {request.claimedByProviderName}</Badge>
                        ) : null}
                      </div>
                      <div>
                        <div className="text-lg font-medium tracking-headline">{request.title}</div>
                        <div className="mt-2 text-sm leading-6 text-muted-foreground">{request.description}</div>
                      </div>
                    </div>

                    <div className="text-sm text-muted-foreground">{request.createdAt.slice(0, 10)}</div>
                  </div>

                  <div className="mt-4 grid gap-2 text-sm text-muted-foreground">
                    {request.sourceUrl ? <div>Source URL: {request.sourceUrl}</div> : null}
                    {request.claimedAt && claimedByCurrentProvider ? <div>Claimed: {request.claimedAt.slice(0, 10)}</div> : null}
                  </div>

                  <div className="mt-4 flex flex-wrap gap-3">
                    {isClaimable ? (
                      <Button
                        type="button"
                        onClick={() => onClaimRequest(request.id)}
                        disabled={Boolean(claimingRequestId)}
                      >
                        {isClaimingThisRequest ? "Claiming..." : "Claim request"}
                      </Button>
                    ) : null}
                    <Button type="button" variant="outline" onClick={() => window.location.assign("/providers/services")}>
                      Open service drafts
                    </Button>
                  </div>
                </div>
              );
            })}
          </CardContent>
        </Card>

        <Card variant="frosted">
          <CardHeader>
            <CardTitle className="text-3xl">Your services</CardTitle>
            <CardDescription>
              Existing drafts stay here. Use them as the build destination after you claim a request.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            {services.length === 0 ? (
              <p className="text-sm text-muted-foreground">No service drafts yet.</p>
            ) : null}

            {services.slice(0, 4).map((service) => (
              <div key={service.service.id} className="rounded-card border border-border bg-background/70 p-5 dark:bg-background/20">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <div className="text-lg font-medium tracking-headline">{service.service.name}</div>
                    <div className="text-sm leading-6 text-muted-foreground">
                      {service.endpoints.length} endpoint draft{service.endpoints.length === 1 ? "" : "s"}
                    </div>
                  </div>
                  <Badge variant="secondary">{service.service.status}</Badge>
                </div>
              </div>
            ))}

            <div className="flex flex-wrap gap-3">
              <Button onClick={() => window.location.assign("/providers/services")}>Manage services</Button>
              <Button variant="outline" onClick={() => window.location.assign("/providers/onboard")}>
                Edit provider profile
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>

      {error ? <p className="text-sm text-muted-foreground">{error}</p> : null}
    </div>
  );
}

function MetricCard({ label, value }: { label: string; value: string }) {
  return (
    <Card variant="frosted">
      <CardContent className="p-6">
        <div className="metric-label">{label}</div>
        <div className="mt-4 text-3xl font-medium tracking-m">{value}</div>
      </CardContent>
    </Card>
  );
}

function sortRequests(requests: ProviderRequestRecord[]): ProviderRequestRecord[] {
  return [...requests].sort((left, right) => {
    const leftRank = left.claimedByCurrentProvider ? 0 : left.claimable ? 1 : 2;
    const rightRank = right.claimedByCurrentProvider ? 0 : right.claimable ? 1 : 2;

    if (leftRank !== rightRank) {
      return leftRank - rightRank;
    }

    return right.updatedAt.localeCompare(left.updatedAt);
  });
}
