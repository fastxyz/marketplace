import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    "apps/api/index": "apps/api/src/index.ts",
    "apps/apify-service/index": "apps/apify-service/src/index.ts",
    "apps/facilitator/index": "apps/facilitator/src/index.ts",
    "apps/tavily-service/index": "apps/tavily-service/src/index.ts",
    "apps/worker/index": "apps/worker/src/index.ts",
    "packages/cli/index": "packages/cli/src/index.ts",
    "packages/mcp/index": "packages/mcp/src/index.ts"
  },
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
