"use client";

import React from "react";
import { LoaderCircle, RefreshCcw, TriangleAlert, Wallet } from "lucide-react";
import type { ServiceCatalogEndpoint } from "@marketplace/shared";
import type { WebDeploymentNetwork } from "@/lib/network";

import { CopyButton } from "@/components/copy-button";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  createJobAccessToken,
  createPaymentIdentifier,
  encodeBrowserPaymentPayload,
  formatResponseBody,
  paymentNetworkForDeployment,
  rawAmountToHex,
  selectPaymentRequirement,
  type BrowserConnectorLike,
  type BrowserPaymentRequired
} from "@/lib/browser-x402";

interface ExecutionResultState {
  statusCode: number;
  body: unknown;
  payment?: {
    amountRaw: string;
    recipient: string;
    txHash: string;
    explorerUrl?: string | null;
  };
}

interface JobResultState {
  jobToken: string;
  payerWallet: string;
  status: string;
  result?: unknown;
  error?: string;
  refund?: unknown;
  updatedAt?: string;
}

export function EndpointBrowserRunner({
  endpoint,
  deploymentNetwork
}: {
  endpoint: ServiceCatalogEndpoint;
  deploymentNetwork: WebDeploymentNetwork;
}) {
  const [requestBody, setRequestBody] = React.useState(() => JSON.stringify(endpoint.requestExample, null, 2));
  const [pending, startTransition] = React.useTransition();
  const [error, setError] = React.useState<string | null>(null);
  const [result, setResult] = React.useState<ExecutionResultState | null>(null);
  const [job, setJob] = React.useState<JobResultState | null>(null);
  const connectorRef = React.useRef<BrowserConnectorLike | null>(null);

  const apiBaseUrl = React.useMemo(() => new URL(endpoint.proxyUrl).origin, [endpoint.proxyUrl]);
  const isFreeRoute = endpoint.billingType === "free";
  const isPaid = !isFreeRoute;

  function runEndpoint() {
    startTransition(async () => {
      setError(null);

      try {
        const parsedBody = JSON.parse(requestBody) as unknown;

        if (isFreeRoute) {
          const response = await fetch(endpoint.proxyUrl, {
            method: endpoint.method,
            headers: {
              "content-type": "application/json"
            },
            body: JSON.stringify(parsedBody)
          });

          const body = await safeJson(response);
          setResult({
            statusCode: response.status,
            body
          });
          setJob(null);
          return;
        }

        const connector = await ensureConnector(deploymentNetwork, connectorRef);
        const payer = await connector.exportKeys();
        const paymentId = createPaymentIdentifier();

        const unpaidResponse = await fetch(endpoint.proxyUrl, {
          method: endpoint.method,
          headers: {
            "content-type": "application/json",
            "PAYMENT-IDENTIFIER": paymentId
          },
          body: JSON.stringify(parsedBody)
        });

        if (unpaidResponse.status !== 402) {
          const body = await safeJson(unpaidResponse);
          setResult({
            statusCode: unpaidResponse.status,
            body
          });
          if (isAsyncJob(body)) {
            setJob({
              jobToken: body.jobToken,
              payerWallet: payer.address,
              status: body.status
            });
          } else {
            setJob(null);
          }
          return;
        }

        const paymentRequired = (await unpaidResponse.json()) as BrowserPaymentRequired;
        const requirement = selectPaymentRequirement(paymentRequired, deploymentNetwork);
        if (!requirement) {
          throw new Error(`No Fast payment requirement found for ${paymentNetworkForDeployment(deploymentNetwork)}.`);
        }

        const payment = await connector.transfer({
          recipient: requirement.payTo,
          amount: rawAmountToHex(requirement.maxAmountRequired),
          ...(requirement.asset ? { token: requirement.asset } : {})
        });

        const paymentPayload = encodeBrowserPaymentPayload({
          paymentRequired,
          requirement,
          certificate: payment.certificate
        });

        const paidResponse = await fetch(endpoint.proxyUrl, {
          method: endpoint.method,
          headers: {
            "content-type": "application/json",
            "PAYMENT-IDENTIFIER": paymentId,
            "PAYMENT-SIGNATURE": paymentPayload
          },
          body: JSON.stringify(parsedBody)
        });

        const body = await safeJson(paidResponse);
        setResult({
          statusCode: paidResponse.status,
          body,
          payment: {
            amountRaw: requirement.maxAmountRequired,
            recipient: requirement.payTo,
            txHash: payment.txHash,
            explorerUrl: payment.explorerUrl
          }
        });

        if (isAsyncJob(body)) {
          setJob({
            jobToken: body.jobToken,
            payerWallet: payer.address,
            status: body.status
          });
        } else {
          setJob(null);
        }
      } catch (nextError) {
        setResult(null);
        setJob(null);
        setError(nextError instanceof Error ? nextError.message : "Browser execution failed.");
      }
    });
  }

  function refreshJob() {
    if (!job) {
      return;
    }

    startTransition(async () => {
      setError(null);

      try {
        const connector = await ensureConnector(deploymentNetwork, connectorRef);
        const payer = await connector.exportKeys();
        if (payer.address !== job.payerWallet) {
          throw new Error(`Job was paid by ${job.payerWallet}. Reconnect that same wallet before polling.`);
        }

        const accessToken = await createJobAccessToken({
          apiBaseUrl,
          wallet: payer.address,
          jobToken: job.jobToken,
          connector
        });

        const jobResponse = await fetch(`${apiBaseUrl}/api/jobs/${job.jobToken}`, {
          headers: {
            Authorization: `Bearer ${accessToken}`
          }
        });

        if (!jobResponse.ok) {
          throw new Error(await jobResponse.text());
        }

        const body = await safeJson(jobResponse);
        if (!isJobStatusBody(body)) {
          throw new Error("Unexpected job response shape.");
        }

        setJob({
          jobToken: body.jobToken,
          payerWallet: payer.address,
          status: body.status,
          result: body.result,
          error: body.error,
          refund: body.refund,
          updatedAt: body.updatedAt
        });
      } catch (nextError) {
        setError(nextError instanceof Error ? nextError.message : "Job refresh failed.");
      }
    });
  }

  return (
    <div className="terminal-shell lg:col-span-2">
      <div className="terminal-topbar">
        <div className="flex items-center gap-4">
          <div className="terminal-lights" aria-hidden="true">
            <span className="terminal-light-red" />
            <span className="terminal-light-amber" />
            <span className="terminal-light-green" />
          </div>
          <div className="terminal-title">
            {isPaid ? "Pay and run this endpoint with the Fast extension" : "Run this endpoint in the browser"}
          </div>
        </div>
        <Badge variant="outline" className="gap-2">
          <Wallet className="h-3.5 w-3.5" />
          {paymentNetworkForDeployment(deploymentNetwork)}
        </Badge>
      </div>

      <div className="terminal-body space-y-5">
        <p className="max-w-3xl text-sm leading-7 text-white/70">
          {isFreeRoute
            ? "This sends the request directly from the browser. No Fast payment headers or wallet extension are required."
            : "This sends the unpaid request first, signs a Fast payment only if the route returns `402`, and then retries with the x402 proof directly from the browser wallet."}
        </p>

        <div className="space-y-3">
          <div className="flex items-center justify-between gap-3">
            <div className="terminal-kicker">Request body</div>
            <CopyButton value={requestBody} className="terminal-copy" />
          </div>
          <Textarea value={requestBody} onChange={(event) => setRequestBody(event.target.value)} className="terminal-textarea" />
        </div>

        <div className="flex flex-wrap gap-3">
          <Button type="button" onClick={runEndpoint} disabled={pending}>
            {pending ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Wallet className="h-4 w-4" />}
            {isPaid ? "Pay and run in browser" : "Run in browser"}
          </Button>
          {job ? (
            <Button type="button" variant="secondary" onClick={refreshJob} disabled={pending}>
              {pending ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <RefreshCcw className="h-4 w-4" />}
              Refresh job
            </Button>
          ) : null}
        </div>

        {error ? (
          <div className="terminal-panel flex items-center gap-2 px-4 py-3 text-sm text-silicon">
            <TriangleAlert className="h-4 w-4 shrink-0" />
            <span>{error}</span>
          </div>
        ) : null}

        {result ? (
          <div className="space-y-4 terminal-panel p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="terminal-kicker">Latest response</div>
                <div className="mt-1 text-sm font-medium text-white">HTTP {result.statusCode}</div>
              </div>
              <CopyButton value={formatResponseBody(result.body)} className="terminal-copy" />
            </div>

            {result.payment ? (
              <div className="grid gap-3 rounded-card border border-white/10 bg-white/5 p-4 sm:grid-cols-3">
                <Detail label="Amount" value={`${formatRawAmount(result.payment.amountRaw)} ${endpoint.tokenSymbol}`} />
                <Detail label="Recipient" value={shorten(result.payment.recipient)} />
                <Detail label="Transaction" value={result.payment.txHash} />
              </div>
            ) : null}

            {result.payment?.explorerUrl ? (
              <a
                href={result.payment.explorerUrl}
                target="_blank"
                rel="noreferrer"
                className="terminal-meta inline-flex w-fit"
              >
                Open transaction in explorer
              </a>
            ) : null}

            <pre className="terminal-command overflow-x-auto whitespace-pre-wrap text-sm">
              {formatResponseBody(result.body)}
            </pre>
          </div>
        ) : null}

        {job ? (
          <div className="space-y-3 terminal-panel p-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="terminal-kicker">Async job</div>
                <div className="mt-1 text-sm font-medium text-white">{job.jobToken}</div>
              </div>
              <div className="rounded-pill border border-white/10 px-3 py-1 text-xs font-medium uppercase tracking-eyebrow text-silicon">
                {job.status}
              </div>
            </div>
            <p className="text-sm text-white/70">
              Async retrieval uses the same paying wallet to sign a job-specific challenge before polling the result.
            </p>
            {job.updatedAt ? <div className="terminal-kicker">Updated: {job.updatedAt}</div> : null}
            {job.result !== undefined ? (
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-3">
                  <div className="terminal-kicker">Job result</div>
                  <CopyButton value={formatResponseBody(job.result)} className="terminal-copy" />
                </div>
                <pre className="terminal-command overflow-x-auto whitespace-pre-wrap text-sm">
                  {formatResponseBody(job.result)}
                </pre>
              </div>
            ) : null}
            {job.error ? (
              <div className="space-y-2">
                <div className="terminal-kicker">Job error</div>
                <pre className="terminal-command overflow-x-auto whitespace-pre-wrap text-sm text-silicon">{job.error}</pre>
              </div>
            ) : null}
            {job.refund !== undefined ? (
              <div className="space-y-2">
                <div className="terminal-kicker">Refund</div>
                <pre className="terminal-command overflow-x-auto whitespace-pre-wrap text-sm">
                  {formatResponseBody(job.refund)}
                </pre>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="terminal-kicker">{label}</div>
      <div className="mt-2 break-all text-sm font-medium text-white">{value}</div>
    </div>
  );
}

async function ensureConnector(
  deploymentNetwork: WebDeploymentNetwork,
  connectorRef: React.MutableRefObject<BrowserConnectorLike | null>
): Promise<BrowserConnectorLike> {
  if (connectorRef.current) {
    return connectorRef.current;
  }

  const { FastConnector, waitForInjectedFastConnector } = await import("@fastxyz/fast-connector");
  const injected = await waitForInjectedFastConnector(1500);
  if (!injected) {
    throw new Error("Fast wallet extension not found in this browser.");
  }

  const connector = FastConnector.fromInjected(injected, {
    providerOptions: {
      network: deploymentNetwork
    }
  }) as unknown as BrowserConnectorLike;

  const connected = await connector.connect();
  if (!connected) {
    throw new Error("Wallet connection was rejected.");
  }

  if (connector.getActiveNetwork) {
    const active = await connector.getActiveNetwork().catch(() => null);
    if (active && !matchesDeploymentNetwork(active, deploymentNetwork)) {
      throw new Error(`Wallet is on ${active}. Switch it to ${deploymentNetwork} for this endpoint.`);
    }
  }

  connectorRef.current = connector;
  return connector;
}

function matchesDeploymentNetwork(active: string, deploymentNetwork: WebDeploymentNetwork): boolean {
  const normalized = active.trim().toLowerCase();

  if (deploymentNetwork === "testnet") {
    return normalized === "testnet" || normalized === "fast-testnet";
  }

  return normalized === "mainnet" || normalized === "fast-mainnet";
}

async function safeJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return await response.text();
  }
}

function isAsyncJob(body: unknown): body is { jobToken: string; status: string } {
  return Boolean(
    body &&
      typeof body === "object" &&
      "jobToken" in body &&
      typeof (body as { jobToken?: unknown }).jobToken === "string" &&
      "status" in body &&
      typeof (body as { status?: unknown }).status === "string"
  );
}

function isJobStatusBody(
  body: unknown
): body is { jobToken: string; status: string; result?: unknown; error?: string; refund?: unknown; updatedAt?: string } {
  return isAsyncJob(body);
}

function formatRawAmount(amountRaw: string): string {
  return (Number(amountRaw) / 1_000_000).toFixed(6).replace(/\.?0+$/, "");
}

function shorten(value: string): string {
  if (value.length <= 18) {
    return value;
  }

  return `${value.slice(0, 10)}...${value.slice(-8)}`;
}
