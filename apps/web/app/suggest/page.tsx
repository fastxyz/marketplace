import Link from "next/link";

import { SuggestionForm } from "@/components/suggestion-form";
import { fetchServices } from "@/lib/api";

export const dynamic = "force-dynamic";

function getSingleParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function SuggestPage({
  searchParams
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const services = await fetchServices();
  const defaultServiceSlug = getSingleParam(params.service);
  const defaultType = getSingleParam(params.type) === "source" ? "source" : "endpoint";

  return (
    <main className="page-main">
      <section className="page-section">
        <div className="app-container page-stack">
          <div className="page-header">
            <Link href="/" className="page-link">
              Back to marketplace
            </Link>
            <p className="page-eyebrow">Private intake</p>
            <h1 className="section-title">Suggest a new endpoint or source</h1>
            <p className="page-copy">
              Use this queue to tell providers what to build next. Suggestions stay private and are reviewed in the
              internal marketplace triage board.
            </p>
          </div>

          <SuggestionForm
            services={services}
            defaultServiceSlug={defaultServiceSlug}
            defaultType={defaultType}
          />
        </div>
      </section>
    </main>
  );
}
