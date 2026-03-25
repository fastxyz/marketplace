import type { Metadata } from "next";

import { FaviconSync } from "@/components/favicon-sync";
import { ThemeProvider } from "@/components/theme-provider";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import { getClientApiBaseUrl } from "@/lib/api-base-url";
import { resolveWebDeploymentNetwork } from "@/lib/network";

import "./globals.css";

function resolveWebBaseUrl() {
  const candidate = process.env.MARKETPLACE_WEB_BASE_URL ?? `http://localhost:${process.env.PORT ?? "3000"}`;

  try {
    return new URL(candidate);
  } catch {
    return new URL("http://localhost:3000");
  }
}

const webBaseUrl = resolveWebBaseUrl();

export const metadata: Metadata = {
  metadataBase: webBaseUrl,
  title: {
    default: "Fast Marketplace",
    template: "%s | Fast Marketplace"
  },
  description: "Fast-native agent marketplace for paid APIs, skills, and source suggestions.",
  keywords: [
    "Fast Marketplace",
    "Fast",
    "agent APIs",
    "data APIs",
    "x402",
    "USDC",
    "marketplace"
  ],
  applicationName: "Fast Marketplace",
  authors: [{ name: "Fast Marketplace" }],
  creator: "Fast Marketplace",
  publisher: "Fast Marketplace",
  robots: {
    index: true,
    follow: true
  },
  icons: {
    icon: "/brand/favicon_dark.ico",
    shortcut: "/brand/favicon_dark.ico"
  },
  openGraph: {
    type: "website",
    siteName: "Fast Marketplace",
    title: "Fast Marketplace",
    description: "Fast-native agent marketplace for paid APIs, skills, and source suggestions.",
    images: [
      {
        url: "/brand/screenshot.png",
        alt: "Fast Marketplace homepage preview"
      }
    ]
  },
  twitter: {
    card: "summary_large_image",
    title: "Fast Marketplace",
    description: "Fast-native agent marketplace for paid APIs, skills, and source suggestions.",
    images: ["/brand/screenshot.png"]
  }
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const apiBaseUrl = getClientApiBaseUrl();
  const network = resolveWebDeploymentNetwork(process.env.MARKETPLACE_FAST_NETWORK);

  return (
    <html lang="en" suppressHydrationWarning>
      <body className="bg-background text-foreground antialiased">
        <ThemeProvider
          attribute="class"
          defaultTheme="light"
          disableTransitionOnChange
          enableSystem={false}
          themes={["light", "dark"]}
        >
          <FaviconSync />
          <div className="flex min-h-screen flex-col">
            <SiteHeader
              apiBaseUrl={apiBaseUrl}
              deploymentNetwork={network.deploymentNetwork}
              networkLabel={network.networkLabel}
            />
            <div className="flex-1">{children}</div>
            <SiteFooter />
          </div>
        </ThemeProvider>
      </body>
    </html>
  );
}
