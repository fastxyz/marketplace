import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  outDir: "dist",
  format: ["esm"],
  platform: "node",
  target: "node20",
  sourcemap: true,
  splitting: false,
  clean: true,
  dts: false,
  noExternal: [/^@marketplace\//]
});
