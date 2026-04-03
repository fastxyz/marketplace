"use client";

import React from "react";
import Link from "next/link";
import type { MarketplaceDeploymentNetwork } from "@/lib/marketplace-shared";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  WALLET_SESSION_CHANGE_EVENT,
  readStoredWalletSession,
  type StoredWalletSession
} from "@/lib/wallet-session";

export function ProviderSessionGate({
  deploymentNetwork,
  title,
  description,
  children
}: {
  deploymentNetwork: MarketplaceDeploymentNetwork;
  title: string;
  description?: string;
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
          <CardTitle>{title}</CardTitle>
          <CardDescription>{description ?? "Connect a Fast wallet in the header to access provider features."}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm text-muted-foreground">
          <p>Provider pages use the existing website wallet session. Connect the extension wallet first, then reload this page.</p>
          <Link href="/" className="fast-link">
            Back to marketplace
          </Link>
        </CardContent>
      </Card>
    );
  }

  return <>{children(session)}</>;
}
