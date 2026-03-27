/* eslint-disable @next/next/no-img-element */
"use client";

import React, { useState } from "react";
import Link from "next/link";
import type { MarketplaceDeploymentNetwork } from "@marketplace/shared";
import { Menu, X } from "lucide-react";

import { ModeToggle } from "@/components/mode-toggle";
import { WalletLoginButton } from "@/components/wallet-login-button";

export function SiteHeader({
  apiBaseUrl,
  deploymentNetwork,
  networkLabel
}: {
  apiBaseUrl: string;
  deploymentNetwork: MarketplaceDeploymentNetwork;
  networkLabel: string;
}) {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const navigationLinks = (
    <>
      <Link href="/" className="fast-nav-link" onClick={() => setMobileMenuOpen(false)}>
        Marketplace
      </Link>
      <Link href="/stats" className="fast-nav-link" onClick={() => setMobileMenuOpen(false)}>
        Stats
      </Link>
      <Link href="/me/spend" className="fast-nav-link" onClick={() => setMobileMenuOpen(false)}>
        Spend
      </Link>
      <Link href="/suggest" className="fast-nav-link" onClick={() => setMobileMenuOpen(false)}>
        Suggest
      </Link>
      <Link href="/providers" className="fast-nav-link" onClick={() => setMobileMenuOpen(false)}>
        Providers
      </Link>
      <Link href="/skill.md" className="fast-nav-link" onClick={() => setMobileMenuOpen(false)}>
        SKILL.md
      </Link>
    </>
  );

  return (
    <header
      className="sticky top-0 z-[100] border-b border-border bg-background/85"
      style={{ backdropFilter: "blur(16px)" }}
    >
      <div className="nav-shell">
        <Link href="/" aria-label="Fast Marketplace" className="flex shrink-0 items-center">
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
          <span className="sr-only">Fast Marketplace</span>
        </Link>

        <nav className="hidden flex-1 items-center justify-center gap-6 lg:flex">{navigationLinks}</nav>

        <div className="flex shrink-0 items-start justify-end gap-2">
          <button
            type="button"
            aria-label={mobileMenuOpen ? "Close navigation menu" : "Open navigation menu"}
            aria-expanded={mobileMenuOpen}
            aria-controls="mobile-site-navigation"
            className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-border bg-background text-foreground transition hover:border-foreground/40 lg:hidden"
            onClick={() => setMobileMenuOpen((open) => !open)}
          >
            {mobileMenuOpen ? <X className="h-4 w-4" /> : <Menu className="h-4 w-4" />}
          </button>
          <ModeToggle />
          <WalletLoginButton
            apiBaseUrl={apiBaseUrl}
            deploymentNetwork={deploymentNetwork}
            networkLabel={networkLabel}
          />
        </div>
      </div>

      {mobileMenuOpen ? (
        <nav
          id="mobile-site-navigation"
          className="border-t border-border px-5 py-4 lg:hidden"
          aria-label="Mobile"
        >
          <div className="mx-auto flex w-full max-w-6xl flex-col items-start gap-4">{navigationLinks}</div>
        </nav>
      ) : null}
    </header>
  );
}
