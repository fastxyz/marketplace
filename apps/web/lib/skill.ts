import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const CANDIDATE_PATHS = [
  resolve(process.cwd(), "SKILL.md"),
  resolve(process.cwd(), "../SKILL.md"),
  resolve(process.cwd(), "../../SKILL.md")
];

const LEGACY_WEB_HOST_PATTERN = /\b(?:https?:\/\/)?(?:marketplace\.example\.com|marketplace\.fast\.xyz)\b/giu;
const LEGACY_API_HOST_PATTERN = /\b(?:https?:\/\/)?(?:api\.marketplace\.example\.com|fastapi\.8o\.vc)\b/giu;

function normalizeBaseUrl(candidate: string | undefined, fallback: string): string {
  const raw = candidate
    ?.split(",")
    .map((value) => value.trim())
    .find(Boolean) ?? fallback;

  try {
    return new URL(raw).toString().replace(/\/$/, "");
  } catch {
    return fallback.replace(/\/$/, "");
  }
}

function replaceMarketplaceReferenceUrls(
  markdown: string,
  input: {
    apiBaseUrl?: string;
    webBaseUrl?: string;
  }
): string {
  const webBaseUrl = normalizeBaseUrl(input.webBaseUrl, "http://localhost:3000");
  const apiBaseUrl = normalizeBaseUrl(input.apiBaseUrl, webBaseUrl);

  return markdown
    .replace(LEGACY_API_HOST_PATTERN, apiBaseUrl)
    .replace(LEGACY_WEB_HOST_PATTERN, webBaseUrl);
}

export async function readSkillMarkdown(input?: {
  apiBaseUrl?: string;
  webBaseUrl?: string;
}): Promise<string> {
  for (const candidate of CANDIDATE_PATHS) {
    try {
      await access(candidate);
      const markdown = await readFile(candidate, "utf8");
      return replaceMarketplaceReferenceUrls(markdown, input ?? {});
    } catch {
      continue;
    }
  }

  throw new Error("SKILL.md not found.");
}
