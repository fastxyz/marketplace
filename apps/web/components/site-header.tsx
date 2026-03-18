import React from "react";
import Link from "next/link";
import type { MarketplaceDeploymentNetwork } from "@marketplace/shared";

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
    <header className="sticky top-0 z-30 border-b border-border/80 bg-background/78 backdrop-blur-xl">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-4 px-6 py-4 md:px-10 lg:flex-row lg:items-center lg:justify-between">
        <Link href="/" className="flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-full border border-white/10 bg-white text-sm font-semibold text-black shadow-[0_8px_30px_-12px_rgba(255,255,255,0.75)]">
            F
          </span>
          <div>
            <div className="text-sm font-semibold text-foreground">Fast Marketplace</div>
            <div className="text-[11px] uppercase tracking-[0.24em] text-muted-foreground">Paid APIs For Agents</div>
          </div>
        </Link>

        <nav className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <Link
            href="/"
            className="rounded-full border border-transparent px-4 py-2 font-medium transition-colors hover:border-border hover:bg-card hover:text-foreground"
          >
            Marketplace
          </Link>
          <Link
            href="/suggest"
            className="rounded-full border border-transparent px-4 py-2 font-medium transition-colors hover:border-border hover:bg-card hover:text-foreground"
          >
            Suggest
          </Link>
          <Link
            href="/skill.md"
            className="rounded-full border border-transparent px-4 py-2 font-medium transition-colors hover:border-border hover:bg-card hover:text-foreground"
          >
            SKILL.md
          </Link>
        </nav>

        <div className="self-stretch lg:self-auto">
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
