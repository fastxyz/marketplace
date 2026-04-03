import { access, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SKILL_MARKDOWN_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../SKILL.md"
);

const LEGACY_WEB_HOST_PATTERN = /\b(?:https?:\/\/)?(?:marketplace\.example\.com|marketplace\.fast\.xyz)\b/giu;
const LEGACY_API_HOST_PATTERN = /\b(?:https?:\/\/)?(?:api\.marketplace\.example\.com|api\.marketplace\.fast\.xyz|fastapi\.8o\.vc)\b/giu;

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
  await access(SKILL_MARKDOWN_PATH);
  const markdown = await readFile(SKILL_MARKDOWN_PATH, "utf8");

  return replaceMarketplaceReferenceUrls(markdown, input ?? {});
}
