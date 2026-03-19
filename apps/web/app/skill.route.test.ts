import { describe, expect, it } from "vitest";

import { GET } from "./skill.md/route";

describe("skill markdown route", () => {
  it("serves the canonical SKILL.md file", async () => {
    const response = await GET();
    const markdown = await response.text();

    expect(response.headers.get("content-type")).toContain("text/markdown");
    expect(markdown).toContain("name: fast-marketplace");
    expect(markdown).toContain("## Provider workflow");
    expect(markdown).toContain("## Admin and review workflow");
  });
});
