import { describe, expect, it } from "vitest";

import { getClientApiBaseUrl } from "./api-base-url";

describe("getClientApiBaseUrl", () => {
  it("defaults localhost web dev to the local API port when no client API base URL is configured", () => {
    expect(
      getClientApiBaseUrl({
        NODE_ENV: "development",
        MARKETPLACE_API_BASE_URL: undefined,
        NEXT_PUBLIC_MARKETPLACE_API_BASE_URL: undefined
      })
    ).toBe("http://localhost:3000");
  });

  it("keeps an explicitly configured production API base URL in development", () => {
    expect(
      getClientApiBaseUrl({
        NODE_ENV: "development",
        MARKETPLACE_API_BASE_URL: "https://api.marketplace.fast.xyz",
        NEXT_PUBLIC_MARKETPLACE_API_BASE_URL: "https://api.marketplace.fast.xyz"
      })
    ).toBe("https://api.marketplace.fast.xyz");
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
