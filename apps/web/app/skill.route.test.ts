import { describe, expect, it } from "vitest";

import { GET } from "./skill.md/route";

describe("skill markdown route", () => {
  it("serves the canonical SKILL.md file", async () => {
    const response = await GET(new Request("https://marketplace.example.com/skill.md"));
    const markdown = await response.text();

    expect(response.headers.get("content-type")).toContain("text/markdown");
    expect(markdown).toContain("name: fast-marketplace");
    expect(markdown).toContain("## Provider workflow");
    expect(markdown).toContain("## Admin and review workflow");
  });

  it("rewrites marketplace reference links to the configured public domains", async () => {
    const originalWebBaseUrl = process.env.MARKETPLACE_WEB_BASE_URL;
    const originalApiBaseUrl = process.env.MARKETPLACE_API_BASE_URL;

    process.env.MARKETPLACE_WEB_BASE_URL = "https://fast.8o.vc";
    process.env.MARKETPLACE_API_BASE_URL = "https://api.fast.8o.vc";

    try {
      const response = await GET(new Request("https://ignored.example.com/skill.md"));
      const markdown = await response.text();

      expect(markdown).toContain("https://fast.8o.vc/suggest?type=endpoint");
      expect(markdown).toContain("https://api.fast.8o.vc/openapi.json");
      expect(markdown).toContain("https://api.fast.8o.vc/llms.txt");
      expect(markdown).not.toContain("marketplace.example.com");
      expect(markdown).not.toContain("api.marketplace.example.com");
      expect(markdown).not.toContain("marketplace.fast.xyz");
      expect(markdown).not.toContain("fastapi.8o.vc");
    } finally {
      if (originalWebBaseUrl === undefined) {
        delete process.env.MARKETPLACE_WEB_BASE_URL;
      } else {
        process.env.MARKETPLACE_WEB_BASE_URL = originalWebBaseUrl;
      }

      if (originalApiBaseUrl === undefined) {
        delete process.env.MARKETPLACE_API_BASE_URL;
      } else {
        process.env.MARKETPLACE_API_BASE_URL = originalApiBaseUrl;
      }
    }
  });
});
