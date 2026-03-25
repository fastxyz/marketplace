import { readSkillMarkdown } from "@/lib/skill";

export async function GET(request: Request) {
  const requestUrl = new URL(request.url);
  const webBaseUrl = process.env.MARKETPLACE_WEB_BASE_URL ?? requestUrl.origin;
  const apiBaseUrl = process.env.MARKETPLACE_API_BASE_URL ?? process.env.NEXT_PUBLIC_MARKETPLACE_API_BASE_URL ?? requestUrl.origin;
  const markdown = await readSkillMarkdown({
    webBaseUrl,
    apiBaseUrl
  });

  return new Response(markdown, {
    headers: {
      "content-type": "text/markdown; charset=utf-8"
    }
  });
}
