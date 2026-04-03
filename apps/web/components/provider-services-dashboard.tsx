"use client";

import React from "react";
import type { MarketplaceDeploymentNetwork, ProviderServiceType } from "@/lib/marketplace-shared";

import { ProviderSessionGate } from "@/components/provider-session-gate";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { createProviderService, fetchProviderAccount, fetchProviderServices } from "@/lib/api";

export function ProviderServicesDashboard({
  apiBaseUrl,
  deploymentNetwork
}: {
  apiBaseUrl: string;
  deploymentNetwork: MarketplaceDeploymentNetwork;
}) {
  return (
    <ProviderSessionGate
      deploymentNetwork={deploymentNetwork}
      title="Provider services"
      description="Create, edit, verify, and submit service drafts from the connected wallet."
    >
      {(session) => (
        <ProviderServicesDashboardInner
          apiBaseUrl={apiBaseUrl}
          accessToken={session.accessToken}
        />
      )}
    </ProviderSessionGate>
  );
}

function ProviderServicesDashboardInner({
  apiBaseUrl,
  accessToken
}: {
  apiBaseUrl: string;
  accessToken: string;
}) {
  type ServiceDraftField =
    | "serviceType"
    | "slug"
    | "apiNamespace"
    | "name"
    | "tagline"
    | "about"
    | "categories"
    | "promptIntro"
    | "setupInstructions"
    | "websiteUrl"
    | "payoutWallet";
  const [services, setServices] = React.useState<Awaited<ReturnType<typeof fetchProviderServices>>>([]);
  const [hasAccount, setHasAccount] = React.useState<boolean | null>(null);
  const [pending, startTransition] = React.useTransition();
  const [error, setError] = React.useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = React.useState<Partial<Record<ServiceDraftField, string>>>({});
  const [form, setForm] = React.useState({
    serviceType: "marketplace_proxy" as ProviderServiceType,
    slug: "",
    apiNamespace: "",
    name: "",
    tagline: "",
    about: "",
    categories: "",
    promptIntro: "",
    setupInstructions: "",
    websiteUrl: "",
    payoutWallet: ""
  });

  React.useEffect(() => {
    startTransition(async () => {
      try {
        const [account, nextServices] = await Promise.all([
          fetchProviderAccount(apiBaseUrl, accessToken),
          fetchProviderServices(apiBaseUrl, accessToken)
        ]);
        setHasAccount(Boolean(account));
        setServices(nextServices);
      } catch (nextError) {
        setError(nextError instanceof Error ? nextError.message : "Failed to load provider services.");
      }
    });
  }, [accessToken, apiBaseUrl]);

  function onCreateService(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const nextFieldErrors = validateServiceDraftForm(form);
    setFieldErrors(nextFieldErrors);

    if (Object.keys(nextFieldErrors).length > 0) {
      setError("Fix the highlighted fields before creating the draft.");
      return;
    }

    startTransition(async () => {
      try {
        setFieldErrors({});
        const detail = await createProviderService(apiBaseUrl, accessToken, {
          serviceType: form.serviceType,
          slug: form.slug,
          apiNamespace: form.serviceType === "marketplace_proxy" ? form.apiNamespace : undefined,
          name: form.name,
          tagline: form.tagline,
          about: form.about,
          categories: form.categories
            .split(",")
            .map((value) => value.trim())
            .filter(Boolean),
          promptIntro: form.promptIntro || `I want to use the "${form.name}" service on Fast Marketplace.`,
          setupInstructions: form.setupInstructions
            .split("\n")
            .map((value) => value.trim())
            .filter(Boolean),
          websiteUrl: form.websiteUrl || undefined,
          payoutWallet: form.serviceType === "marketplace_proxy" ? form.payoutWallet : undefined
        });
        window.location.assign(`/providers/services/${detail.service.id}`);
      } catch (nextError) {
        setError(nextError instanceof Error ? nextError.message : "Service creation failed.");
      }
    });
  }

  if (hasAccount === false) {
    return (
      <Card variant="frosted">
        <CardHeader>
          <CardTitle>Create a provider profile first</CardTitle>
          <CardDescription>Service drafts are attached to the provider account for this wallet session.</CardDescription>
        </CardHeader>
        <CardContent>
          <Button onClick={() => window.location.assign("/providers/onboard")}>Open onboarding</Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_1.1fr]">
      <Card variant="frosted">
        <CardHeader>
          <CardTitle className="text-3xl">Your service drafts</CardTitle>
          <CardDescription>Published services stay live while you keep editing the next draft version.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          {services.length === 0 ? (
            <p className="text-sm text-muted-foreground">No service drafts yet.</p>
          ) : null}
          {services.map((service) => (
            <div key={service.service.id} className="rounded-card border border-border bg-background/70 p-5 dark:bg-background/20">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <div className="text-lg font-medium tracking-headline">{service.service.name}</div>
                  <div className="text-sm leading-6 text-muted-foreground">
                    {service.service.serviceType === "marketplace_proxy"
                      ? `${service.service.apiNamespace} / ${service.service.status}`
                      : `external registry / ${service.service.status}`}
                  </div>
                </div>
                <div className="flex gap-2">
                  <Button variant="outline" onClick={() => window.location.assign(`/providers/services/${service.service.id}`)}>
                    Edit
                  </Button>
                  <Button variant="outline" onClick={() => window.location.assign(`/providers/services/${service.service.id}/review`)}>
                    Review
                  </Button>
                </div>
              </div>
              <div className="mt-3 text-sm text-muted-foreground">
                {service.endpoints.length} endpoint draft{service.endpoints.length === 1 ? "" : "s"}
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card variant="frosted">
        <CardHeader>
          <CardTitle className="text-3xl">New service draft</CardTitle>
          <CardDescription>Create the public service metadata first, then add endpoints and any required verification.</CardDescription>
        </CardHeader>
        <CardContent>
          <form className="grid gap-4" onSubmit={onCreateService}>
            <label className="grid gap-2 text-sm font-medium">
              Service type
              <select
                value={form.serviceType}
                className="fast-select min-h-12"
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    serviceType: event.target.value as ProviderServiceType,
                    apiNamespace: event.target.value === "marketplace_proxy" ? current.apiNamespace : "",
                    payoutWallet: event.target.value === "marketplace_proxy" ? current.payoutWallet : ""
                  }))}
              >
                <option value="marketplace_proxy">Marketplace proxy</option>
                <option value="external_registry">External registry</option>
              </select>
            </label>
            <div className="grid gap-4 md:grid-cols-2">
              <label className="grid gap-2 text-sm font-medium">
                Service name
                <Input
                  value={form.name}
                  minLength={2}
                  maxLength={120}
                  placeholder="Test Service 1"
                  onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))}
                  required
                />
                {fieldErrors.name ? <span className="text-xs text-destructive">{fieldErrors.name}</span> : null}
              </label>
              <label className="grid gap-2 text-sm font-medium">
                Tagline
                <Input
                  value={form.tagline}
                  minLength={5}
                  maxLength={240}
                  placeholder="Providing data for testing"
                  onChange={(event) => setForm((current) => ({ ...current, tagline: event.target.value }))}
                  required
                />
                {fieldErrors.tagline ? <span className="text-xs text-destructive">{fieldErrors.tagline}</span> : null}
              </label>
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <label className="grid gap-2 text-sm font-medium">
                Slug
                <Input
                  value={form.slug}
                  minLength={3}
                  maxLength={64}
                  pattern="^[a-z0-9-]{3,64}$"
                  placeholder="test-service-1"
                  onChange={(event) => setForm((current) => ({ ...current, slug: event.target.value }))}
                  required
                />
                {fieldErrors.slug ? <span className="text-xs text-destructive">{fieldErrors.slug}</span> : null}
              </label>
              {form.serviceType === "marketplace_proxy" ? (
                <label className="grid gap-2 text-sm font-medium">
                  API namespace
                  <Input
                    value={form.apiNamespace}
                    minLength={3}
                    maxLength={64}
                    pattern="^[a-z0-9-]{3,64}$"
                    placeholder="test-service"
                    onChange={(event) => setForm((current) => ({ ...current, apiNamespace: event.target.value }))}
                    required
                  />
                  {fieldErrors.apiNamespace ? <span className="text-xs text-destructive">{fieldErrors.apiNamespace}</span> : null}
                </label>
              ) : (
                <div className="rounded-card border border-border bg-background/70 px-4 py-3 text-sm text-muted-foreground dark:bg-background/20">
                  External registry services do not define a marketplace API namespace.
                </div>
              )}
            </div>

            <label className="grid gap-2 text-sm font-medium">
              About
              <Textarea
                value={form.about}
                minLength={20}
                maxLength={4000}
                placeholder="Providing data to users through a Fast-native paid API."
                onChange={(event) => setForm((current) => ({ ...current, about: event.target.value }))}
                required
              />
              {fieldErrors.about ? <span className="text-xs text-destructive">{fieldErrors.about}</span> : null}
            </label>

            <div className="grid gap-4 md:grid-cols-2">
              <label className="grid gap-2 text-sm font-medium">
                Categories
                <Input
                  value={form.categories}
                  placeholder="Research, Finance"
                  onChange={(event) => setForm((current) => ({ ...current, categories: event.target.value }))}
                />
                {fieldErrors.categories ? <span className="text-xs text-destructive">{fieldErrors.categories}</span> : null}
              </label>
              <label className="grid gap-2 text-sm font-medium">
                Website URL
                <Input
                  value={form.websiteUrl}
                  type="url"
                  onChange={(event) => setForm((current) => ({ ...current, websiteUrl: event.target.value }))}
                  placeholder="https://example.com"
                />
                {fieldErrors.websiteUrl ? <span className="text-xs text-destructive">{fieldErrors.websiteUrl}</span> : null}
              </label>
            </div>

            <label className="grid gap-2 text-sm font-medium">
              Prompt intro
              <Textarea
                value={form.promptIntro}
                minLength={10}
                maxLength={500}
                placeholder='I want to use the "Test Service 1" service on Fast Marketplace.'
                onChange={(event) => setForm((current) => ({ ...current, promptIntro: event.target.value }))}
              />
              <span className="text-xs text-muted-foreground">
                Leave blank to auto-generate a prompt from the service name.
              </span>
              {fieldErrors.promptIntro ? <span className="text-xs text-destructive">{fieldErrors.promptIntro}</span> : null}
            </label>

            <label className="grid gap-2 text-sm font-medium">
              Setup instructions
              <Textarea
                value={form.setupInstructions}
                placeholder={"Review the service docs.\nCall the paid endpoints with a funded Fast wallet."}
                onChange={(event) => setForm((current) => ({ ...current, setupInstructions: event.target.value }))}
              />
              {fieldErrors.setupInstructions ? <span className="text-xs text-destructive">{fieldErrors.setupInstructions}</span> : null}
            </label>

            {form.serviceType === "marketplace_proxy" ? (
              <label className="grid gap-2 text-sm font-medium">
                Payout wallet
                <Input
                  value={form.payoutWallet}
                  placeholder="fast1rv8wsdd5pnkit4u637g2yj4tpuyq26rzw8380rfapnsnljz7v3tqv4ajuq"
                  onChange={(event) => setForm((current) => ({ ...current, payoutWallet: event.target.value }))}
                  required
                />
                {fieldErrors.payoutWallet ? <span className="text-xs text-destructive">{fieldErrors.payoutWallet}</span> : null}
              </label>
            ) : (
              <div className="rounded-card border border-border bg-background/70 px-4 py-3 text-sm text-muted-foreground dark:bg-background/20">
                External registry services stay discovery-only and do not use marketplace payouts.
              </div>
            )}

            <Button type="submit" disabled={pending}>
              {pending ? "Creating..." : "Create draft"}
            </Button>
            {error ? <p className="text-sm text-muted-foreground">{error}</p> : null}
          </form>
        </CardContent>
      </Card>
    </div>
  );
}

