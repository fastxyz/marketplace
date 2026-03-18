"use client";

import React from "react";
import { AlertCircle, LoaderCircle, LogOut, PlugZap, Wallet } from "lucide-react";
import type { MarketplaceDeploymentNetwork } from "@marketplace/shared";

import { Button } from "@/components/ui/button";
import {
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
    const stored = readStoredWalletSession(deploymentNetwork);
    if (stored) {
      setSession(stored);
    }
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
    <div className="flex flex-col items-end gap-2">
      <div className="flex flex-wrap items-center justify-end gap-2">
        <div className="rounded-full border border-cyan-400/20 bg-cyan-400/8 px-3 py-2 text-[11px] font-medium uppercase tracking-[0.22em] text-cyan-100">
          {networkLabel}
        </div>
        {session ? (
          <>
            <div className="inline-flex items-center gap-2 rounded-full border border-emerald-400/20 bg-emerald-400/8 px-4 py-2 text-sm font-medium text-emerald-100">
              <Wallet className="h-4 w-4" />
              {shortenWalletAddress(session.wallet)}
            </div>
            <Button type="button" variant="secondary" size="sm" onClick={() => void disconnectWallet()} disabled={pending}>
              {pending ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <LogOut className="h-4 w-4" />}
              Disconnect
            </Button>
          </>
        ) : (
          <Button type="button" size="sm" onClick={() => void connectWallet()} disabled={pending}>
            {pending ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <PlugZap className="h-4 w-4" />}
            Connect Wallet
          </Button>
        )}
      </div>
      {session ? (
        <div className="text-xs text-muted-foreground">Site session active for website-auth flows.</div>
      ) : null}
      {error ? (
        <div className="flex items-center gap-2 text-right text-xs text-amber-200">
          <AlertCircle className="h-3.5 w-3.5 shrink-0" />
          <span>{error}</span>
        </div>
      ) : null}
    </div>
  );
}
