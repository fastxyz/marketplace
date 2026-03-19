import React from "react";
import Link from "next/link";

export function SiteFooter() {
  const columns = [
    {
      title: "Developers",
      links: [
        { href: "/skill.md", label: "SKILL.md" },
        { href: "/providers", label: "Providers" }
      ]
    },
    {
      title: "Resources",
      links: [
        { href: "/", label: "Marketplace" },
        { href: "/stats", label: "Stats" },
        { href: "/suggest?type=endpoint", label: "Suggest an endpoint" }
      ]
    },
    {
      title: "Company",
      links: [{ href: "/suggest?type=source", label: "Suggest a source" }]
    }
  ];

  return (
    <footer className="section-sep bg-background">
      <div className="footer-shell">
        <div className="grid gap-12 lg:grid-cols-[1.1fr_1.4fr]">
          <div className="space-y-4">
            <p className="eyebrow">FAST Marketplace</p>
            <div className="max-w-md space-y-3">
              <h2 className="text-2xl font-medium tracking-m">Payment infrastructure for the agentic economy.</h2>
              <p className="text-sm leading-7 text-muted-foreground">
                Discovery, request intake, provider tooling, and public service docs for Fast-native APIs.
              </p>
            </div>
          </div>

          <div className="grid gap-8 sm:grid-cols-3">
            {columns.map((column) => (
              <div key={column.title} className="space-y-4">
                <div className="footer-label">{column.title}</div>
                <nav className="flex flex-col gap-3">
                  {column.links.map((link) => (
                    <Link key={link.href} href={link.href} className="footer-link">
                      {link.label}
                    </Link>
                  ))}
                </nav>
              </div>
            ))}
          </div>
        </div>

        <div className="mt-12 flex flex-col gap-3 border-t border-border pt-6 text-sm md:flex-row md:items-center md:justify-between">
          <div className="text-steel">Built for Fast-native agent payments.</div>
          <div className="text-steel/60">© 2026 FAST Marketplace</div>
        </div>
      </div>
    </footer>
  );
}