function validateServiceDraftForm(form: {
  serviceType: ProviderServiceType;
  slug: string;
  apiNamespace: string;
  name: string;
  tagline: string;
  about: string;
  categories: string;
  promptIntro: string;
  setupInstructions: string;
  websiteUrl: string;
  payoutWallet: string;
}) {
  const fieldErrors: Partial<Record<
    | "slug"
    | "apiNamespace"
    | "name"
    | "tagline"
    | "about"
    | "categories"
    | "promptIntro"
    | "setupInstructions"
    | "websiteUrl"
    | "payoutWallet",
    string
  >> = {};
  const slugPattern = /^[a-z0-9-]{3,64}$/;
  const categories = form.categories
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const setupInstructions = form.setupInstructions
    .split("\n")
    .map((value) => value.trim())
    .filter(Boolean);
  const promptIntro = form.promptIntro.trim() || `I want to use the "${form.name.trim()}" service on Fast Marketplace.`;

  if (!slugPattern.test(form.slug.trim())) {
    fieldErrors.slug = "Use 3-64 lowercase letters, numbers, or hyphens.";
  }

  if (form.serviceType === "marketplace_proxy" && !slugPattern.test(form.apiNamespace.trim())) {
    fieldErrors.apiNamespace = "Use 3-64 lowercase letters, numbers, or hyphens.";
  }

  if (form.name.trim().length < 2 || form.name.trim().length > 120) {
    fieldErrors.name = "Name must be between 2 and 120 characters.";
  }

  if (form.tagline.trim().length < 5 || form.tagline.trim().length > 240) {
    fieldErrors.tagline = "Tagline must be between 5 and 240 characters.";
  }

  if (form.about.trim().length < 20 || form.about.trim().length > 4_000) {
    fieldErrors.about = "About must be between 20 and 4000 characters.";
  }

  if (categories.length < 1 || categories.length > 8 || categories.some((value) => value.length < 2 || value.length > 40)) {
    fieldErrors.categories = "Use 1-8 categories, each between 2 and 40 characters.";
  }

  if (promptIntro.length < 10 || promptIntro.length > 500) {
    fieldErrors.promptIntro = "Prompt intro must be between 10 and 500 characters.";
  }

  if (
    setupInstructions.length < 1 ||
    setupInstructions.length > 10 ||
    setupInstructions.some((value) => value.length < 3 || value.length > 240)
  ) {
    fieldErrors.setupInstructions = "Use 1-10 setup steps, each between 3 and 240 characters.";
  }

  if (form.websiteUrl.trim()) {
    try {
      new URL(form.websiteUrl.trim());
    } catch {
      fieldErrors.websiteUrl = "Website URL must be a valid URL.";
    }
  }

  if (form.serviceType === "marketplace_proxy" && !form.payoutWallet.trim()) {
    fieldErrors.payoutWallet = "Payout wallet is required.";
  }

  return fieldErrors;
}
