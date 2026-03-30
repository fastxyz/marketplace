import type { CliDependencies } from "./lib.js";
import { extractOpenApiOperationPayloads, type HttpMethod } from "@marketplace/shared";

export interface ExternalEndpointExampleTarget {
  endpointId: string;
  title: string;
  description: string;
  method: HttpMethod;
  publicUrl: string;
  docsUrl: string;
  requestExample: unknown;
  responseExample: unknown;
}

export interface ExternalServiceInferenceInput {
  websiteUrl: string;
  endpoints: ExternalEndpointExampleTarget[];
  deps: Pick<CliDependencies, "fetchImpl">;
  overwrite?: boolean;
}

export interface ExternalEndpointExampleInference {
  endpointId: string;
  title: string;
  publicUrl: string;
  requestExample: unknown;
  responseExample: unknown;
  requestSource: string | null;
  responseSource: string | null;
  changed: boolean;
  warnings: string[];
}

interface ParsedGuidanceExample {
  requestExample?: unknown;
  responseExample?: unknown;
}

interface ServiceArtifacts {
  openApiDocument: unknown | null;
  guidanceTexts: string[];
}

export async function inferExternalServiceExamples(
  input: ExternalServiceInferenceInput
): Promise<ExternalEndpointExampleInference[]> {
  const artifacts = await loadServiceArtifacts(input.websiteUrl, input.endpoints, input.deps);
  return input.endpoints.map((endpoint) => inferExternalEndpointExample({
    endpoint,
    overwrite: input.overwrite ?? false,
    artifacts
  }));
}

export function isMeaningfulExample(value: unknown): boolean {
  if (value === null || value === undefined) {
    return false;
  }

  if (Array.isArray(value)) {
    return value.length > 0;
  }

  if (typeof value === "object") {
    return Object.keys(value as Record<string, unknown>).length > 0;
  }

  if (typeof value === "string") {
    return value.trim().length > 0;
  }

  return true;
}

async function loadServiceArtifacts(
  websiteUrl: string,
  endpoints: ExternalEndpointExampleTarget[],
  deps: Pick<CliDependencies, "fetchImpl">
): Promise<ServiceArtifacts> {
  const origin = new URL(websiteUrl).origin;
  const candidateTextUrls = new Set<string>([
    new URL("/llms.txt", origin).toString(),
    ...endpoints.map((endpoint) => endpoint.docsUrl)
  ]);
  const [openApiDocument, textEntries] = await Promise.all([
    fetchJsonResource(new URL("/openapi.json", origin).toString(), deps),
    Promise.all([...candidateTextUrls].map(async (url) => ({ url, text: await fetchTextResource(url, deps) })))
  ]);

  const guidanceTexts = textEntries
    .map((entry) => entry.text)
    .filter((value): value is string => Boolean(value));

  if (isRecord(openApiDocument?.info)) {
    for (const key of ["x-guidance", "guidance"]) {
      const value = openApiDocument.info[key];
      if (typeof value === "string" && value.trim().length > 0) {
        guidanceTexts.push(value);
      }
    }
  }

  return {
    openApiDocument,
    guidanceTexts
  };
}

