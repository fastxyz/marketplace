// @vitest-environment jsdom

import React from "react";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  redirect: vi.fn(),
  isAdminAuthenticated: vi.fn(),
  adminLogoutAction: vi.fn(),
  publishProviderServiceAction: vi.fn(),
  requestProviderServiceChangesAction: vi.fn(),
  suspendProviderServiceAction: vi.fn(),
  updateProviderServiceSettlementModeAction: vi.fn(),
  fetchAdminProviderService: vi.fn(),
  fetchSubmittedAdminProviderService: vi.fn(),
  fetchAdminProviderServiceTestSummary: vi.fn(),
  fetchAdminProviderServiceTestRuns: vi.fn()
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
  fetchAdminProviderService: mocks.fetchAdminProviderService,
  fetchSubmittedAdminProviderService: mocks.fetchSubmittedAdminProviderService,
  fetchAdminProviderServiceTestSummary: mocks.fetchAdminProviderServiceTestSummary,
  fetchAdminProviderServiceTestRuns: mocks.fetchAdminProviderServiceTestRuns
}));

vi.mock("@/app/actions", () => ({
  adminLogoutAction: mocks.adminLogoutAction,
  publishProviderServiceAction: mocks.publishProviderServiceAction,
  requestProviderServiceChangesAction: mocks.requestProviderServiceChangesAction,
  suspendProviderServiceAction: mocks.suspendProviderServiceAction,
  updateProviderServiceSettlementModeAction: mocks.updateProviderServiceSettlementModeAction
}));

vi.mock("@/components/admin-nav", () => ({
  AdminNav: () => <nav>Admin nav</nav>
}));

import AdminProviderServiceDetailPage from "./page";

describe("AdminProviderServiceDetailPage", () => {
  beforeEach(() => {
    mocks.redirect.mockReset();
    mocks.isAdminAuthenticated.mockReset();
    mocks.adminLogoutAction.mockReset();
    mocks.publishProviderServiceAction.mockReset();
    mocks.requestProviderServiceChangesAction.mockReset();
    mocks.suspendProviderServiceAction.mockReset();
    mocks.updateProviderServiceSettlementModeAction.mockReset();
    mocks.fetchAdminProviderService.mockReset();
    mocks.fetchSubmittedAdminProviderService.mockReset();
    mocks.fetchAdminProviderServiceTestSummary.mockReset();
    mocks.fetchAdminProviderServiceTestRuns.mockReset();

    mocks.isAdminAuthenticated.mockResolvedValue(true);
  });

  it("renders the not-found state without loading testing ledger routes", async () => {
    mocks.fetchAdminProviderService.mockResolvedValue(null);

    render(await AdminProviderServiceDetailPage({
      params: Promise.resolve({ id: "missing-service" }),
      searchParams: Promise.resolve({})
    }));

    expect(screen.getByText("Provider service not found")).toBeTruthy();
    expect(mocks.fetchSubmittedAdminProviderService).not.toHaveBeenCalled();
    expect(mocks.fetchAdminProviderServiceTestSummary).not.toHaveBeenCalled();
    expect(mocks.fetchAdminProviderServiceTestRuns).not.toHaveBeenCalled();
  });
});
