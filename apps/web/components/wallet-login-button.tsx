"use client";

import React from "react";
import { AlertCircle, LoaderCircle, LogOut, Wallet } from "lucide-react";
import type { MarketplaceDeploymentNetwork } from "@marketplace/shared";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  WALLET_SESSION_CHANGE_EVENT,
  clearStoredWalletSession,
  normalizeWalletConnectorNetwork,
  readStoredWalletSession,
  shortenWalletAddress,
  writeStoredWalletSession
} from "@/lib/wallet-session";

interface WalletChallengeResponse {
  wallet: string;
  resourceType: "site";
  resourceId: string;
  nonce: string;
  expiresAt: string;
  message: string;
}

interface WalletSessionResponse {
  accessToken: string;
  wallet: string;
  resourceType: "site";
  resourceId: string;
  tokenType: "Bearer";
}

interface SessionState {
  wallet: string;
  accessToken: string;
  resourceId: string;
}

export function WalletLoginButton({
  apiBaseUrl,
  deploymentNetwork,
  networkLabel
}: {
  apiBaseUrl: string;
  deploymentNetwork: MarketplaceDeploymentNetwork;
  networkLabel: string;
}) {
  const [session, setSession] = React.useState<SessionState | null>(null);
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    function syncSession() {
      setSession(readStoredWalletSession(deploymentNetwork));
    }

    syncSession();
    window.addEventListener(WALLET_SESSION_CHANGE_EVENT, syncSession);
    window.addEventListener("storage", syncSession);

    return () => {
      window.removeEventListener(WALLET_SESSION_CHANGE_EVENT, syncSession);
      window.removeEventListener("storage", syncSession);
    };
  }, [deploymentNetwork]);

  async function connectWallet() {
    setPending(true);
    setError(null);

    try {
      const { FastConnector, waitForInjectedFastConnector } = await import("@fastxyz/fast-connector");
      const injected = await waitForInjectedFastConnector(1500);

      if (!injected) {
        throw new Error("Fast wallet extension not found in this browser.");
      }

      const connector = FastConnector.fromInjected(injected, {
        providerOptions: {
          network: deploymentNetwork
        }
      });

      const connected = await connector.connect();
      if (!connected) {
        throw new Error("Wallet connection was rejected.");
      }

      const activeNetwork = normalizeWalletConnectorNetwork(
        (await connector.getActiveNetwork().catch(() => null)) ?? deploymentNetwork
      );

      if (activeNetwork && activeNetwork !== deploymentNetwork) {
        await connector.disconnect();
        throw new Error(`Wallet is on ${activeNetwork}. Switch it to ${deploymentNetwork} for this site.`);
      }

      const account = await connector.exportKeys();
      const challengeResponse = await fetch(`${apiBaseUrl.replace(/\/$/, "")}/auth/wallet/challenge`, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          wallet: account.address
        })
      });

      if (!challengeResponse.ok) {
        throw new Error(await challengeResponse.text());
      }

      const challenge = (await challengeResponse.json()) as WalletChallengeResponse;
      const signed = await connector.sign({ message: challenge.message });
      const sessionResponse = await fetch(`${apiBaseUrl.replace(/\/$/, "")}/auth/wallet/session`, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          wallet: account.address,
          nonce: challenge.nonce,
          expiresAt: challenge.expiresAt,
          signature: signed.signature
        })
      });

      if (!sessionResponse.ok) {
        throw new Error(await sessionResponse.text());
      }

      const walletSession = (await sessionResponse.json()) as WalletSessionResponse;
      const nextSession = {
        accessToken: walletSession.accessToken,
        wallet: walletSession.wallet,
        deploymentNetwork,
        resourceId: walletSession.resourceId
      } as const;

      writeStoredWalletSession(nextSession);
      setSession(nextSession);
    } catch (nextError) {
      clearStoredWalletSession();
      setSession(null);
      setError(nextError instanceof Error ? nextError.message : "Wallet login failed.");
    } finally {
      setPending(false);
    }
  }

  async function disconnectWallet() {
    setPending(true);
    setError(null);

    try {
      const { FastConnector, getInjectedFastConnector } = await import("@fastxyz/fast-connector");
      const injected = getInjectedFastConnector();
      if (injected) {
        await FastConnector.fromInjected(injected, {
          providerOptions: {
            network: deploymentNetwork
          }
        }).disconnect();
      }
    } catch {
      // Best effort only. Local site session still needs to clear.
    } finally {
      clearStoredWalletSession();
      setSession(null);
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col gap-2 xl:items-end">
      <div className="flex flex-wrap items-center gap-2 xl:justify-end">
        {networkLabel !== "Mainnet" ? (
          <Badge variant="outline" className="rounded-full">
            {networkLabel}
          </Badge>
        ) : null}
        {session ? (
          <>
            <div className="inline-flex items-center gap-2 rounded-full border border-border bg-background/60 px-4 py-2.5 text-sm font-medium">
              <Wallet className="h-4 w-4" />
              {shortenWalletAddress(session.wallet)}
            </div>
            <Button type="button" variant="outline" size="sm" onClick={() => void disconnectWallet()} disabled={pending}>
              {pending ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <LogOut className="h-4 w-4" />}
              Disconnect
            </Button>
          </>
        ) : (
          <Button
            type="button"
            size="sm"
            onClick={() => void connectWallet()}
            disabled={pending}
            aria-label="Connect to Fast"
            className="rounded-full"
          >
            {pending ? (
              <LoaderCircle className="h-4 w-4 animate-spin" />
            ) : (
              <>
                <span>Connect to</span>
                <img
                  src="/brand/fast-logo-light.svg"
                  alt=""
                  aria-hidden="true"
                  width={146}
                  height={52}
                  className="block h-4 w-auto dark:hidden"
                />
                <img
                  src="/brand/fast-logo-dark.svg"
                  alt=""
                  aria-hidden="true"
                  width={146}
                  height={52}
                  className="hidden h-4 w-auto dark:block"
                />
              </>
            )}
          </Button>
        )}
      </div>
      {error ? (
        <div className="flex max-w-xs items-center gap-2 text-xs text-muted-foreground xl:text-right">
          <AlertCircle className="h-3.5 w-3.5 shrink-0" />
          <span>{error}</span>
        </div>
      ) : null}
    </div>
  );
}
