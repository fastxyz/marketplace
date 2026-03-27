"use client";

import React from "react";
import type { BuyerActivityResponse, MarketplaceDeploymentNetwork } from "@marketplace/shared";

import { BuyerSessionGate } from "@/components/buyer-session-gate";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { fetchBuyerActivity } from "@/lib/api";
import { shortenWalletAddress } from "@/lib/wallet-session";

function summaryMetric(label: string, value: string) {
  return (
    <div className="space-y-2 rounded-card border border-border bg-background/70 px-5 py-6 dark:bg-background/20">
      <div className="metric-label">{label}</div>
      <div className="text-3xl font-medium tracking-m">{value}</div>
    </div>
  );
}

function groupActivity(activity: BuyerActivityResponse) {
  const groups = new Map<string, BuyerActivityResponse["items"]>();

  for (const item of activity.items) {
    const existing = groups.get(item.service.slug);
    if (existing) {
      existing.push(item);
    } else {
      groups.set(item.service.slug, [item]);
    }
  }

  return Array.from(groups.entries()).map(([slug, items]) => ({
    slug,
    name: items[0]?.service.name ?? slug,
    items
  }));
}

function formatStatus(status: string) {
  return status.replaceAll("_", " ");
}

function formatTimestamp(value: string) {
  return new Date(value).toLocaleString();
}

export function SpendDashboard({
  apiBaseUrl,
  deploymentNetwork
}: {
  apiBaseUrl: string;
  deploymentNetwork: MarketplaceDeploymentNetwork;
}) {
  return (
    <BuyerSessionGate deploymentNetwork={deploymentNetwork}>
      {(session) => (
        <SpendDashboardInner
          apiBaseUrl={apiBaseUrl}
          accessToken={session.accessToken}
          wallet={session.wallet}
        />
      )}
    </BuyerSessionGate>
  );
}

function SpendDashboardInner({
  apiBaseUrl,
  accessToken,
  wallet
}: {
  apiBaseUrl: string;
  accessToken: string;
  wallet: string;
}) {
  const [activity, setActivity] = React.useState<BuyerActivityResponse | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        setError(null);
        const nextActivity = await fetchBuyerActivity({
          apiBaseUrl,
          accessToken,
          range: "30d"
        });
        if (!cancelled) {
          setActivity(nextActivity);
        }
      } catch (nextError) {
        if (!cancelled) {
          setError(nextError instanceof Error ? nextError.message : "Failed to load spend activity.");
          setActivity(null);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [accessToken, apiBaseUrl]);

  if (!activity && !error) {
    return (
      <Card variant="frosted">
        <CardHeader>
          <CardTitle>Loading spend</CardTitle>
          <CardDescription>Fetching marketplace activity for the connected wallet.</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  if (error) {
    return (
      <Card variant="frosted">
        <CardHeader>
          <CardTitle>Spend dashboard unavailable</CardTitle>
          <CardDescription>{error}</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  if (!activity) {
    return null;
  }

  const groups = groupActivity(activity);

  return (
    <div className="grid gap-6">
      <Card variant="frosted">
        <CardHeader className="gap-4">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="space-y-2">
              <Badge variant="eyebrow">Last 30 days</Badge>
              <CardTitle className="text-3xl">Marketplace spend</CardTitle>
              <CardDescription>
                Wallet {shortenWalletAddress(wallet)}. Only marketplace-executed calls, top-ups, async outcomes, and refunds appear here.
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
          {summaryMetric("Total spend", `$${activity.summary.totalSpend}`)}
          {summaryMetric("Refunded", `$${activity.summary.totalRefunded}`)}
          {summaryMetric("Net spend", `$${activity.summary.netSpend}`)}
          {summaryMetric("Paid calls", String(activity.summary.paidCallCount))}
          {summaryMetric("Services", String(activity.summary.serviceCount))}
        </CardContent>
      </Card>

      {activity.items.length === 0 ? (
        <Card variant="frosted">
          <CardHeader>
            <CardTitle>No marketplace activity yet</CardTitle>
            <CardDescription>
              Paid calls and top-ups made from this wallet will appear here once they run through the marketplace.
            </CardDescription>
          </CardHeader>
        </Card>
      ) : null}

      {groups.map((group) => (
        <Card key={group.slug} variant="frosted">
          <CardHeader>
            <CardTitle className="text-3xl">{group.name}</CardTitle>
            <CardDescription>{group.slug}</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            {group.items.map((item) => (
              <div
                key={item.paymentId}
                className="grid gap-3 rounded-card border border-border bg-background/70 px-5 py-5 dark:bg-background/20 md:grid-cols-[1.3fr_0.7fr_0.7fr]"
              >
                <div className="space-y-2">
                  <div className="text-lg font-medium">{item.route.title}</div>
                  <div className="text-sm text-muted-foreground">
                    {item.route.ref} · {item.route.billingType} · {item.route.mode}
                  </div>
                  <div className="text-sm text-muted-foreground">
                    Payment {item.paymentId} · {formatTimestamp(item.createdAt)}
                  </div>
                </div>
                <div className="space-y-2 text-sm text-muted-foreground">
                  <div>Status: {formatStatus(item.status)}</div>
                  <div>Charge: ${item.amount} {item.tokenSymbol}</div>
                  {item.job ? <div>Job: {item.job.jobToken} · {item.job.status}</div> : null}
                </div>
                <div className="space-y-2 text-sm text-muted-foreground">
                  {item.refund ? (
                    <>
                      <div>Refund: {item.refund.status}</div>
                      <div>Amount: ${item.refund.amount}</div>
                      <div>{item.refund.txHash ? `Tx ${item.refund.txHash}` : "Awaiting settlement"}</div>
                    </>
                  ) : (
                    <div>No refund</div>
                  )}
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
