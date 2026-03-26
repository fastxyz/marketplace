import { describe, expect, it } from "vitest";

import { createProgram } from "./index.js";

describe("marketplace cli command surface", () => {
  it("registers the discovery-first buyer commands", () => {
    const program = createProgram({
      fetchImpl: fetch,
      confirm: async () => true,
      now: () => new Date(),
      print: () => {},
      error: () => {}
    });

    const names = program.commands.map((command) => command.name());
    expect(names).toEqual(expect.arrayContaining(["search", "show", "use", "wallet", "config", "job", "provider"]));
  });

  it("does not register legacy buyer commands", () => {
    const program = createProgram({
      fetchImpl: fetch,
      confirm: async () => true,
      now: () => new Date(),
      print: () => {},
      error: () => {}
    });

    const names = program.commands.map((command) => command.name());
    expect(names).not.toContain("invoke");
    expect(names).not.toContain("auth");
  });
});
