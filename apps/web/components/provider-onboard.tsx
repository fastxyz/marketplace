"use client";

import React from "react";
import Link from "next/link";
import type { MarketplaceDeploymentNetwork } from "@/lib/marketplace-shared";

import { ProviderSessionGate } from "@/components/provider-session-gate";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { fetchProviderAccount, upsertProviderAccount } from "@/lib/api";

export function ProviderOnboard({
  apiBaseUrl,
  deploymentNetwork
}: {
  apiBaseUrl: string;
  deploymentNetwork: MarketplaceDeploymentNetwork;
}) {
  return (
    <ProviderSessionGate
      deploymentNetwork={deploymentNetwork}
      title="Provider onboarding"
      description="Create the provider profile tied to your connected Fast wallet."
    >
      {(session) => <ProviderOnboardInner apiBaseUrl={apiBaseUrl} accessToken={session.accessToken} />}
    </ProviderSessionGate>
  );
}

function ProviderOnboardInner({ apiBaseUrl, accessToken }: { apiBaseUrl: string; accessToken: string }) {
  const [form, setForm] = React.useState({
    displayName: "",
    bio: "",
    websiteUrl: "",
    contactEmail: ""
  });
  const [pending, startTransition] = React.useTransition();
  const [message, setMessage] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    startTransition(async () => {
      try {
        const account = await fetchProviderAccount(apiBaseUrl, accessToken);
        if (!account) {
          return;
        }

        setForm({
          displayName: account.displayName,
          bio: account.bio ?? "",
          websiteUrl: account.websiteUrl ?? "",
          contactEmail: account.contactEmail ?? ""
        });
      } catch (nextError) {
        setError(nextError instanceof Error ? nextError.message : "Failed to load provider account.");
      }
    });
  }, [accessToken, apiBaseUrl]);

  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setMessage(null);

    startTransition(async () => {
      try {
        await upsertProviderAccount(apiBaseUrl, accessToken, {
          displayName: form.displayName,
          bio: form.bio || undefined,
          websiteUrl: form.websiteUrl || undefined,
          contactEmail: form.contactEmail || undefined
        });
        setMessage("Provider profile saved.");
      } catch (nextError) {
        setError(nextError instanceof Error ? nextError.message : "Provider profile save failed.");
      }
    });
  }

  return (
    <Card variant="frosted">
      <CardHeader>
        <CardTitle className="text-3xl">Provider profile</CardTitle>
        <CardDescription>This profile owns service drafts and is used as the public service attribution after publish.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <form className="grid gap-4" onSubmit={onSubmit}>
          <label className="grid gap-2 text-sm font-medium">
            Display name
            <Input
              value={form.displayName}
              onChange={(event) => setForm((current) => ({ ...current, displayName: event.target.value }))}
              placeholder="Fallom Labs"
              required
            />
          </label>

          <label className="grid gap-2 text-sm font-medium">
            Bio
            <Textarea
              value={form.bio}
              onChange={(event) => setForm((current) => ({ ...current, bio: event.target.value }))}
              placeholder="What this provider builds and why."
            />
          </label>

          <div className="grid gap-4 md:grid-cols-2">
            <label className="grid gap-2 text-sm font-medium">
              Website URL
              <Input
                value={form.websiteUrl}
                onChange={(event) => setForm((current) => ({ ...current, websiteUrl: event.target.value }))}
                placeholder="https://example.com"
              />
            </label>

            <label className="grid gap-2 text-sm font-medium">
              Contact email
              <Input
                type="email"
                value={form.contactEmail}
                onChange={(event) => setForm((current) => ({ ...current, contactEmail: event.target.value }))}
                placeholder="builder@example.com"
              />
            </label>
          </div>

          <div className="flex flex-wrap gap-3">
            <Button type="submit" disabled={pending}>
              {pending ? "Saving..." : "Save provider profile"}
            </Button>
            <Button type="button" variant="outline" onClick={() => window.location.assign("/providers/services")}>
              Open service drafts
            </Button>
          </div>
        </form>

        {message ? <p className="text-sm text-muted-foreground">{message}</p> : null}
        {error ? <p className="text-sm text-muted-foreground">{error}</p> : null}

        <div className="text-sm text-muted-foreground">
          The connected wallet is the only owner in v1. If you need operator approval after submit, use the review page for that service.
        </div>

        <Link href="/" className="fast-link">
          Back to marketplace
        </Link>
      </CardContent>
    </Card>
  );
}
