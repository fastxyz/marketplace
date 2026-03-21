// @vitest-environment jsdom

import React from "react";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  redirect: vi.fn(),
  isAdminAuthenticated: vi.fn(),
  fetchAdminProviderServices: vi.fn(),
  adminLogoutAction: vi.fn()
}));

vi.mock("next/navigation", () => ({
  redirect: mocks.redirect
}));

vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: { href: string; children: ReactNode }) => (
    <a href={href} {...props}>
      {children}
    </a>
  )
}));

vi.mock("@/lib/admin-auth", () => ({
  isAdminAuthenticated: mocks.isAdminAuthenticated
}));

vi.mock("@/lib/api", () => ({
  fetchAdminProviderServices: mocks.fetchAdminProviderServices
}));

vi.mock("@/app/actions", () => ({
  adminLogoutAction: mocks.adminLogoutAction
}));

import AdminProviderServicesPage from "./page";

describe("AdminProviderServicesPage", () => {
  beforeEach(() => {
    mocks.redirect.mockReset();
    mocks.isAdminAuthenticated.mockReset();
    mocks.fetchAdminProviderServices.mockReset();
    mocks.adminLogoutAction.mockReset();

    mocks.isAdminAuthenticated.mockResolvedValue(true);
  });

  it("renders external registry services as external APIs instead of community marketplace services", async () => {
    mocks.fetchAdminProviderServices.mockResolvedValue([
      {
        service: {
          id: "service_external",
          providerAccountId: "provider_1",
          serviceType: "external_registry",
          settlementMode: null,
          slug: "signal-labs-direct",
          apiNamespace: null,
          name: "Signal Labs Direct",
          tagline: "Direct provider APIs",
          about: "Discovery-only direct APIs.",
          categories: ["Research"],
          promptIntro: "Use the direct API.",
          setupInstructions: ["Read the docs."],
          websiteUrl: "https://provider.example.com",
          payoutWallet: null,
          featured: false,
          status: "pending_review",
          latestSubmittedVersionId: "version_1",
          latestPublishedVersionId: null,
          latestReviewId: null,
          createdAt: "2026-03-21T00:00:00.000Z",
          updatedAt: "2026-03-21T00:00:00.000Z"
        },
        account: {
          id: "provider_1",
          ownerWallet: "fast1provider",
          displayName: "Signal Labs",
          bio: null,
          websiteUrl: "https://provider.example.com",
          contactEmail: null,
          createdAt: "2026-03-21T00:00:00.000Z",
          updatedAt: "2026-03-21T00:00:00.000Z"
        },
        endpoints: [
          {
            endpointType: "external_registry",
            id: "endpoint_1",
            serviceId: "service_external",
            routeId: null,
            operation: null,
            title: "Status",
            description: "Returns service status.",
            price: null,
            billing: null,
            mode: null,
            requestSchemaJson: null,
            responseSchemaJson: null,
            method: "GET",
            publicUrl: "https://provider.example.com/api/status",
            docsUrl: "https://provider.example.com/docs/status",
            authNotes: "Bearer token required.",
            requestExample: {},
            responseExample: { status: "ok" },
            usageNotes: null,
            executorKind: null,
            upstreamBaseUrl: null,
            upstreamPath: null,
            upstreamAuthMode: null,
            upstreamAuthHeaderName: null,
            upstreamSecretRef: null,
            hasUpstreamSecret: false,
            payout: null,
            createdAt: "2026-03-21T00:00:00.000Z",
            updatedAt: "2026-03-21T00:00:00.000Z"
          }
        ],
        verification: null,
        latestReview: null,
        latestPublishedVersionId: null
      }
    ]);

    render(await AdminProviderServicesPage({ searchParams: Promise.resolve({}) }));

    expect(screen.getByText("External API")).toBeTruthy();
    expect(screen.getByText(/discovery-only external registry/i)).toBeTruthy();
    expect(screen.getByText("Access model: discovery-only external API listing")).toBeTruthy();
    expect(screen.queryByText("Community")).toBeNull();
  });
});
