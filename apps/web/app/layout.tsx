import type { Metadata } from "next";
import { IBM_Plex_Mono, Space_Grotesk } from "next/font/google";

import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import { resolveWebDeploymentNetwork } from "@/lib/network";

import "./globals.css";

const sans = Space_Grotesk({
  subsets: ["latin"],
  variable: "--font-space-grotesk"
});

const mono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-ibm-plex-mono"
});

export const metadata: Metadata = {
  title: "Fast Marketplace",
  description: "Fast-native agent marketplace for paid APIs, skills, and source suggestions."
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const apiBaseUrl = process.env.MARKETPLACE_API_BASE_URL ?? "http://localhost:3000";
  const network = resolveWebDeploymentNetwork(process.env.MARKETPLACE_FAST_NETWORK);

  return (
    <html lang="en">
      <body className={`${sans.variable} ${mono.variable} bg-background text-foreground`}>
        <div className="relative min-h-screen overflow-hidden bg-[radial-gradient(circle_at_top,rgba(59,130,246,0.18),transparent_28%),radial-gradient(circle_at_15%_20%,rgba(45,212,191,0.12),transparent_26%),radial-gradient(circle_at_85%_30%,rgba(163,230,53,0.08),transparent_20%),linear-gradient(180deg,#05070c,#0a1020_52%,#05070c)]">
          <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(rgba(148,163,184,0.06)_1px,transparent_1px),linear-gradient(90deg,rgba(148,163,184,0.06)_1px,transparent_1px)] bg-[size:34px_34px] opacity-25" />
          <div className="relative flex min-h-screen flex-col">
            <SiteHeader
              apiBaseUrl={apiBaseUrl}
              deploymentNetwork={network.deploymentNetwork}
              networkLabel={network.networkLabel}
            />
            <div className="flex-1">{children}</div>
            <SiteFooter />
          </div>
        </div>
      </body>
    </html>
  );
}
