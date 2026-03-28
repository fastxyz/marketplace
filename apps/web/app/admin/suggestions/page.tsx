import Link from "next/link";
import { redirect } from "next/navigation";

import { adminLogoutAction, updateSuggestionAction } from "@/app/actions";
import { AdminNav } from "@/components/admin-nav";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
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
              <h1 className="section-title">Suggestion queue</h1>
              <p className="page-copy">
                Private intake for new endpoints and source integrations. Switch to Provider Services to review submitted supply and assign settlement tiers.
              </p>
            </div>
            <form action={adminLogoutAction}>
              <Button type="submit" variant="outline">
                Log out
              </Button>
            </form>
          </div>

          <AdminNav current="suggestions" />

          <section className="mt-4 flex flex-wrap gap-2">
            {["all", "submitted", "reviewing", "accepted", "rejected", "shipped"].map((status) => {
              const href = status === "all" ? "/admin/suggestions" : `/admin/suggestions?status=${status}`;
              const isActive = (status === "all" && !statusFilter) || statusFilter === status;

              return (
                <Link
                  key={status}
                  href={href}
                  className={cn(
                    "inline-flex items-center rounded-full px-3 py-2 text-sm transition-colors",
                    isActive ? "bg-foreground text-background" : "bg-background/55 text-muted-foreground hover:text-foreground"
                  )}
                >
                  {status}
                </Link>
              );
            })}
          </section>

          <section className="mt-8 grid gap-4">
            {suggestions.map((suggestion) => (
              <Card key={suggestion.id}>
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
                        className="native-select"
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
                      <Textarea
                        name="internalNotes"
                        defaultValue={suggestion.internalNotes ?? ""}
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
