import { config as loadDotenv } from "dotenv";

import { runProviderServiceTest } from "../../../packages/cli/src/provider.js";

loadDotenv({ quiet: true });

function booleanEnv(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (!value) {
    return fallback;
  }

  return value === "1" || value.toLowerCase() === "true" || value.toLowerCase() === "yes";
}

type MonitorMode = "metadata" | "no-spend" | "monitoring" | "paid-read";

function monitorMode(): MonitorMode {
  const value = process.env.EXTERNAL_REGISTRY_MONITOR_MODE ?? "monitoring";
  if (value === "metadata" || value === "no-spend" || value === "monitoring" || value === "paid-read") {
    return value;
  }

  throw new Error("EXTERNAL_REGISTRY_MONITOR_MODE must be metadata, no-spend, monitoring, or paid-read.");
}

const mode = monitorMode();
const result = await runProviderServiceTest({
  allExternal: true,
  mode,
  apiUrl: process.env.MARKETPLACE_API_BASE_URL,
  adminToken: process.env.MARKETPLACE_ADMIN_TOKEN,
  execute: booleanEnv("EXTERNAL_REGISTRY_MONITOR_EXECUTE", mode === "monitoring" || mode === "no-spend"),
  maxSpend: process.env.EXTERNAL_REGISTRY_MONITOR_MAX_SPEND ?? null
});

console.log(JSON.stringify(result, null, 2));

if (
  booleanEnv("EXTERNAL_REGISTRY_MONITOR_FAIL_ON_ALERT", false)
  && result
  && typeof result === "object"
  && "alert" in result
  && (result.alert as { shouldAlert?: boolean }).shouldAlert
) {
  process.exitCode = 1;
}