async function fetchJsonResource(url: string, deps: Pick<CliDependencies, "fetchImpl">): Promise<Record<string, unknown> | null> {
  try {
    const response = await deps.fetchImpl(url, {
      headers: { accept: "application/json, text/plain;q=0.9, */*;q=0.1" }
    });
    if (!response.ok) {
      return null;
    }

    const text = await response.text();
    if (!text.trim()) {
      return null;
    }

    const parsed = JSON.parse(text) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function fetchTextResource(url: string, deps: Pick<CliDependencies, "fetchImpl">): Promise<string | null> {
  try {
    const response = await deps.fetchImpl(url, {
      headers: { accept: "text/plain, text/markdown, application/json;q=0.9, */*;q=0.1" }
    });
    if (!response.ok) {
      return null;
    }

    const text = await response.text();
    if (!text.trim()) {
      return null;
    }

    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (
      contentType.includes("text/plain")
      || contentType.includes("text/markdown")
      || contentType.includes("application/json")
      || looksLikeGuidanceText(text)
    ) {
      return text;
    }

    return null;
  } catch {
    return null;
  }
}

function inferExternalEndpointExample(input: {
  endpoint: ExternalEndpointExampleTarget;
  overwrite: boolean;
  artifacts: ServiceArtifacts;
}): ExternalEndpointExampleInference {
  const warnings: string[] = [];
  const rawPath = decodeURIComponent(new URL(input.endpoint.publicUrl).pathname);
  const normalizedPath = normalizePath(rawPath);
  const existingRequestMeaningful = isMeaningfulExample(input.endpoint.requestExample);
  const existingResponseMeaningful = isMeaningfulExample(input.endpoint.responseExample);

  let requestExample = input.endpoint.requestExample;
  let responseExample = input.endpoint.responseExample;
  let requestSource: string | null = null;
  let responseSource: string | null = null;

  const openApiMatch = findOpenApiMatch(input.artifacts.openApiDocument, input.endpoint.method, normalizedPath);
  if (openApiMatch) {
    if ((!existingRequestMeaningful || input.overwrite) && isMeaningfulExample(openApiMatch.requestExample)) {
      requestExample = openApiMatch.requestExample;
      requestSource = "openapi";
    }
    if ((!existingResponseMeaningful || input.overwrite) && isMeaningfulExample(openApiMatch.responseExample)) {
      responseExample = openApiMatch.responseExample;
      responseSource = "openapi";
    }
    warnings.push(...openApiMatch.warnings);
  }

  const explicitGuidance = mergeGuidanceExamples(
    input.artifacts.guidanceTexts.map((text) => extractGuidanceExample(text, input.endpoint.method, normalizedPath))
  );
  if ((!isMeaningfulExample(requestExample) || input.overwrite) && isMeaningfulExample(explicitGuidance.requestExample)) {
    requestExample = explicitGuidance.requestExample;
    requestSource = "guidance";
  }
  if ((!isMeaningfulExample(responseExample) || input.overwrite) && isMeaningfulExample(explicitGuidance.responseExample)) {
    responseExample = explicitGuidance.responseExample;
    responseSource = "guidance";
  }

  if ((!isMeaningfulExample(responseExample) || input.overwrite)) {
    const genericResponse = inferGenericResponseExample({
      path: normalizedPath,
      method: input.endpoint.method,
      guidanceTexts: input.artifacts.guidanceTexts
    });
    if (genericResponse) {
      responseExample = genericResponse;
      responseSource = "guidance-generic";
    }
  }

  if ((!isMeaningfulExample(requestExample) || input.overwrite) && input.endpoint.method === "GET") {
    const genericRequest = inferRequestExampleFromInlineQuery(normalizedPath, input.artifacts.guidanceTexts);
    if (isMeaningfulExample(genericRequest)) {
      requestExample = genericRequest;
      requestSource = "guidance-query";
    }
  }

  if ((!isMeaningfulExample(requestExample) || input.overwrite)) {
    const genericRequest = inferGenericRequestExample({
      path: normalizedPath,
      rawPath,
      title: input.endpoint.title
    });
    if (isMeaningfulExample(genericRequest)) {
      requestExample = genericRequest;
      requestSource = "path-heuristic";
    }
  }

  const changed = !deepEqual(requestExample, input.endpoint.requestExample) || !deepEqual(responseExample, input.endpoint.responseExample);
  if (!isMeaningfulExample(requestExample)) {
    warnings.push("No meaningful request example could be inferred.");
  }
  if (!isMeaningfulExample(responseExample)) {
    warnings.push("No meaningful response example could be inferred.");
  }

  return {
    endpointId: input.endpoint.endpointId,
    title: input.endpoint.title,
    publicUrl: input.endpoint.publicUrl,
    requestExample,
    responseExample,
    requestSource,
    responseSource,
    changed,
    warnings: dedupeStrings(warnings)
  };
}

function findOpenApiMatch(document: unknown, method: HttpMethod, normalizedPath: string) {
  if (!isRecord(document) || !isRecord(document.paths)) {
    return null;
  }

  for (const path of Object.keys(document.paths)) {
    if (normalizePath(path) !== normalizedPath) {
      continue;
    }

    return extractOpenApiOperationPayloads({
      document,
      method,
      path
    });
  }

  return null;
}

function extractGuidanceExample(text: string, method: HttpMethod, normalizedPath: string): ParsedGuidanceExample {
  const section = findEndpointSection(text, method, normalizedPath);
  if (!section) {
    return {};
  }

  return {
    requestExample:
      extractJsonLikeAfterLabels(section, [
        "**Input:**",
        "Input:",
        "- Body:",
        "Body:"
      ])
      ?? extractQueryLikeAfterLabels(section, [
        "**Query:**",
        "Query:",
        "**Query params:**",
        "Query params:"
      ])
      ?? extractQueryExampleFromSection(section, normalizedPath),
    responseExample:
      extractJsonLikeAfterLabels(section, ["**Output:**", "Output:", "**Response:**", "Response:", "- Returns:", "Returns:", "Response (202):"])
      ?? extractResponseExampleFromReturnsLine(section)
  };
}

function findEndpointSection(text: string, method: HttpMethod, normalizedPath: string): string | null {
  const headingRegex = /^(#{2,3})\s+(GET|POST|PUT|PATCH|DELETE)\s+([^\s`]+).*$/gm;
  const matches = [...text.matchAll(headingRegex)];
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const headingMethod = match[2] as HttpMethod;
    const headingPath = normalizePath(match[3] ?? "");
    if (headingMethod !== method || headingPath !== normalizedPath) {
      continue;
    }

    const start = match.index ?? 0;
    const end = index + 1 < matches.length ? (matches[index + 1]?.index ?? text.length) : text.length;
    return text.slice(start, end);
  }

  return null;
}

function extractJsonLikeAfterLabels(section: string, labels: string[]): unknown | null {
  for (const label of labels) {
    const escaped = escapeRegExp(label);

    const fenced = new RegExp(`${escaped}\\s*\\n\\s*\\\`\\\`\\\`(?:json)?\\s*([\\s\\S]*?)\\n\\s*\\\`\\\`\\\``, "i").exec(section);
    if (fenced?.[1]) {
      const parsed = parseJsonLikeSnippet(fenced[1]);
      if (parsed !== null) {
        return parsed;
      }
    }

    const inlineCode = new RegExp(`${escaped}\\s*\\\`([^\\\`]+)\\\``, "i").exec(section);
    if (inlineCode?.[1]) {
      const parsed = parseJsonLikeSnippet(inlineCode[1]);
      if (parsed !== null) {
        return parsed;
      }
    }

    const labelIndex = section.search(new RegExp(escaped, "i"));
    if (labelIndex === -1) {
      continue;
    }

    const afterLabel = section.slice(labelIndex + label.length);
    const query = parseInlineQueryExample(afterLabel);
    if (query) {
      return query;
    }

    const jsonSnippet = firstBalancedJsonSnippet(afterLabel);
    if (jsonSnippet) {
      const parsed = parseJsonLikeSnippet(jsonSnippet);
      if (parsed !== null) {
        return parsed;
      }
    }
  }

  return null;
}

function extractQueryLikeAfterLabels(section: string, labels: string[]): Record<string, string> | null {
  for (const label of labels) {
    const escaped = escapeRegExp(label);
    const labelIndex = section.search(new RegExp(escaped, "i"));
    if (labelIndex === -1) {
      continue;
    }

    const afterLabel = section.slice(labelIndex + label.length);
    const query = parseInlineQueryExample(afterLabel) ?? parseNamedQueryParams(afterLabel);
    if (query) {
      return query;
    }
  }

  return null;
}

function extractQueryExampleFromSection(section: string, normalizedPath: string): Record<string, string> | null {
  const exampleMatch = section.match(new RegExp(`Example:\\s*GET\\s+${escapeRegExp(denormalizePath(normalizedPath))}([^\\s\\n]*)`, "i"));
  if (!exampleMatch?.[1]) {
    return null;
  }

  return parseQueryObject(exampleMatch[1]);
}

function extractResponseExampleFromReturnsLine(section: string): unknown | null {
  const returnsMatch = section.match(/Returns:\s*([^\n]+)/i);
  if (!returnsMatch?.[1]) {
    return null;
  }

  const jsonSnippet = firstBalancedJsonSnippet(returnsMatch[1]);
  return jsonSnippet ? parseJsonLikeSnippet(jsonSnippet) : null;
}

function inferGenericResponseExample(input: {
  path: string;
  method: HttpMethod;
  guidanceTexts: string[];
}): unknown | null {
  const guidance = input.guidanceTexts.join("\n");

  if (input.path === "/api/upload" && (/Vercel Blob/i.test(guidance) || /clientToken/i.test(guidance) || /pathname/i.test(guidance))) {
    return {
      uploadId: "uuid",
      clientToken: "vercel_blob_...",
      pathname: "uploads/uuid/image.png",
      expiresAt: "2026-01-01T00:00:00Z"
    };
  }

  if (input.path === "/api/upload/confirm" && /Confirm upload/i.test(guidance) && /blobUrl/i.test(guidance)) {
    return {
      success: true,
      upload: {
        id: "uuid",
        blobUrl: "https://blob.vercel-storage.com/example.png"
      }
    };
  }

  if (input.path.includes("/jobs")) {
    const explicitJobResponse =
      extractSnippetByPattern(guidance, /"status"\s*:\s*"pending"[\s\S]{0,120}/)
      ?? extractSnippetByPattern(guidance, /"status"\s*:\s*"complete"[\s\S]{0,160}/)
      ?? extractSnippetByPattern(guidance, /"status"\s*:\s*"finished"[\s\S]{0,160}/);
    if (explicitJobResponse) {
      return explicitJobResponse;
    }

    if (/poll again in a few seconds/i.test(guidance)) {
      return {
        status: "pending",
        message: "Poll again in a few seconds."
      };
    }
  }

  if (input.path === "/api/download/{}" && /including its public URL/i.test(guidance)) {
    return {
      uploadId: "k7gm3nqp2",
      publicUrl: "https://stableupload.dev/u/k7gm3nqp2/file.png",
      expiresAt: "2026-01-01T00:00:00Z"
    };
  }

  if (
    input.method === "POST"
    && /all endpoints are post requests/i.test(guidance)
    && (/job token/i.test(guidance) || /signed jwt token/i.test(guidance) || /returns a jwt token/i.test(guidance))
  ) {
    return { token: "eyJ..." };
  }

  if (input.path.includes("/generate/") && /jobId/i.test(guidance) && /status:"pending"|status:\s*"pending"/i.test(guidance)) {
    return {
      jobId: "job_123",
      status: "pending"
    };
  }

  if (/\/(?:subdomain|inbox)\//.test(input.path) && /(signers|update|delete|cancel)$/.test(input.path)) {
    return { success: true };
  }

  if (input.path.includes("linkedin-scrape")) {
    return {
      linkedin_url: "https://www.linkedin.com/in/example",
      full_name: "Jane Example",
      headline: "Product Manager at Example Co",
      location: "San Francisco, CA"
    };
  }

  return null;
}

function inferRequestExampleFromInlineQuery(normalizedPath: string, guidanceTexts: string[]): Record<string, string> | null {
  for (const text of guidanceTexts) {
    const directMatch = text.match(new RegExp(`GET\\s+${escapeRegExp(denormalizePath(normalizedPath))}(\\?[^\\s\\n\\\`)]+)`, "i"));
    const match = directMatch ?? text.match(
      new RegExp(`GET\\s+${escapeRegExp(denormalizePath(normalizedPath))}(?:\\s|[^\\n])*?(\\?[^\\s\\n\\\`)]+)`, "i")
    );
    if (!match?.[1]) {
      continue;
    }

    const query = parseQueryObject(match[1]);
    if (query) {
      return query;
    }
  }

  return null;
}

function inferGenericRequestExample(input: {
  path: string;
  rawPath: string;
  title: string;
}): Record<string, string> | null {
  const pathParams = inferPathParameterExample(input.rawPath);
  if (pathParams) {
    return pathParams;
  }

  if (input.path === "/api/upload/confirm") {
    return {
      uploadId: "uuid",
      blobUrl: "https://blob.vercel-storage.com/example.png"
    };
  }

  if (input.path === "/api/jobs") {
    return {
      limit: "20",
      status: "complete"
    };
  }

  if (input.path.includes("linkedin-scrape") || /linkedin/i.test(input.title)) {
    return {
      linkedin_url: "https://www.linkedin.com/in/example"
    };
  }

  return null;
}

function inferPathParameterExample(rawPath: string): Record<string, string> | null {
  const matches = [
    ...rawPath.matchAll(/\/:([A-Za-z0-9_-]+)/g),
    ...rawPath.matchAll(/\{([A-Za-z0-9_-]+)\}/g)
  ];
  if (matches.length === 0) {
    return null;
  }

  return Object.fromEntries(matches.map((match) => {
    const name = match[1] ?? "id";
    return [name, inferPathParameterPlaceholder(name)];
  }));
}

function inferPathParameterPlaceholder(name: string): string {
  const normalized = name.toLowerCase();
  if (normalized === "uploadid") {
    return "k7gm3nqp2";
  }
  if (normalized === "jobid") {
    return "job_123";
  }
  if (normalized === "address") {
    return "0x1234567890abcdef1234567890abcdef12345678";
  }
  if (normalized.includes("period")) {
    return "1d";
  }
  if (normalized.includes("token")) {
    return "eyJ...";
  }
  if (normalized.includes("id")) {
    return "123";
  }
  return "example";
}

function extractSnippetByPattern(text: string, pattern: RegExp): unknown | null {
  const match = pattern.exec(text);
  if (!match?.index && match?.index !== 0) {
    return null;
  }

  const snippet = firstBalancedJsonSnippet(text.slice(match.index - 20 >= 0 ? match.index - 20 : match.index));
  return snippet ? parseJsonLikeSnippet(snippet) : null;
}

function parseInlineQueryExample(text: string): Record<string, string> | null {
  const queryMatch = text.match(/^\s*`(\?[^`]+)`/);
  if (queryMatch?.[1]) {
    return parseQueryObject(queryMatch[1]);
  }

  const plainMatch = text.match(/^\s*(\?[^ \n]+)/);
  return plainMatch?.[1] ? parseQueryObject(plainMatch[1]) : null;
}

function parseNamedQueryParams(text: string): Record<string, string> | null {
  const firstLine = text.trim().split("\n")[0] ?? "";
  const paramNames = [...firstLine.matchAll(/`([A-Za-z0-9_-]+)`/g)]
    .filter((match) => !/\bprevious\s*$/i.test(firstLine.slice(Math.max(0, (match.index ?? 0) - 12), match.index ?? 0)))
    .map((match) => match[1])
    .filter(Boolean) as string[];
  if (paramNames.length === 0) {
    return null;
  }

  return Object.fromEntries(paramNames.map((name) => [name, inferQueryParameterPlaceholder(name, firstLine)]));
}

function inferQueryParameterPlaceholder(name: string, context: string): string {
  const normalized = name.toLowerCase();
  if (normalized === "limit") {
    const defaultMatch = context.match(/default\s+(\d+)/i);
    return defaultMatch?.[1] ?? "10";
  }
  if (normalized === "cursor") {
    return "abc123";
  }
  if (normalized.includes("status")) {
    return "complete";
  }
  if (normalized.includes("token")) {
    return "eyJ...";
  }
  if (normalized.includes("id")) {
    return "123";
  }
  return "string";
}

function parseQueryObject(query: string): Record<string, string> | null {
  if (!query.startsWith("?")) {
    return null;
  }

  const params = new URLSearchParams(query.slice(1));
  const entries = [...params.entries()];
  if (entries.length === 0) {
    return null;
  }

  return Object.fromEntries(entries);
}

function parseJsonLikeSnippet(snippet: string): unknown | null {
  const trimmed = snippet.trim();
  if (!trimmed) {
    return null;
  }

  const normalized = trimmed
    .replace(/:\s*bool(?=\s*[,}\]])/g, ": true")
    .replace(/:\s*number(?=\s*[,}\]])/g, ": 0")
    .replace(/:\s*string(?=\s*[,}\]])/g, ': "string"')
    .replace(/\{\s*\.\.\.\s*\}/g, "{}")
    .replace(/\[\s*\.\.\.\s*\]/g, "[]");

  try {
    return JSON.parse(normalized) as unknown;
  } catch {
    return null;
  }
}

function firstBalancedJsonSnippet(text: string): string | null {
  const start = text.search(/[{\[]/);
  if (start === -1) {
    return null;
  }

  const stack: string[] = [];
  let inString = false;
  let escaped = false;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (!char) {
      continue;
    }

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }

      if (char === "\\") {
        escaped = true;
        continue;
      }

      if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }

    if (char === "{" || char === "[") {
      stack.push(char);
      continue;
    }

    if (char === "}" || char === "]") {
      const previous = stack.pop();
      if (!previous) {
        return null;
      }

      if ((char === "}" && previous !== "{") || (char === "]" && previous !== "[")) {
        return null;
      }

      if (stack.length === 0) {
        return text.slice(start, index + 1);
      }
    }
  }

  return null;
}

function normalizePath(path: string): string {
  const withoutQuery = path.split("?")[0] ?? path;
  const normalized = withoutQuery
    .replace(/\/:([A-Za-z0-9_-]+)/g, "/{$1}")
    .replace(/\{[^}]+\}/g, "{}")
    .replace(/\/+$/g, "");
  return normalized || "/";
}

function denormalizePath(path: string): string {
  return path.replace(/\{\}/g, "[^/?#]+");
}

function looksLikeGuidanceText(text: string): boolean {
  const sample = text.slice(0, 256);
  return sample.startsWith("#") || sample.includes("## ") || sample.includes("POST /api/") || sample.includes("GET /api/");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mergeGuidanceExamples(values: ParsedGuidanceExample[]): ParsedGuidanceExample {
  const merged: ParsedGuidanceExample = {};
  for (const value of values) {
    if (!merged.requestExample && value.requestExample !== undefined) {
      merged.requestExample = value.requestExample;
    }
    if (!merged.responseExample && value.responseExample !== undefined) {
      merged.responseExample = value.responseExample;
    }
  }
  return merged;
}

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

function deepEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
