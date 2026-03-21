import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  redirect: vi.fn((path: string) => {
    throw new Error(`REDIRECT:${path}`);
  }),
  revalidatePath: vi.fn(),
  isAdminAuthenticated: vi.fn(),
  isValidAdminToken: vi.fn(),
  setAdminSession: vi.fn(),
  clearAdminSession: vi.fn(),
  createSuggestion: vi.fn(),
  patchAdminSuggestion: vi.fn(),
  publishAdminProviderService: vi.fn(),
  requestAdminProviderServiceChanges: vi.fn(),
  suspendAdminProviderService: vi.fn(),
  updateAdminProviderServiceSettlementMode: vi.fn()
}));

vi.mock("next/navigation", () => ({
  redirect: mocks.redirect
}));

vi.mock("next/cache", () => ({
  revalidatePath: mocks.revalidatePath
}));

vi.mock("@/lib/admin-auth", () => ({
  isAdminAuthenticated: mocks.isAdminAuthenticated,
  isValidAdminToken: mocks.isValidAdminToken,
  setAdminSession: mocks.setAdminSession,
  clearAdminSession: mocks.clearAdminSession
}));

vi.mock("@/lib/api", () => ({
  createSuggestion: mocks.createSuggestion,
  patchAdminSuggestion: mocks.patchAdminSuggestion,
  publishAdminProviderService: mocks.publishAdminProviderService,
  requestAdminProviderServiceChanges: mocks.requestAdminProviderServiceChanges,
  suspendAdminProviderService: mocks.suspendAdminProviderService,
  updateAdminProviderServiceSettlementMode: mocks.updateAdminProviderServiceSettlementMode
}));

import {
  publishProviderServiceAction,
  suspendProviderServiceAction
} from "./actions";

describe("admin service actions", () => {
  beforeEach(() => {
    mocks.redirect.mockClear();
    mocks.revalidatePath.mockClear();
    mocks.isAdminAuthenticated.mockReset();
    mocks.isValidAdminToken.mockReset();
    mocks.setAdminSession.mockReset();
    mocks.clearAdminSession.mockReset();
    mocks.createSuggestion.mockReset();
    mocks.patchAdminSuggestion.mockReset();
    mocks.publishAdminProviderService.mockReset();
    mocks.requestAdminProviderServiceChanges.mockReset();
    mocks.suspendAdminProviderService.mockReset();
    mocks.updateAdminProviderServiceSettlementMode.mockReset();

    mocks.isAdminAuthenticated.mockResolvedValue(true);
  });

  it("redirects successful publish actions through the success path once", async () => {
    mocks.publishAdminProviderService.mockResolvedValue({});
    const formData = new FormData();
    formData.set("id", "service_1");
    formData.set("settlementMode", "verified_escrow");
    formData.set("returnTo", "/admin/services/service_1");

    await expect(publishProviderServiceAction(formData)).rejects.toThrow(
      "REDIRECT:/admin/services/service_1?message=Published%20service%20as%20Verified."
    );

    expect(mocks.publishAdminProviderService).toHaveBeenCalledWith("service_1", {
      reviewerIdentity: null,
      settlementMode: "verified_escrow"
    });
    expect(mocks.revalidatePath).toHaveBeenNthCalledWith(1, "/admin/services");
    expect(mocks.revalidatePath).toHaveBeenNthCalledWith(2, "/admin/services/service_1");
    expect(mocks.redirect).toHaveBeenCalledTimes(1);
  });

  it("publishes external registry listings without requiring a settlement tier", async () => {
    mocks.publishAdminProviderService.mockResolvedValue({});
    const formData = new FormData();
    formData.set("id", "service_external");
    formData.set("returnTo", "/admin/services/service_external");

    await expect(publishProviderServiceAction(formData)).rejects.toThrow(
      "REDIRECT:/admin/services/service_external?message=Published%20service."
    );

    expect(mocks.publishAdminProviderService).toHaveBeenCalledWith("service_external", {
      reviewerIdentity: null,
      settlementMode: null
    });
    expect(mocks.revalidatePath).toHaveBeenNthCalledWith(1, "/admin/services");
    expect(mocks.revalidatePath).toHaveBeenNthCalledWith(2, "/admin/services/service_external");
    expect(mocks.redirect).toHaveBeenCalledTimes(1);
  });

  it("keeps admin mutation failures on the error redirect path", async () => {
    mocks.suspendAdminProviderService.mockRejectedValue(new Error("upstream failed"));
    const formData = new FormData();
    formData.set("id", "service_2");
    formData.set("returnTo", "/admin/services/service_2");

    await expect(suspendProviderServiceAction(formData)).rejects.toThrow(
      "REDIRECT:/admin/services/service_2?error=upstream%20failed"
    );

    expect(mocks.revalidatePath).not.toHaveBeenCalled();
    expect(mocks.redirect).toHaveBeenCalledTimes(1);
  });
});
