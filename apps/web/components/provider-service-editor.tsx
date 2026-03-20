"use client";

import React from "react";
import type {
  CreateProviderEndpointDraftInput,
  MarketplaceDeploymentNetwork,
  OpenApiImportPreview,
  RouteBillingType,
  UpdateProviderEndpointDraftInput
} from "@marketplace/shared";

import { CopyButton } from "@/components/copy-button";
import { ProviderSessionGate } from "@/components/provider-session-gate";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  createProviderEndpoint,
  fetchProviderRuntimeKey,
  createProviderVerificationChallenge,
  deleteProviderEndpoint,
  fetchProviderService,
  importProviderOpenApi,
  rotateProviderRuntimeKey,
  submitProviderService,
  updateProviderEndpoint,
  updateProviderService,
  verifyProviderService
} from "@/lib/api";

const SELECT_CLASS_NAME = "fast-select min-h-12";

function usesFixedPrice(billingType: RouteBillingType): boolean {
  return billingType === "fixed_x402";
}

function usesTopupRange(billingType: RouteBillingType): boolean {
  return billingType === "topup_x402_variable";
}

function usesUpstreamConfig(billingType: RouteBillingType): boolean {
  return billingType !== "topup_x402_variable";
}

function usesUpstreamSecret(authMode: EndpointFormState["upstreamAuthMode"]): boolean {
  return authMode === "bearer" || authMode === "header";
}

export function ProviderServiceEditor({
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
      title="Provider service editor"
      description="Edit metadata, configure endpoints, and complete ownership verification."
    >
      {(session) => (
        <ProviderServiceEditorInner
          apiBaseUrl={apiBaseUrl}
          accessToken={session.accessToken}
          serviceId={serviceId}
        />
      )}
    </ProviderSessionGate>
  );
}

