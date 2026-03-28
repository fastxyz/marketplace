import React from "react";
import Link from "next/link";

const socials = [
  { href: "https://x.com/pi2_labs", label: "X" },
  { href: "https://www.linkedin.com/company/fast-xyz", label: "LinkedIn" }
];

const internalLinks = [
  { href: "/providers", label: "Provider workspace" },
  { href: "/suggest", label: "Private intake" },
  { href: "/skill.md", label: "SKILL.md" }
];

export function SiteFooter() {
  const year = new Date().getFullYear();

  return (
    <footer className="pb-6">
      <div className="app-container">
        <div className="surface-panel rounded-[1.75rem] px-5 py-8 md:px-7">
          <div className="grid gap-8 lg:grid-cols-[1.25fr_0.75fr_0.75fr]">
            <div className="space-y-3">
              <div className="page-eyebrow">Fast Marketplace</div>
              <h2 className="max-w-sm text-2xl font-medium tracking-[-0.04em]">
                Discovery, payment, and review infrastructure for Fast-native agent APIs.
              </h2>
              <p className="max-w-xl text-sm leading-7 text-muted-foreground">
                Public marketplace pages, buyer spend visibility, provider tooling, and internal review live in one
                shared shell.
              </p>
            </div>

            <div className="space-y-3">
              <div className="page-eyebrow">Navigate</div>
              <div className="grid gap-2 text-sm text-muted-foreground">
                {internalLinks.map((item) => (
                  <Link key={item.href} href={item.href} className="transition-colors hover:text-foreground">
                    {item.label}
                  </Link>
                ))}
              </div>
            </div>

            <div className="space-y-3">
              <div className="page-eyebrow">Social</div>
              <div className="grid gap-2 text-sm text-muted-foreground">
                {socials.map((item) => (
                  <Link key={item.href} href={item.href} target="_blank" rel="noreferrer" className="transition-colors hover:text-foreground">
                    {item.label}
                  </Link>
                ))}
              </div>
            </div>
          </div>

          <div className="mt-8 border-t border-border pt-4 text-sm text-muted-foreground">
            © {year} Fast Marketplace. Built for Fast-native settlement and API discovery.
          </div>
        </div>
      </div>
    </footer>
  );
}
