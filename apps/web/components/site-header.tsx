import React from "react";
import Link from "next/link";
import type { MarketplaceDeploymentNetwork } from "@marketplace/shared";

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

        <nav className="flex flex-1 flex-wrap items-center justify-center gap-6 max-lg:order-3 max-lg:w-full max-lg:justify-start">
          <Link href="/" className="fast-nav-link">
            Marketplace
          </Link>
          <Link href="/stats" className="fast-nav-link">
            Stats
          </Link>
          <Link href="/suggest" className="fast-nav-link">
            Suggest
          </Link>
          <Link href="/providers" className="fast-nav-link">
            Providers
          </Link>
          <Link href="/skill.md" className="fast-nav-link">
            SKILL.md
          </Link>
        </nav>

        <div className="flex shrink-0 items-start justify-end gap-2">
          <ModeToggle />
          <WalletLoginButton
            apiBaseUrl={apiBaseUrl}
            deploymentNetwork={deploymentNetwork}
            networkLabel={networkLabel}
          />
        </div>
      </div>
    </header>
  );
}
