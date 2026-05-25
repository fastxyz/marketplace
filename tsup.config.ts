import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    "apps/api/index": "apps/api/src/index.ts",
    "apps/apify-service/index": "apps/apify-service/src/index.ts",
    "apps/archive-is-service/index": "apps/archive-is-service/src/index.ts",
    "apps/external-registry-monitor/index": "apps/external-registry-monitor/src/index.ts",
    "apps/facilitator/index": "apps/facilitator/src/index.ts",
    "apps/tavily-service/index": "apps/tavily-service/src/index.ts",
    "apps/valyu-service/index": "apps/valyu-service/src/index.ts",
    "apps/worker/index": "apps/worker/src/index.ts",
    "packages/archive-is/index": "packages/archive-is/src/index.ts",
    "packages/cli/index": "packages/cli/src/index.ts",
    "packages/mcp/index": "packages/mcp/src/index.ts",
    "packages/shared/index": "packages/shared/src/index.ts",
    "packages/shared/browser-request-input": "packages/shared/src/browser-request-input.ts"
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
