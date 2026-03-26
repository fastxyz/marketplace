import { readFile } from "node:fs/promises";
import { mkdtemp, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { createProgram, shouldRunCli } from "./index.js";

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

  it("treats a symlinked bin path as the CLI entrypoint", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "marketplace-cli-entry-"));
    const targetPath = new URL("./index.ts", import.meta.url);
    const symlinkPath = join(tempDir, "fast-marketplace");
    await symlink(fileURLToPath(targetPath), symlinkPath);

    expect(shouldRunCli(["node", symlinkPath], targetPath.href)).toBe(true);
  });

  it("lets non-init commands fall back to the saved network config", () => {
    const program = createProgram({
      fetchImpl: fetch,
      confirm: async () => true,
      now: () => new Date(),
      print: () => {},
      error: () => {}
    });

    const walletInit = program.commands.find((command) => command.name() === "wallet")
      ?.commands.find((command) => command.name() === "init");
    const walletBalance = program.commands.find((command) => command.name() === "wallet")
      ?.commands.find((command) => command.name() === "balance");
    const useCommand = program.commands.find((command) => command.name() === "use");
    const jobGet = program.commands.find((command) => command.name() === "job")
      ?.commands.find((command) => command.name() === "get");

    expect(walletInit?.options.find((option) => option.long === "--network")?.defaultValue).toBe("mainnet");
    expect(walletBalance?.options.find((option) => option.long === "--network")?.defaultValue).toBeUndefined();
    expect(useCommand?.options.find((option) => option.long === "--network")?.defaultValue).toBeUndefined();
    expect(jobGet?.options.find((option) => option.long === "--network")?.defaultValue).toBeUndefined();
  });
});
