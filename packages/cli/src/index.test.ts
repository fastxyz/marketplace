import { readFile } from "node:fs/promises";

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

  it("ships a package bin that points at built runtime output", async () => {
    const packageJson = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8")
    ) as {
      version?: string;
      bin?: Record<string, string>;
      exports?: Record<string, string>;
      scripts?: Record<string, string>;
    };

    expect(packageJson.version).toBeTruthy();
    expect(packageJson.bin?.["fast-marketplace"]).toBe("./dist/index.js");
    expect(packageJson.exports?.["."]).toBe("./dist/index.js");
    expect(packageJson.scripts?.prepack).toBe("npm run build");
  });
});
