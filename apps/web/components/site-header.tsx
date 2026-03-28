/* eslint-disable @next/next/no-img-element */
"use client";

import React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { MarketplaceDeploymentNetwork } from "@marketplace/shared";

import { ModeToggle } from "@/components/mode-toggle";
import { WalletLoginButton } from "@/components/wallet-login-button";
import { cn } from "@/lib/utils";

const links = [
  { href: "/", label: "Marketplace" },
  { href: "/stats", label: "Stats" },
  { href: "/me/spend", label: "Spend" },
  { href: "/suggest", label: "Suggest" },
  { href: "/providers", label: "Providers" },
  { href: "/skill.md", label: "SKILL.md" }
];

export function SiteHeader({
  apiBaseUrl,
  deploymentNetwork,
  networkLabel
}: {
  apiBaseUrl: string;
  deploymentNetwork: MarketplaceDeploymentNetwork;
  networkLabel: string;
}) {
  const pathname = usePathname();

  return (
    <header className="sticky top-0 z-50 py-4">
      <div className="app-container">
        <div className="surface-panel rounded-[1.75rem] px-4 py-4 md:px-6">
          <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
            <div className="flex flex-wrap items-center gap-4 md:gap-6">
              <Link href="/" aria-label="Fast Marketplace" className="flex items-center gap-3">
                <img
                  src="/brand/fast-logo-dark.svg"
                  alt=""
                  aria-hidden="true"
                  width={146}
                  height={52}
                  className="block h-5 w-auto dark:hidden"
                />
                <img
                  src="/brand/fast-logo-light.svg"
                  alt=""
                  aria-hidden="true"
                  width={146}
                  height={52}
                  className="hidden h-5 w-auto dark:block"
                />
                <span className="text-base font-medium tracking-[-0.03em]">Marketplace</span>
              </Link>

              <nav className="flex flex-wrap items-center gap-1 text-sm">
                {links.map((link) => {
                  const active = link.href === "/" ? pathname === "/" : pathname?.startsWith(link.href);

                  return (
                    <Link
                      key={link.href}
                      href={link.href}
                      className={cn(
                        "rounded-full px-3 py-2 transition-colors",
                        active ? "bg-foreground text-background" : "text-muted-foreground hover:bg-accent hover:text-foreground"
                      )}
                    >
                      {link.label}
                    </Link>
                  );
                })}
              </nav>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3 xl:justify-end">
              <div className="flex items-center gap-2">
                <ModeToggle />
              </div>
              <WalletLoginButton
                apiBaseUrl={apiBaseUrl}
                deploymentNetwork={deploymentNetwork}
                networkLabel={networkLabel}
              />
            </div>
          </div>
        </div>
      </div>
    </header>
  );
}