function ProviderServiceEditorInner({
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
  const [runtimeSecret, setRuntimeSecret] = React.useState<string | null>(null);
  const [pending, startTransition] = React.useTransition();
  const [message, setMessage] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [challenge, setChallenge] = React.useState<{ token: string; expectedUrl: string } | null>(null);

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
        setError(nextError instanceof Error ? nextError.message : "Failed to load service draft.");
      }
    });
  }, [accessToken, apiBaseUrl, serviceId]);

  const [newEndpoint, setNewEndpoint] = React.useState(defaultEndpointFormState());
  const [openApiUrl, setOpenApiUrl] = React.useState("");
  const [openApiPreview, setOpenApiPreview] = React.useState<OpenApiImportPreview | null>(null);

  if (detail === undefined) {
    return (
      <Card variant="frosted">
        <CardContent className="p-6 text-sm text-muted-foreground">
          {error ?? "Loading service draft..."}
        </CardContent>
      </Card>
    );
  }

  if (detail === null) {
    return (
      <Card variant="frosted">
        <CardHeader>
          <CardTitle>Service draft unavailable</CardTitle>
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

  async function refresh() {
    const [nextDetail, nextRuntimeKey] = await Promise.all([
      fetchProviderService(apiBaseUrl, accessToken, serviceId),
      fetchProviderRuntimeKey(apiBaseUrl, accessToken, serviceId)
    ]);
    setDetail(nextDetail);
    setRuntimeKey(nextRuntimeKey);
  }

  function onSaveService(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setError(null);
    setMessage(null);

    startTransition(async () => {
      try {
        await updateProviderService(apiBaseUrl, accessToken, serviceId, {
          name: String(form.get("name") ?? ""),
          tagline: String(form.get("tagline") ?? ""),
          about: String(form.get("about") ?? ""),
          categories: String(form.get("categories") ?? "")
            .split(",")
            .map((value) => value.trim())
            .filter(Boolean),
          promptIntro: String(form.get("promptIntro") ?? ""),
          setupInstructions: String(form.get("setupInstructions") ?? "")
            .split("\n")
            .map((value) => value.trim())
            .filter(Boolean),
          websiteUrl: String(form.get("websiteUrl") ?? "") || null,
          payoutWallet: String(form.get("payoutWallet") ?? "") || null
        });
        await refresh();
        setMessage("Service draft updated.");
      } catch (nextError) {
        setError(nextError instanceof Error ? nextError.message : "Service update failed.");
      }
    });
  }

  function onCreateEndpoint(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setMessage(null);

    startTransition(async () => {
      try {
        await createProviderEndpoint(apiBaseUrl, accessToken, serviceId, buildEndpointInput(newEndpoint));
        setNewEndpoint(defaultEndpointFormState());
        await refresh();
        setMessage("Endpoint draft created.");
      } catch (nextError) {
        setError(nextError instanceof Error ? nextError.message : "Endpoint creation failed.");
      }
    });
  }

  function onImportOpenApi(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setMessage(null);

    startTransition(async () => {
      try {
        const preview = await importProviderOpenApi(apiBaseUrl, accessToken, serviceId, openApiUrl);
        setOpenApiPreview(preview);
        setMessage(
          preview.endpoints.length === 0
            ? "OpenAPI import loaded, but no importable POST operations were found."
            : `OpenAPI import loaded ${preview.endpoints.length} candidate endpoint${preview.endpoints.length === 1 ? "" : "s"}.`
        );
      } catch (nextError) {
        setError(nextError instanceof Error ? nextError.message : "OpenAPI import failed.");
      }
    });
  }

  function onCreateVerificationChallenge() {
    setError(null);
    setMessage(null);

    startTransition(async () => {
      try {
        setChallenge(await createProviderVerificationChallenge(apiBaseUrl, accessToken, serviceId));
      } catch (nextError) {
        setError(nextError instanceof Error ? nextError.message : "Failed to create verification challenge.");
      }
    });
  }

  function onVerifyService() {
    setError(null);
    setMessage(null);

    startTransition(async () => {
      try {
        await verifyProviderService(apiBaseUrl, accessToken, serviceId);
        await refresh();
        setMessage("Verification status refreshed.");
      } catch (nextError) {
        setError(nextError instanceof Error ? nextError.message : "Service verification failed.");
      }
    });
  }

  function onSubmitService() {
    setError(null);
    setMessage(null);

    startTransition(async () => {
      try {
        await submitProviderService(apiBaseUrl, accessToken, serviceId);
        await refresh();
        setMessage("Service submitted for review.");
      } catch (nextError) {
        setError(nextError instanceof Error ? nextError.message : "Service submit failed.");
      }
    });
  }

  function onRotateRuntimeKey() {
    setError(null);
    setMessage(null);

    startTransition(async () => {
      try {
        const nextKey = await rotateProviderRuntimeKey(apiBaseUrl, accessToken, serviceId);
        setRuntimeKey(nextKey.runtimeKey);
        setRuntimeSecret(nextKey.plaintextKey);
        setMessage("Runtime key rotated. Copy the plaintext key now.");
      } catch (nextError) {
        setError(nextError instanceof Error ? nextError.message : "Runtime key rotation failed.");
      }
    });
  }

  return (
    <div className="grid gap-6">
      <Card variant="frosted">
        <CardHeader>
          <CardTitle className="text-3xl">{detail.service.name}</CardTitle>
          <CardDescription>{detail.service.apiNamespace} · {detail.service.status}</CardDescription>
        </CardHeader>
        <CardContent>
          <form className="grid gap-4" onSubmit={onSaveService}>
            <div className="grid gap-4 md:grid-cols-2">
              <label className="grid gap-2 text-sm font-medium">
                Name
                <Input name="name" defaultValue={detail.service.name} />
              </label>
              <label className="grid gap-2 text-sm font-medium">
                Tagline
                <Input name="tagline" defaultValue={detail.service.tagline} />
              </label>
            </div>
            <label className="grid gap-2 text-sm font-medium">
              About
              <Textarea name="about" defaultValue={detail.service.about} />
            </label>
            <div className="grid gap-4 md:grid-cols-2">
              <label className="grid gap-2 text-sm font-medium">
                Categories
                <Input name="categories" defaultValue={detail.service.categories.join(", ")} />
              </label>
              <label className="grid gap-2 text-sm font-medium">
                Website URL
                <Input name="websiteUrl" defaultValue={detail.service.websiteUrl ?? ""} />
              </label>
            </div>
            <label className="grid gap-2 text-sm font-medium">
              Prompt intro
              <Textarea name="promptIntro" defaultValue={detail.service.promptIntro} />
            </label>
            <label className="grid gap-2 text-sm font-medium">
              Setup instructions
              <Textarea name="setupInstructions" defaultValue={detail.service.setupInstructions.join("\n")} />
            </label>
            <label className="grid gap-2 text-sm font-medium">
              Payout wallet
              <Input name="payoutWallet" defaultValue={detail.service.payoutWallet ?? ""} />
            </label>
            <div className="flex flex-wrap gap-3">
              <Button type="submit" disabled={pending}>{pending ? "Saving..." : "Save metadata"}</Button>
              <Button type="button" variant="outline" onClick={() => window.location.assign(`/providers/services/${serviceId}/review`)}>
                Open review page
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      <Card variant="frosted">
        <CardHeader>
          <CardTitle className="text-3xl">Settlement tier</CardTitle>
          <CardDescription>
            Current tier: {detail.service.settlementMode === "verified_escrow" ? "Verified" : "Community"}.
            Providers cannot switch this themselves in v1.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4 text-sm text-muted-foreground">
          <div className="rounded-card border border-border bg-background/70 p-5 dark:bg-background/20">
            {detail.service.settlementMode === "verified_escrow"
              ? "Verified services use marketplace escrow, marketplace refunds, and marketplace payout settlement."
              : "Community services are paid directly, require a runtime key for signed buyer identity headers, and provider-owned refund handling."}
          </div>
          <div className="rounded-card border border-border bg-background/70 p-5 dark:bg-background/20 space-y-3">
            <div className="font-medium text-foreground">Provider runtime key</div>
            <div>{runtimeKey ? `Active key: ${runtimeKey.keyPrefix}` : "No runtime key created yet."}</div>
            <div className="flex flex-wrap gap-3">
              <Button type="button" variant="outline" onClick={onRotateRuntimeKey} disabled={pending}>
                {runtimeKey ? "Rotate runtime key" : "Create runtime key"}
              </Button>
            </div>
            {runtimeSecret ? (
              <div className="flex items-center justify-between gap-3 rounded-card border border-border bg-background/80 p-4 dark:bg-background/30">
                <div>
                  <div className="text-xs text-muted-foreground">Plaintext runtime key</div>
                  <div className="break-all font-mono text-sm text-foreground">{runtimeSecret}</div>
                </div>
                <CopyButton value={runtimeSecret} />
              </div>
            ) : null}
          </div>
        </CardContent>
      </Card>

      <Card variant="frosted">
        <CardHeader>
          <CardTitle className="text-3xl">Website verification</CardTitle>
          <CardDescription>Host the issued token on your site before submitting this service for review.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="text-sm text-muted-foreground">
            Current status: {detail.verification?.status ?? "not started"}
          </div>
          <div className="flex flex-wrap gap-3">
            <Button type="button" onClick={onCreateVerificationChallenge} disabled={pending}>
              Create challenge
            </Button>
            <Button type="button" variant="outline" onClick={onVerifyService} disabled={pending}>
              Verify ownership
            </Button>
            <Button type="button" variant="outline" onClick={onSubmitService} disabled={pending}>
              Submit for review
            </Button>
          </div>
          {challenge ? (
            <div className="grid gap-4 rounded-card border border-border bg-background/70 p-5 dark:bg-background/20">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-xs text-muted-foreground">Expected URL</div>
                  <div className="text-sm font-medium break-all">{challenge.expectedUrl}</div>
                </div>
                <CopyButton value={challenge.expectedUrl} />
              </div>
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-xs text-muted-foreground">Token</div>
                  <div className="text-sm font-medium break-all">{challenge.token}</div>
                </div>
                <CopyButton value={challenge.token} />
              </div>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card variant="frosted">
        <CardHeader>
          <CardTitle className="text-3xl">Endpoint drafts</CardTitle>
          <CardDescription>Provider-authored endpoints are POST JSON and sync-only in v1.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-6">
          {detail.endpoints.map((endpoint) => (
            <EndpointDraftCard
              key={endpoint.id}
              apiBaseUrl={apiBaseUrl}
              accessToken={accessToken}
              serviceId={serviceId}
              endpoint={endpoint}
              onChange={async () => {
                await refresh();
                setMessage("Endpoint draft updated.");
              }}
              onDelete={async () => {
                await deleteProviderEndpoint(apiBaseUrl, accessToken, serviceId, endpoint.id);
                await refresh();
                setMessage("Endpoint draft deleted.");
              }}
            />
          ))}

          <form
            className="grid gap-4 rounded-card border border-border bg-background/70 p-5 dark:bg-background/20"
            onSubmit={onImportOpenApi}
          >
            <div className="metric-label">Import from OpenAPI</div>
            <label className="grid gap-2 text-sm font-medium">
              OpenAPI JSON URL
              <Input
                value={openApiUrl}
                type="url"
                placeholder="https://api.example.com/openapi.json"
                required
                onChange={(event) => setOpenApiUrl(event.target.value)}
              />
            </label>
            <div className="text-sm text-muted-foreground">
              Import previews only. Load a candidate into the new endpoint form, then choose billing, set price if needed,
              and add any upstream secret before creating the draft.
            </div>
            <div className="flex flex-wrap gap-3">
              <Button type="submit" variant="outline" disabled={pending}>
                {pending ? "Loading..." : "Load OpenAPI"}
              </Button>
            </div>
            {openApiPreview ? (
              <div className="grid gap-4 rounded-card border border-border bg-background/80 p-4 dark:bg-background/30">
                <div>
                  <div className="text-sm font-medium text-foreground">
                    {openApiPreview.title ?? "Imported OpenAPI document"}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {openApiPreview.version ? `Version ${openApiPreview.version} · ` : ""}
                    {openApiPreview.documentUrl}
                  </div>
                </div>
                {openApiPreview.warnings.length > 0 ? (
                  <div className="grid gap-2 text-sm text-muted-foreground">
                    {openApiPreview.warnings.map((warning) => (
                      <div key={warning}>{warning}</div>
                    ))}
                  </div>
                ) : null}
                {openApiPreview.endpoints.map((candidate) => (
                  <div key={`${candidate.operation}:${candidate.upstreamPath}`} className="grid gap-3 rounded-card border border-border p-4">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <div className="font-medium text-foreground">{candidate.title}</div>
                        <div className="text-xs text-muted-foreground">
                          {candidate.operation} · POST {candidate.upstreamPath}
                        </div>
                      </div>
                      <Button type="button" variant="outline" onClick={() => setNewEndpoint(openApiCandidateToFormState(candidate))}>
                        Load into new draft
                      </Button>
                    </div>
                    <div className="text-sm text-muted-foreground">{candidate.description}</div>
                    <div className="text-xs text-muted-foreground">
                      Base URL: {candidate.upstreamBaseUrl} · Auth: {candidate.upstreamAuthMode}
                      {candidate.upstreamAuthHeaderName ? ` (${candidate.upstreamAuthHeaderName})` : ""}
                    </div>
                    {candidate.warnings.length > 0 ? (
                      <div className="grid gap-2 text-xs text-muted-foreground">
                        {candidate.warnings.map((warning) => (
                          <div key={warning}>{warning}</div>
                        ))}
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            ) : null}
          </form>

          <form className="grid gap-4 rounded-card border border-border bg-background/70 p-5 dark:bg-background/20" onSubmit={onCreateEndpoint}>
            <div className="metric-label">New endpoint</div>
            <EndpointDraftFields state={newEndpoint} onChange={setNewEndpoint} />
            <Button type="submit" disabled={pending}>
              {pending ? "Creating..." : "Create endpoint"}
            </Button>
          </form>
        </CardContent>
      </Card>

      {message ? <p className="text-sm text-muted-foreground">{message}</p> : null}
      {error ? <p className="text-sm text-muted-foreground">{error}</p> : null}
    </div>
  );
}

function EndpointDraftCard({
  apiBaseUrl,
  accessToken,
  serviceId,
  endpoint,
  onChange,
  onDelete
}: {
  apiBaseUrl: string;
  accessToken: string;
  serviceId: string;
  endpoint: Awaited<ReturnType<typeof fetchProviderService>> extends infer T
    ? T extends { endpoints: infer U }
      ? U extends Array<infer V>
        ? V
        : never
      : never
    : never;
  onChange: () => Promise<void>;
  onDelete: () => Promise<void>;
}) {
  const [state, setState] = React.useState(() => endpointToFormState(endpoint));
  const [pending, startTransition] = React.useTransition();
  const [error, setError] = React.useState<string | null>(null);

  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    startTransition(async () => {
      try {
        await updateProviderEndpoint(
          apiBaseUrl,
          accessToken,
          serviceId,
          endpoint.id,
          buildEndpointUpdateInput(state, endpoint.hasUpstreamSecret)
        );
        await onChange();
      } catch (nextError) {
        setError(nextError instanceof Error ? nextError.message : "Endpoint update failed.");
      }
    });
  }

  return (
    <form className="grid gap-4 rounded-card border border-border bg-background/70 p-5 dark:bg-background/20" onSubmit={onSubmit}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="text-lg font-medium tracking-headline">{endpoint.title}</div>
          <div className="text-xs text-muted-foreground">{endpoint.operation}</div>
        </div>
        <div className="flex gap-2">
          <Button type="submit" variant="outline" disabled={pending}>
            {pending ? "Saving..." : "Save"}
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={pending}
            onClick={() => {
              startTransition(async () => {
                try {
                  await onDelete();
                } catch (nextError) {
                  setError(nextError instanceof Error ? nextError.message : "Endpoint delete failed.");
                }
              });
            }}
          >
            Delete
          </Button>
        </div>
      </div>
      <EndpointDraftFields state={state} onChange={setState} />
      {error ? <p className="text-sm text-muted-foreground">{error}</p> : null}
    </form>
  );
}

function EndpointDraftFields({
  state,
  onChange
}: {
  state: EndpointFormState;
  onChange: React.Dispatch<React.SetStateAction<EndpointFormState>>;
}) {
  return (
    <>
      <div className="grid gap-4 md:grid-cols-2">
        <label className="grid gap-2 text-sm font-medium">
          Operation slug
          <Input
            value={state.operation}
            placeholder="quote-price"
            required
            onChange={(event) => onChange((current) => ({ ...current, operation: event.target.value }))}
          />
        </label>
        <label className="grid gap-2 text-sm font-medium">
          Billing
          <select
            value={state.billingType}
            className={SELECT_CLASS_NAME}
            onChange={(event) => onChange((current) => ({ ...current, billingType: event.target.value as RouteBillingType }))}
          >
            <option value="fixed_x402">Fixed x402</option>
            <option value="free">Free</option>
            <option value="prepaid_credit">Prepaid credit</option>
            <option value="topup_x402_variable">Variable top-up</option>
          </select>
        </label>
      </div>
      {usesFixedPrice(state.billingType) ? (
        <label className="grid gap-2 text-sm font-medium">
          Price
          <Input
            value={state.price}
            placeholder="$0.25"
            required
            onChange={(event) => onChange((current) => ({ ...current, price: event.target.value }))}
          />
        </label>
      ) : null}
      {usesTopupRange(state.billingType) ? (
        <div className="grid gap-4 md:grid-cols-2">
          <label className="grid gap-2 text-sm font-medium">
            Minimum amount
            <Input
              value={state.minAmount}
              placeholder="10"
              required
              onChange={(event) => onChange((current) => ({ ...current, minAmount: event.target.value }))}
            />
          </label>
          <label className="grid gap-2 text-sm font-medium">
            Maximum amount
            <Input
              value={state.maxAmount}
              placeholder="100"
              required
              onChange={(event) => onChange((current) => ({ ...current, maxAmount: event.target.value }))}
            />
          </label>
        </div>
      ) : null}
      <div className="grid gap-4 md:grid-cols-2">
        <label className="grid gap-2 text-sm font-medium">
          Title
          <Input
            value={state.title}
            placeholder="Get token quote"
            required
            onChange={(event) => onChange((current) => ({ ...current, title: event.target.value }))}
          />
        </label>
        {usesUpstreamConfig(state.billingType) ? (
          <label className="grid gap-2 text-sm font-medium">
            Upstream base URL
            <Input
              value={state.upstreamBaseUrl}
              type="url"
              placeholder="https://api.example.com"
              required
              onChange={(event) => onChange((current) => ({ ...current, upstreamBaseUrl: event.target.value }))}
            />
          </label>
        ) : null}
      </div>
      <label className="grid gap-2 text-sm font-medium">
        Description
        <Textarea
          value={state.description}
          placeholder="Return a live quote for a requested trading symbol."
          required
          onChange={(event) => onChange((current) => ({ ...current, description: event.target.value }))}
        />
      </label>
      {usesUpstreamConfig(state.billingType) ? (
        <>
          <div className="grid gap-4 md:grid-cols-2">
            <label className="grid gap-2 text-sm font-medium">
              Upstream path
              <Input
                value={state.upstreamPath}
                placeholder="/v1/quote"
                required
                onChange={(event) => onChange((current) => ({ ...current, upstreamPath: event.target.value }))}
              />
            </label>
            <label className="grid gap-2 text-sm font-medium">
              Auth mode
              <select
                value={state.upstreamAuthMode}
                className={SELECT_CLASS_NAME}
                onChange={(event) =>
                  onChange((current) => ({
                    ...current,
                    upstreamAuthMode: event.target.value as EndpointFormState["upstreamAuthMode"]
                  }))}
              >
                <option value="none">None</option>
                <option value="bearer">Bearer</option>
                <option value="header">Header</option>
              </select>
            </label>
          </div>
          {(state.upstreamAuthMode === "header" || usesUpstreamSecret(state.upstreamAuthMode)) ? (
            <div className="grid gap-4 md:grid-cols-2">
              {state.upstreamAuthMode === "header" ? (
                <label className="grid gap-2 text-sm font-medium">
                  Header name
                  <Input
                    value={state.upstreamAuthHeaderName}
                    placeholder="X-Provider-Key"
                    onChange={(event) => onChange((current) => ({ ...current, upstreamAuthHeaderName: event.target.value }))}
                  />
                </label>
              ) : (
                <div />
              )}
              {usesUpstreamSecret(state.upstreamAuthMode) ? (
                <label className="grid gap-2 text-sm font-medium">
                  Upstream secret
                  <Input
                    value={state.upstreamSecret}
                    placeholder="leave blank to keep current or paste a new secret"
                    onChange={(event) => onChange((current) => ({ ...current, upstreamSecret: event.target.value }))}
                  />
                </label>
              ) : null}
            </div>
          ) : null}
        </>
      ) : null}
      <label className="grid gap-2 text-sm font-medium">
        Usage notes
        <Textarea
          value={state.usageNotes}
          placeholder="Explain auth, request requirements, or any payment flow the caller should expect."
          onChange={(event) => onChange((current) => ({ ...current, usageNotes: event.target.value }))}
        />
      </label>
      <label className="grid gap-2 text-sm font-medium">
        Request schema JSON
        <Textarea
          value={state.requestSchemaJson}
          placeholder={REQUEST_SCHEMA_PLACEHOLDER}
          required
          onChange={(event) => onChange((current) => ({ ...current, requestSchemaJson: event.target.value }))}
          className="min-h-40 font-mono"
        />
      </label>
      <label className="grid gap-2 text-sm font-medium">
        Response schema JSON
        <Textarea
          value={state.responseSchemaJson}
          placeholder={RESPONSE_SCHEMA_PLACEHOLDER}
          required
          onChange={(event) => onChange((current) => ({ ...current, responseSchemaJson: event.target.value }))}
          className="min-h-40 font-mono"
        />
      </label>
      <label className="grid gap-2 text-sm font-medium">
        Request example JSON
        <Textarea
          value={state.requestExample}
          placeholder={REQUEST_EXAMPLE_PLACEHOLDER}
          required
          onChange={(event) => onChange((current) => ({ ...current, requestExample: event.target.value }))}
          className="min-h-32 font-mono"
        />
      </label>
      <label className="grid gap-2 text-sm font-medium">
        Response example JSON
        <Textarea
          value={state.responseExample}
          placeholder={RESPONSE_EXAMPLE_PLACEHOLDER}
          required
          onChange={(event) => onChange((current) => ({ ...current, responseExample: event.target.value }))}
          className="min-h-32 font-mono"
        />
      </label>
    </>
  );
}

interface EndpointFormState {
  operation: string;
  title: string;
  description: string;
  billingType: RouteBillingType;
  price: string;
  minAmount: string;
  maxAmount: string;
  requestSchemaJson: string;
  responseSchemaJson: string;
  requestExample: string;
  responseExample: string;
  usageNotes: string;
  upstreamBaseUrl: string;
  upstreamPath: string;
  upstreamAuthMode: "none" | "bearer" | "header";
  upstreamAuthHeaderName: string;
  upstreamSecret: string;
}

function defaultEndpointFormState(): EndpointFormState {
  return {
    operation: "",
    title: "",
    description: "",
    billingType: "fixed_x402",
    price: "",
    minAmount: "",
    maxAmount: "",
    requestSchemaJson: "",
    responseSchemaJson: "",
    requestExample: "",
    responseExample: "",
    usageNotes: "",
    upstreamBaseUrl: "",
    upstreamPath: "",
    upstreamAuthMode: "none",
    upstreamAuthHeaderName: "",
    upstreamSecret: ""
  };
}

const REQUEST_SCHEMA_PLACEHOLDER = `{
  "type": "object",
  "properties": {
    "symbol": {
      "type": "string"
    }
  },
  "required": ["symbol"],
  "additionalProperties": false
}`;

const RESPONSE_SCHEMA_PLACEHOLDER = `{
  "type": "object",
  "properties": {
    "symbol": {
      "type": "string"
    },
    "price": {
      "type": "number"
    }
  },
  "required": ["symbol", "price"],
  "additionalProperties": false
}`;

const REQUEST_EXAMPLE_PLACEHOLDER = `{
  "symbol": "FAST"
}`;

const RESPONSE_EXAMPLE_PLACEHOLDER = `{
  "symbol": "FAST",
  "price": 42.5
}`;

function endpointToFormState(endpoint: {
  operation: string;
  title: string;
  description: string;
  billing: {
    type: RouteBillingType;
    price?: string;
    minAmount?: string;
    maxAmount?: string;
  };
  price: string;
  requestSchemaJson: unknown;
  responseSchemaJson: unknown;
  requestExample: unknown;
  responseExample: unknown;
  usageNotes: string | null;
  upstreamBaseUrl: string | null;
  upstreamPath: string | null;
  upstreamAuthMode: "none" | "bearer" | "header" | null;
  upstreamAuthHeaderName: string | null;
}): EndpointFormState {
  return {
    operation: endpoint.operation,
    title: endpoint.title,
    description: endpoint.description,
    billingType: endpoint.billing.type,
    price: endpoint.billing.type === "fixed_x402" ? (endpoint.billing.price ?? endpoint.price) : "",
    minAmount: endpoint.billing.type === "topup_x402_variable" ? (endpoint.billing.minAmount ?? "") : "",
    maxAmount: endpoint.billing.type === "topup_x402_variable" ? (endpoint.billing.maxAmount ?? "") : "",
    requestSchemaJson: JSON.stringify(endpoint.requestSchemaJson, null, 2),
    responseSchemaJson: JSON.stringify(endpoint.responseSchemaJson, null, 2),
    requestExample: JSON.stringify(endpoint.requestExample, null, 2),
    responseExample: JSON.stringify(endpoint.responseExample, null, 2),
    usageNotes: endpoint.usageNotes ?? "",
    upstreamBaseUrl: endpoint.upstreamBaseUrl ?? "",
    upstreamPath: endpoint.upstreamPath ?? "/",
    upstreamAuthMode: endpoint.upstreamAuthMode ?? "none",
    upstreamAuthHeaderName: endpoint.upstreamAuthHeaderName ?? "",
    upstreamSecret: ""
  };
}

function openApiCandidateToFormState(candidate: OpenApiImportPreview["endpoints"][number]): EndpointFormState {
  return {
    operation: candidate.operation,
    title: candidate.title,
    description: candidate.description,
    billingType: "fixed_x402",
    price: "",
    minAmount: "",
    maxAmount: "",
    requestSchemaJson: JSON.stringify(candidate.requestSchemaJson, null, 2),
    responseSchemaJson: JSON.stringify(candidate.responseSchemaJson, null, 2),
    requestExample: JSON.stringify(candidate.requestExample, null, 2),
    responseExample: JSON.stringify(candidate.responseExample, null, 2),
    usageNotes: candidate.usageNotes ?? "",
    upstreamBaseUrl: candidate.upstreamBaseUrl,
    upstreamPath: candidate.upstreamPath,
    upstreamAuthMode: candidate.upstreamAuthMode,
    upstreamAuthHeaderName: candidate.upstreamAuthHeaderName ?? "",
    upstreamSecret: ""
  };
}

function buildEndpointInput(state: EndpointFormState): CreateProviderEndpointDraftInput {
  const input: CreateProviderEndpointDraftInput = {
    operation: state.operation,
    title: state.title,
    description: state.description,
    billingType: state.billingType,
    mode: "sync",
    requestSchemaJson: JSON.parse(state.requestSchemaJson),
    responseSchemaJson: JSON.parse(state.responseSchemaJson),
    requestExample: JSON.parse(state.requestExample),
    responseExample: JSON.parse(state.responseExample),
    usageNotes: state.usageNotes || null
  };

  if (usesFixedPrice(state.billingType)) {
    input.price = state.price;
  }

  if (usesTopupRange(state.billingType)) {
    input.minAmount = state.minAmount || null;
    input.maxAmount = state.maxAmount || null;
    return input;
  }

  input.upstreamBaseUrl = state.upstreamBaseUrl;
  input.upstreamPath = state.upstreamPath;
  input.upstreamAuthMode = state.upstreamAuthMode;
  input.upstreamAuthHeaderName = state.upstreamAuthMode === "header" ? (state.upstreamAuthHeaderName || null) : null;
  input.upstreamSecret = usesUpstreamSecret(state.upstreamAuthMode) ? (state.upstreamSecret || null) : null;
  return input;
}

function buildEndpointUpdateInput(state: EndpointFormState, hasSecret: boolean): UpdateProviderEndpointDraftInput {
  const clearUpstreamSecret =
    hasSecret && (
      state.billingType === "topup_x402_variable"
      || !usesUpstreamSecret(state.upstreamAuthMode)
    )
      ? true
      : undefined;

  const input: UpdateProviderEndpointDraftInput = {
    operation: state.operation,
    title: state.title,
    description: state.description,
    billingType: state.billingType,
    requestSchemaJson: JSON.parse(state.requestSchemaJson),
    responseSchemaJson: JSON.parse(state.responseSchemaJson),
    requestExample: JSON.parse(state.requestExample),
    responseExample: JSON.parse(state.responseExample),
    usageNotes: state.usageNotes || null,
    clearUpstreamSecret
  };

  if (usesFixedPrice(state.billingType)) {
    input.price = state.price;
  }

  if (usesTopupRange(state.billingType)) {
    input.minAmount = state.minAmount || null;
    input.maxAmount = state.maxAmount || null;
    input.upstreamBaseUrl = null;
    input.upstreamPath = null;
    input.upstreamAuthMode = null;
    input.upstreamAuthHeaderName = null;
    return input;
  }

  input.upstreamBaseUrl = state.upstreamBaseUrl;
  input.upstreamPath = state.upstreamPath;
  input.upstreamAuthMode = state.upstreamAuthMode;
  input.upstreamAuthHeaderName = state.upstreamAuthMode === "header" ? (state.upstreamAuthHeaderName || null) : null;
  input.upstreamSecret = usesUpstreamSecret(state.upstreamAuthMode) ? (state.upstreamSecret || undefined) : undefined;
  return input;
}
