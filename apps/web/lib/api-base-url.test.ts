import { describe, expect, it } from "vitest";

import { getClientApiBaseUrl } from "./api-base-url";

describe("getClientApiBaseUrl", () => {
  it("uses same-origin in development when the env still points at the production API", () => {
    expect(
      getClientApiBaseUrl({
        NODE_ENV: "development",
        MARKETPLACE_API_BASE_URL: "https://api.marketplace.fast.xyz",
        NEXT_PUBLIC_MARKETPLACE_API_BASE_URL: "https://api.marketplace.fast.xyz"
      })
    ).toBe("");
  });

  it("keeps an explicitly configured non-production client API base URL", () => {
    expect(
      getClientApiBaseUrl({
        NODE_ENV: "development",
        NEXT_PUBLIC_MARKETPLACE_API_BASE_URL: "http://127.0.0.1:3001",
        MARKETPLACE_API_BASE_URL: undefined
      })
    ).toBe("http://127.0.0.1:3001");
  });
});
