"use client";

import React from "react";
import type { MarketplaceDeploymentNetwork } from "@/lib/marketplace-shared";

import { ProviderSessionGate } from "@/components/provider-session-gate";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { fetchProviderRuntimeKey, fetchProviderService, submitProviderService } from "@/lib/api";

export function ProviderServiceReview({
  apiBaseUrl,
  deploymentNetwork,
  serviceId
}: {
  apiBaseUrl: string;
  deploymentNetwork: MarketplaceDeploymentNetwork;
  serviceId: string;
}) {
  return (
    <ProviderSessionGate
      deploymentNetwork={deploymentNetwork}
      title="Review service draft"
      description="Confirm the required draft metadata and submit the service for marketplace review."
    >
      {(session) => (
        <ProviderServiceReviewInner apiBaseUrl={apiBaseUrl} accessToken={session.accessToken} serviceId={serviceId} />
      )}
    </ProviderSessionGate>
  );
}

function ProviderServiceReviewInner({
  apiBaseUrl,
  accessToken,
  serviceId
}: {
  apiBaseUrl: string;
  accessToken: string;
  serviceId: string;
}) {
  const [detail, setDetail] = React.useState<Awaited<ReturnType<typeof fetchProviderService>> | undefined>(undefined);
  const [runtimeKey, setRuntimeKey] = React.useState<Awaited<ReturnType<typeof fetchProviderRuntimeKey>> | undefined>(undefined);
  const [pending, startTransition] = React.useTransition();
  const [message, setMessage] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    startTransition(async () => {
      try {
        setError(null);
        const [nextDetail, nextRuntimeKey] = await Promise.all([
          fetchProviderService(apiBaseUrl, accessToken, serviceId),
          fetchProviderRuntimeKey(apiBaseUrl, accessToken, serviceId)
        ]);
        setDetail(nextDetail);
        setRuntimeKey(nextRuntimeKey);
      } catch (nextError) {
        setError(nextError instanceof Error ? nextError.message : "Failed to load review state.");
      }
    });
  }, [accessToken, apiBaseUrl, serviceId]);

  if (detail === undefined) {
    return (
      <Card variant="frosted">
        <CardContent className="p-6 text-sm text-muted-foreground">
          {error ?? "Loading review state..."}
        </CardContent>
      </Card>
    );
  }

  if (detail === null) {
    return (
      <Card variant="frosted">
        <CardHeader>
          <CardTitle>Review draft unavailable</CardTitle>
          <CardDescription>
            This draft was deleted or is no longer accessible from the connected wallet session.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-3">
          <Button type="button" variant="outline" onClick={() => window.location.assign("/providers/services")}>
            Back to drafts
          </Button>
        </CardContent>
      </Card>
    );
  }

  const isMarketplaceService = detail.service.serviceType === "marketplace_proxy";
  const externalHostConsistencyReady = !isMarketplaceService && isExternalRegistryHostConfigReady(detail);
  const checklist = [
    isMarketplaceService
      ? {
          label: `Settlement tier is ${detail.service.settlementMode === "verified_escrow" ? "Verified" : "Community"}`,
          ok: true
        }
      : {
          label: "Service is marked as a discovery-only external API",
          ok: true
        },
    { label: "Website URL is set", ok: Boolean(detail.service.websiteUrl) },
    {
      label: isMarketplaceService ? "Payout wallet is set" : "Direct endpoint metadata is set on the service",
      ok: isMarketplaceService ? Boolean(detail.service.payoutWallet) : true
    },
    { label: "At least one endpoint exists", ok: detail.endpoints.length > 0 },
    isMarketplaceService
      ? { label: "Website verification succeeded", ok: detail.verification?.status === "verified" }
      : { label: "Website URL and endpoint hosts are set consistently", ok: externalHostConsistencyReady },
    {
      label: isMarketplaceService ? "Runtime key is ready for Community, async, or prepaid flows" : "Marketplace runtime key is not required",
      ok: isMarketplaceService
        ? (
            Boolean(runtimeKey)
            || (
              detail.service.settlementMode === "verified_escrow"
              && !detail.endpoints.some((endpoint) =>
                endpoint.endpointType === "marketplace_proxy"
                && (endpoint.billing.type === "prepaid_credit" || endpoint.mode === "async")
              )
            )
          )
        : true
    }
  ];

  function onSubmit() {
    setError(null);
    setMessage(null);

    startTransition(async () => {
      try {
        const submitted = await submitProviderService(apiBaseUrl, accessToken, serviceId);
        setDetail(submitted);
        setMessage("Service submitted for review.");
      } catch (nextError) {
        setError(nextError instanceof Error ? nextError.message : "Submit failed.");
      }
    });
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_0.9fr]">
      <Card variant="frosted">
        <CardHeader>
          <CardTitle className="text-3xl">{detail.service.name}</CardTitle>
          <CardDescription>
            {detail.service.status}
            {isMarketplaceService ? ` · ${detail.service.settlementMode === "verified_escrow" ? "Verified" : "Community"}` : " · External API"}
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 text-sm">
          <div className="rounded-card border border-border bg-background/70 p-5 dark:bg-background/20">
            <div className="font-medium">{isMarketplaceService ? "Latest verification" : "Website ownership verification"}</div>
            <div className="mt-2 text-muted-foreground">
              {isMarketplaceService
                ? (detail.verification?.status ?? "not started")
                : (detail.verification?.status ?? "not required")}
            </div>
          </div>
          <div className="rounded-card border border-border bg-background/70 p-5 dark:bg-background/20">
            <div className="font-medium">Latest review</div>
            <div className="mt-2 text-muted-foreground">{detail.latestReview?.status ?? "not submitted"}</div>
            {detail.latestReview?.reviewNotes ? (
              <div className="mt-2 whitespace-pre-wrap text-muted-foreground">{detail.latestReview.reviewNotes}</div>
            ) : null}
          </div>
          <div className="rounded-card border border-border bg-background/70 p-5 dark:bg-background/20">
            <div className="font-medium">Endpoints</div>
            <div className="mt-2 text-muted-foreground">{detail.endpoints.length} draft endpoint(s)</div>
          </div>
        </CardContent>
      </Card>

      <Card variant="frosted">
        <CardHeader>
          <CardTitle className="text-3xl">Submission checklist</CardTitle>
          <CardDescription>The API enforces these requirements at submit time too.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3">
            {checklist.map((item) => (
              <div key={item.label} className="flex items-center justify-between rounded-card border border-border bg-background/70 px-4 py-3 text-sm dark:bg-background/20">
                <span>{item.label}</span>
                <span className={item.ok ? "text-foreground" : "text-muted-foreground"}>
                  {item.ok ? "ready" : "missing"}
                </span>
              </div>
            ))}
          </div>

          <div className="flex flex-wrap gap-3">
            <Button type="button" onClick={onSubmit} disabled={pending}>
              {pending ? "Submitting..." : "Submit for review"}
            </Button>
            <Button type="button" variant="outline" onClick={() => window.location.assign(`/providers/services/${serviceId}`)}>
              Back to editor
            </Button>
          </div>

          {message ? <p className="text-sm text-muted-foreground">{message}</p> : null}
          {error ? <p className="text-sm text-muted-foreground">{error}</p> : null}
        </CardContent>
      </Card>
    </div>
  );
}

function isExternalRegistryHostConfigReady(detail: NonNullable<Awaited<ReturnType<typeof fetchProviderService>>>) {
  if (!detail.service.websiteUrl || detail.endpoints.length === 0) {
    return false;
  }

  let serviceHostname: string;
  try {
    serviceHostname = new URL(detail.service.websiteUrl).hostname;
  } catch {
    return false;
  }

  return detail.endpoints.every((endpoint) => {
    if (endpoint.endpointType !== "external_registry") {
      return false;
    }

    try {
      return (
        isSameOrSubdomain(serviceHostname, new URL(endpoint.publicUrl).hostname)
        && isSameOrSubdomain(serviceHostname, new URL(endpoint.docsUrl).hostname)
      );
    } catch {
      return false;
    }
  });
}

function isSameOrSubdomain(expectedHostname: string, candidateHostname: string) {
  return candidateHostname === expectedHostname || candidateHostname.endsWith(`.${expectedHostname}`);
}
