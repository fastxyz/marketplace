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

function normalizeAuthFailureMessage(message: string): string {
  const trimmed = message.trim();

  if (trimmed.startsWith("<!DOCTYPE html>") || trimmed.startsWith("<html")) {
    return "Wallet auth hit the web app instead of the API. For localhost dev, run the API server and set MARKETPLACE_API_BASE_URL=http://localhost:3000 before starting the web app.";
  }

  return trimmed || "Wallet login failed.";
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
        throw new Error(normalizeAuthFailureMessage(await challengeResponse.text()));
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
        throw new Error(normalizeAuthFailureMessage(await sessionResponse.text()));
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
    <div className="flex flex-col items-end gap-2">
      <div className="flex flex-wrap items-center justify-end gap-2">
        {networkLabel !== "Mainnet" ? (
          <Badge variant="outline" className="rounded-pill">
            {networkLabel}
          </Badge>
        ) : null}
        {session ? (
          <>
            <div className="inline-flex items-center gap-2 rounded-pill border border-border bg-muted px-4 py-3 text-sm font-medium tracking-headline">
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
            className="wallet-connect-button"
            onClick={() => void connectWallet()}
            disabled={pending}
            aria-label="Connect to Fast"
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
                  className="block h-4 w-auto"
                />
              </>
            )}
          </Button>
        )}
      </div>
      {error ? (
        <div className="flex max-w-xs items-center gap-2 text-right text-xs text-muted-foreground">
          <AlertCircle className="h-3.5 w-3.5 shrink-0" />
          <span>{error}</span>
        </div>
      ) : null}
    </div>
  );
}
