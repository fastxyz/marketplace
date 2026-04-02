"use client";

import React from "react";
import Link from "next/link";
import type { MarketplaceDeploymentNetwork } from "@marketplace/shared";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  WALLET_SESSION_CHANGE_EVENT,
  readStoredWalletSession,
  type StoredWalletSession
} from "@/lib/wallet-session";

export function BuyerSessionGate({
  deploymentNetwork,
  requiredWallet,
  children
}: {
  deploymentNetwork: MarketplaceDeploymentNetwork;
  requiredWallet?: string | null;
  children: (session: StoredWalletSession) => React.ReactNode;
}) {
  const [session, setSession] = React.useState<StoredWalletSession | null>(null);
  const [ready, setReady] = React.useState(false);

  React.useEffect(() => {
    function syncSession() {
      setSession(readStoredWalletSession(deploymentNetwork));
      setReady(true);
    }

    syncSession();
    window.addEventListener(WALLET_SESSION_CHANGE_EVENT, syncSession);
    window.addEventListener("storage", syncSession);

    return () => {
      window.removeEventListener(WALLET_SESSION_CHANGE_EVENT, syncSession);
      window.removeEventListener("storage", syncSession);
    };
  }, [deploymentNetwork]);

  if (!ready) {
    return null;
  }

  if (!session) {
    return (
      <Card variant="frosted">
        <CardHeader>
          <CardTitle>Spend dashboard</CardTitle>
          <CardDescription>
            {requiredWallet
              ? `Connect Fast wallet ${requiredWallet} in the header to view marketplace spend for this site.`
              : "Connect a Fast wallet in the header to view marketplace spend for this site."}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm text-muted-foreground">
          <p>
            Buyer activity is tied to the connected website wallet session. Connect the extension wallet first, then
            reload this page.
          </p>
          <Link href="/" className="fast-link">
            Back to marketplace
          </Link>
        </CardContent>
      </Card>
    );
  }

  if (requiredWallet && session.wallet !== requiredWallet) {
    return (
      <Card variant="frosted">
        <CardHeader>
          <CardTitle>Wrong wallet connected</CardTitle>
          <CardDescription>
            Spend for {requiredWallet} is only available when that wallet is connected in the header.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm text-muted-foreground">
          <p>Connected wallet: {session.wallet}</p>
          <Link href="/" className="fast-link">
            Back to marketplace
          </Link>
        </CardContent>
      </Card>
    );
  }

  return <>{children(session)}</>;
}
