"use client";

import React, { useState } from "react";
import Link from "next/link";
import type { MarketplaceDeploymentNetwork } from "@marketplace/shared";
import { Menu, X } from "lucide-react";

import { FastLogo } from "@/components/fast-logo";
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
      <Link href="/stats" className="fast-nav-link" onClick={() => setMobileMenuOpen(false)}>
        Stats
      </Link>
      <Link href="/me/spend" className="fast-nav-link" onClick={() => setMobileMenuOpen(false)}>
        Spend
      </Link>
      <Link href="/providers" className="fast-nav-link" onClick={() => setMobileMenuOpen(false)}>
        Providers
      </Link>
    </>
  );

  return (
    <header
      className="border-b border-border/80 bg-background/85 text-foreground backdrop-blur-[16px]"
      style={{
        position: "sticky",
        top: 0,
        zIndex: 100,
        backdropFilter: "blur(16px)",
        WebkitBackdropFilter: "blur(16px)"
      }}
    >
      <div className="nav-shell">
        <div className="flex min-h-16 items-center justify-between gap-6">
          <Link href="/" aria-label="Fast Marketplace" className="inline-flex shrink-0 items-center gap-3 text-foreground">
            <FastLogo height={16} />
            <span
              aria-hidden="true"
              className="inline-block h-[14px] w-px bg-border"
            />
            <span className="text-[12px] font-medium uppercase tracking-[3px] text-muted-foreground">
              Marketplace
            </span>
          </Link>

          <nav className="hidden items-center gap-1 md:flex">{navigationLinks}</nav>

          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              aria-label={mobileMenuOpen ? "Close navigation menu" : "Open navigation menu"}
              aria-expanded={mobileMenuOpen}
              aria-controls="mobile-site-navigation"
              className="btn-fast btn-fast-secondary btn-fast-icon md:hidden"
              onClick={() => setMobileMenuOpen((open) => !open)}
            >
              {mobileMenuOpen ? <X className="h-4 w-4" /> : <Menu className="h-4 w-4" />}
            </button>
            <WalletLoginButton
              apiBaseUrl={apiBaseUrl}
              deploymentNetwork={deploymentNetwork}
              networkLabel={networkLabel}
            />
            <ModeToggle />
          </div>
        </div>
      </div>

      {mobileMenuOpen ? (
        <nav id="mobile-site-navigation" className="nav-shell pb-4 md:hidden" aria-label="Mobile">
          <div className="grid gap-2">{navigationLinks}</div>
        </nav>
      ) : null}
    </header>
  );
}
