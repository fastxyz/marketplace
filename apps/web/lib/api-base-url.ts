const DEFAULT_LOCAL_API_BASE_URL = "http://localhost:3000";

export function getServerApiBaseUrl(): string {
  return process.env.MARKETPLACE_API_BASE_URL ?? DEFAULT_LOCAL_API_BASE_URL;
}

export function getClientApiBaseUrl(
  env: Partial<Pick<NodeJS.ProcessEnv, "NODE_ENV" | "NEXT_PUBLIC_MARKETPLACE_API_BASE_URL" | "MARKETPLACE_API_BASE_URL">> = process.env
): string {
  const configured = env.NEXT_PUBLIC_MARKETPLACE_API_BASE_URL ?? env.MARKETPLACE_API_BASE_URL ?? "";

  if (env.NODE_ENV !== "production") {
    if (!configured) {
      return DEFAULT_LOCAL_API_BASE_URL;
    }
  }

  return configured;
}
