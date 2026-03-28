import Link from "next/link";
import { redirect } from "next/navigation";

import {
  publishProviderServiceAction,
  requestProviderServiceChangesAction,
  suspendProviderServiceAction,
  updateProviderServiceSettlementModeAction
} from "@/app/actions";
import { adminLogoutAction } from "@/app/actions";
import { AdminNav } from "@/components/admin-nav";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  fetchAdminProviderService,
  fetchSubmittedAdminProviderService
} from "@/lib/api";
import { isAdminAuthenticated } from "@/lib/admin-auth";

export const dynamic = "force-dynamic";

function getSingleParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function formatBillingLabel(type: string): string {
  switch (type) {
    case "fixed_x402":
      return "fixed x402";
    case "free":
      return "free";
    case "topup_x402_variable":
      return "variable top-up";
    case "prepaid_credit":
      return "prepaid credit";
    default:
      return type;
  }
}

export default async function AdminProviderServiceDetailPage({
  params,
  searchParams
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (!(await isAdminAuthenticated())) {
    redirect("/admin/login");
  }

  const { id } = await params;
  const query = await searchParams;
  const [currentDetail, submittedDetail] = await Promise.all([
    fetchAdminProviderService(id),
    fetchSubmittedAdminProviderService(id)
  ]);

  if (!currentDetail) {
    return (
      <main className="page-main">
        <section className="page-section">
          <div className="app-container page-stack">
            <Card>
              <CardHeader>
                <CardTitle>Provider service not found</CardTitle>
                <CardDescription>The requested service is no longer available for admin review.</CardDescription>
              </CardHeader>
              <CardContent>
                <Button asChild variant="outline">
                  <Link href="/admin/services">Back to provider services</Link>
                </Button>
              </CardContent>
            </Card>
          </div>
        </section>
      </main>
    );
  }

  const reviewDetail = submittedDetail ?? currentDetail;
  const message = getSingleParam(query.message);
  const error = getSingleParam(query.error);
  const returnTo = `/admin/services/${id}`;
  const hasSubmittedSnapshot = Boolean(submittedDetail?.latestReview?.submittedVersionId);
  const isMarketplaceService = currentDetail.service.serviceType === "marketplace_proxy";

  return (
    <main className="page-main">
      <section className="page-section">
        <div className="app-container page-stack">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div className="page-header">
              <Link href="/" className="page-link">
                Back to marketplace
              </Link>
              <p className="page-eyebrow">Admin review</p>
              <h1 className="section-title">{currentDetail.service.name}</h1>
              <p className="page-copy">
                Review provider supply, set the settlement tier, and decide whether to publish, request changes, or suspend.
              </p>
            </div>
            <form action={adminLogoutAction}>
              <Button type="submit" variant="outline">
                Log out
              </Button>
            </form>
          </div>

          <AdminNav current="services" />

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <Badge variant="secondary">{currentDetail.service.status}</Badge>
            {isMarketplaceService ? (
              <Badge variant={currentDetail.service.settlementMode === "verified_escrow" ? "default" : "outline"}>
                {currentDetail.service.settlementMode === "verified_escrow" ? "Verified" : "Community"}
              </Badge>
            ) : (
              <Badge variant="outline">External API</Badge>
            )}
            {currentDetail.verification ? (
              <Badge variant="outline">verification: {currentDetail.verification.status}</Badge>
            ) : null}
            {currentDetail.latestReview ? (
              <Badge variant="outline">review: {currentDetail.latestReview.status}</Badge>
            ) : null}
          </div>

          {message ? (
            <div className="status-banner">
              {message}
            </div>
          ) : null}
          {error ? (
            <div className="status-banner status-banner-error">
              {error}
            </div>
          ) : null}

          <div className="grid gap-6 lg:grid-cols-[1.1fr_0.9fr]">
            <Card>
              <CardHeader>
                <CardTitle>Review snapshot</CardTitle>
                <CardDescription>
                  {hasSubmittedSnapshot
                    ? "Showing the submitted snapshot that publish uses."
                    : "No submitted snapshot exists right now, so this view falls back to the current draft."}
                </CardDescription>
              </CardHeader>
              <CardContent className="grid gap-4 text-sm">
                <div className="rounded-2xl border border-border bg-background/40 p-5">
                  <div className="font-medium">Service metadata</div>
                  <div className="mt-2 text-muted-foreground">
                    {reviewDetail.service.serviceType === "marketplace_proxy"
                      ? reviewDetail.service.apiNamespace
                      : "discovery-only external registry"}
                  </div>
                  <div className="mt-2 text-muted-foreground">{reviewDetail.service.tagline}</div>
                  <div className="mt-2 whitespace-pre-wrap text-muted-foreground">{reviewDetail.service.about}</div>
                </div>
                <div className="rounded-2xl border border-border bg-background/40 p-5">
                  <div className="font-medium">Provider</div>
                  <div className="mt-2 text-muted-foreground">{reviewDetail.account.displayName}</div>
                  <div className="mt-2 text-muted-foreground">{reviewDetail.account.ownerWallet}</div>
                  <div className="mt-2 text-muted-foreground">Website: {reviewDetail.service.websiteUrl ?? "not set"}</div>
                  {reviewDetail.service.serviceType === "marketplace_proxy" ? (
                    <div className="mt-2 text-muted-foreground">Payout wallet: {reviewDetail.service.payoutWallet ?? "not set"}</div>
                  ) : null}
                </div>
                <div className="rounded-2xl border border-border bg-background/40 p-5">
                  <div className="font-medium">Verification and review</div>
                  <div className="mt-2 text-muted-foreground">
                    Verification: {reviewDetail.verification?.status ?? "not started"}
                  </div>
                  <div className="mt-2 text-muted-foreground">
                    Latest review: {reviewDetail.latestReview?.status ?? "not submitted"}
                  </div>
                  {reviewDetail.latestReview?.reviewNotes ? (
                    <div className="mt-2 whitespace-pre-wrap text-muted-foreground">{reviewDetail.latestReview.reviewNotes}</div>
                  ) : null}
                </div>
              </CardContent>
            </Card>

            <div className="grid gap-6">
              <Card>
                <CardHeader>
                  <CardTitle>Review actions</CardTitle>
                  <CardDescription>
                    {isMarketplaceService
                      ? "Publish with a settlement tier or send the draft back with notes."
                      : "Publish the discovery-only listing or send the draft back with notes."}
                  </CardDescription>
                </CardHeader>
                <CardContent className="grid gap-6">
                  <form action={publishProviderServiceAction} className="grid gap-4">
                    <input type="hidden" name="id" value={id} />
                    <input type="hidden" name="returnTo" value={returnTo} />
                    {isMarketplaceService ? (
                      <label className="grid gap-2 text-sm font-medium">
                        Settlement tier
                        <select
                          name="settlementMode"
                          defaultValue={currentDetail.service.settlementMode ?? "verified_escrow"}
                          className="native-select"
                        >
                          <option value="verified_escrow">Verified</option>
                        </select>
                      </label>
                    ) : null}
                    <label className="grid gap-2 text-sm font-medium">
                      Reviewer identity
                      <Input
                        name="reviewerIdentity"
                        type="text"
                        defaultValue=""
                        placeholder="operator@fast.xyz"
                      />
                    </label>
                    <Button type="submit" disabled={!hasSubmittedSnapshot}>
                      Publish service
                    </Button>
                    {!hasSubmittedSnapshot ? (
                      <p className="text-sm text-muted-foreground">Ask the provider to submit a review snapshot before publishing.</p>
                    ) : null}
                  </form>

                  <form action={requestProviderServiceChangesAction} className="grid gap-4">
                    <input type="hidden" name="id" value={id} />
                    <input type="hidden" name="returnTo" value={returnTo} />
                    <label className="grid gap-2 text-sm font-medium">
                      Change request notes
                      <Textarea
                        name="reviewNotes"
                        placeholder="Explain what the provider needs to update before publish."
                        required
                      />
                    </label>
                    <label className="grid gap-2 text-sm font-medium">
                      Reviewer identity
                      <Input
                        name="reviewerIdentity"
                        type="text"
                        defaultValue=""
                        placeholder="operator@fast.xyz"
                      />
                    </label>
                    <Button type="submit" variant="outline">
                      Request changes
                    </Button>
                  </form>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>Published controls</CardTitle>
                  <CardDescription>
                    {isMarketplaceService
                      ? "Adjust the current settlement tier or suspend the public listing."
                      : "Suspend the public listing. External APIs do not use settlement tiers."}
                  </CardDescription>
                </CardHeader>
                <CardContent className="grid gap-6">
                  {isMarketplaceService ? (
                    <form action={updateProviderServiceSettlementModeAction} className="grid gap-4">
                      <input type="hidden" name="id" value={id} />
                      <input type="hidden" name="returnTo" value={returnTo} />
                      <label className="grid gap-2 text-sm font-medium">
                        Current live settlement tier
                        <select
                          name="settlementMode"
                          defaultValue={currentDetail.service.settlementMode ?? "verified_escrow"}
                          className="native-select"
                        >
                          <option value="verified_escrow">Verified</option>
                        </select>
                      </label>
                      <label className="grid gap-2 text-sm font-medium">
                        Reviewer identity
                        <Input
                          name="reviewerIdentity"
                          type="text"
                          defaultValue=""
                          placeholder="operator@fast.xyz"
                        />
                      </label>
                      <Button type="submit" variant="outline">
                        Save settlement tier
                      </Button>
                    </form>
                  ) : (
                    <div className="rounded-2xl border border-border bg-background/40 px-4 py-3 text-sm text-muted-foreground">
                      External registry services do not use marketplace settlement tiers or runtime payout handling.
                    </div>
                  )}

                  <form action={suspendProviderServiceAction} className="grid gap-4">
                    <input type="hidden" name="id" value={id} />
                    <input type="hidden" name="returnTo" value={returnTo} />
                    <label className="grid gap-2 text-sm font-medium">
                      Suspension notes
                      <Textarea
                        name="reviewNotes"
                        placeholder="Optional notes explaining why the service is being suspended."
                      />
                    </label>
                    <label className="grid gap-2 text-sm font-medium">
                      Reviewer identity
                      <Input
                        name="reviewerIdentity"
                        type="text"
                        defaultValue=""
                        placeholder="operator@fast.xyz"
                      />
                    </label>
                    <Button type="submit" variant="outline">
                      Suspend service
                    </Button>
                  </form>
                </CardContent>
              </Card>
            </div>
          </div>

          <Card>
            <CardHeader>
              <CardTitle>Endpoints</CardTitle>
              <CardDescription>These are the endpoints on the review snapshot used for publish validation.</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4">
              {reviewDetail.endpoints.length === 0 ? (
                <p className="text-sm text-muted-foreground">No endpoints found on this snapshot.</p>
              ) : null}
              {reviewDetail.endpoints.map((endpoint) => (
                <div key={endpoint.id} className="rounded-2xl border border-border bg-background/40 p-5">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <div className="text-lg font-medium tracking-[-0.03em]">{endpoint.title}</div>
                      <div className="mt-1 text-sm text-muted-foreground">
                        {endpoint.endpointType === "marketplace_proxy" ? endpoint.operation : `${endpoint.method} ${endpoint.publicUrl}`}
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {endpoint.endpointType === "marketplace_proxy" ? (
                        <>
                          <Badge variant="outline">{endpoint.mode}</Badge>
                          <Badge variant="outline">{endpoint.executorKind}</Badge>
                          <Badge variant="outline">{formatBillingLabel(endpoint.billing.type)}</Badge>
                        </>
                      ) : (
                        <Badge variant="outline">External API</Badge>
                      )}
                    </div>
                  </div>
                  <div className="mt-3 text-sm text-muted-foreground">{endpoint.description}</div>
                  {endpoint.endpointType === "marketplace_proxy" ? (
                    <div className="mt-3 grid gap-2 text-sm text-muted-foreground md:grid-cols-2">
                      <div>Price: {endpoint.price}</div>
                      <div>Upstream: {endpoint.upstreamBaseUrl ?? "marketplace-managed"}</div>
                    </div>
                  ) : (
                    <div className="mt-3 grid gap-2 text-sm text-muted-foreground md:grid-cols-2">
                      <div>Docs: {endpoint.docsUrl}</div>
                      <div>Auth: {endpoint.authNotes ?? "Provider-defined"}</div>
                    </div>
                  )}
                </div>
              ))}
            </CardContent>
          </Card>
        </div>
      </section>
    </main>
  );
}
