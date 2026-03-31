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
      style={{
        position: "sticky",
        top: 0,
        zIndex: 100,
        background: "rgba(246,248,250,0.85)",
        backdropFilter: "blur(16px)",
        WebkitBackdropFilter: "blur(16px)",
        borderBottom: "1px solid rgba(0,0,0,0.05)"
      }}
    >
      <div className="nav-shell">
        <div className="flex min-h-16 items-center justify-between gap-6">
          <Link href="/" aria-label="Fast Marketplace" className="inline-flex items-center gap-3 shrink-0">
            <FastLogo height={16} fill="#2B2C2F" />
            <span
              aria-hidden="true"
              style={{ width: "1px", height: "14px", background: "rgba(0,0,0,0.08)", display: "inline-block" }}
            />
            <span
              style={{
                fontSize: "12px",
                fontWeight: 500,
                letterSpacing: "3px",
                textTransform: "uppercase",
                color: "#5F6672"
              }}
            >
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
            <ModeToggle />
            <WalletLoginButton
              apiBaseUrl={apiBaseUrl}
              deploymentNetwork={deploymentNetwork}
              networkLabel={networkLabel}
            />
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
