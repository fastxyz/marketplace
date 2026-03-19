import Link from "next/link";
import { redirect } from "next/navigation";

import { adminLogoutAction, updateSuggestionAction } from "@/app/actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { fetchAdminSuggestions } from "@/lib/api";
import { isAdminAuthenticated } from "@/lib/admin-auth";

export const dynamic = "force-dynamic";

function getSingleParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function AdminSuggestionsPage({
  searchParams
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (!(await isAdminAuthenticated())) {
    redirect("/admin/login");
  }

  const params = await searchParams;
  const statusFilter = getSingleParam(params.status);
  const suggestions = await fetchAdminSuggestions(
    statusFilter === "submitted" ||
      statusFilter === "reviewing" ||
      statusFilter === "accepted" ||
      statusFilter === "rejected" ||
      statusFilter === "shipped"
      ? statusFilter
      : undefined
  );
  const selectClassName = "fast-select min-h-12";
  const textareaClassName = "fast-textarea";

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
                <h1 className="section-title">Suggestion queue</h1>
                <p className="body-copy">
                  Private intake for new endpoints and source integrations. Update status as providers pick up work.
                </p>
              </div>
            </div>
            <form action={adminLogoutAction}>
              <Button type="submit" variant="outline">
                Log out
              </Button>
            </form>
          </div>

          <section className="mt-8 flex flex-wrap gap-2">
            {["all", "submitted", "reviewing", "accepted", "rejected", "shipped"].map((status) => {
              const href = status === "all" ? "/admin/suggestions" : `/admin/suggestions?status=${status}`;
              const isActive = (status === "all" && !statusFilter) || statusFilter === status;

              return (
                <Link key={status} href={href} className={isActive ? "filter-chip filter-chip-active" : "filter-chip"}>
                  {status}
                </Link>
              );
            })}
          </section>

          <section className="mt-8 grid gap-4">
            {suggestions.map((suggestion) => (
              <Card key={suggestion.id} variant="frosted">
                <CardHeader className="gap-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="space-y-2">
                      <div className="flex flex-wrap gap-2">
                        <Badge variant="outline">{suggestion.type}</Badge>
                        <Badge variant="secondary">{suggestion.status}</Badge>
                        {suggestion.serviceSlug ? <Badge variant="outline">{suggestion.serviceSlug}</Badge> : null}
                      </div>
                      <CardTitle>{suggestion.title}</CardTitle>
                      <CardDescription>{suggestion.description}</CardDescription>
                    </div>
                    <div className="metric-label">{suggestion.createdAt.slice(0, 10)}</div>
                  </div>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="grid gap-2 text-sm text-muted-foreground">
                    {suggestion.sourceUrl ? <div>Source URL: {suggestion.sourceUrl}</div> : null}
                    {suggestion.requesterEmail ? <div>Requester: {suggestion.requesterEmail}</div> : null}
                    {suggestion.claimedByProviderName ? <div>Claimed by: {suggestion.claimedByProviderName}</div> : null}
                  </div>

                  <form action={updateSuggestionAction} className="grid gap-4 lg:grid-cols-[220px_1fr_auto]">
                    <input type="hidden" name="id" value={suggestion.id} />
                    <label className="grid gap-2 text-sm font-medium">
                      Status
                      <select
                        name="status"
                        defaultValue={suggestion.status}
                        className={selectClassName}
                      >
                        <option value="submitted">submitted</option>
                        <option value="reviewing">reviewing</option>
                        <option value="accepted">accepted</option>
                        <option value="rejected">rejected</option>
                        <option value="shipped">shipped</option>
                      </select>
                    </label>

                    <label className="grid gap-2 text-sm font-medium">
                      Internal notes
                      <textarea
                        name="internalNotes"
                        defaultValue={suggestion.internalNotes ?? ""}
                        className={textareaClassName}
                      />
                    </label>

                    <div className="flex items-end">
                      <Button type="submit">Save</Button>
                    </div>
                  </form>
                </CardContent>
              </Card>
            ))}
          </section>
        </div>
      </section>
    </main>
  );
}
