const DEFAULT_PRODUCTION_API_BASE_URL = "https://api.marketplace.fast.xyz";

export function getServerApiBaseUrl(): string {
  return process.env.MARKETPLACE_API_BASE_URL ?? "http://localhost:3000";
}

export function getClientApiBaseUrl(
  env: Partial<Pick<NodeJS.ProcessEnv, "NODE_ENV" | "NEXT_PUBLIC_MARKETPLACE_API_BASE_URL" | "MARKETPLACE_API_BASE_URL">> = process.env
): string {
  const configured = env.NEXT_PUBLIC_MARKETPLACE_API_BASE_URL ?? env.MARKETPLACE_API_BASE_URL ?? "";

  // Local web dev should default to same-origin unless a non-production API was explicitly configured.
  if (env.NODE_ENV !== "production" && configured === DEFAULT_PRODUCTION_API_BASE_URL) {
    return "";
  }

  return configured;
}
