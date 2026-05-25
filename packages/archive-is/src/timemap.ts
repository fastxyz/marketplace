import type { ArchiveSnapshot } from "./index.js";

export interface ParsedTimeMapEntry {
  uri: string;
  params: Record<string, string>;
}

export function buildTimeMapUrl(input: {
  archiveHost: string;
  url: string;
}): string {
  return `https://${input.archiveHost}/timemap/${encodeTimeMapTarget(input.url)}`;
}

export function parseTimeMap(input: {
  body: string;
  originalUrl: string;
  sourceHost: string;
}): ArchiveSnapshot[] {
  const entries = parseLinkFormat(input.body);
  if (input.body.trim().length > 0 && entries.length === 0) {
    throw new Error("TimeMap response is not link-format.");
  }
  if (entries.length > 0 && entries.every((entry) => !entry.params.rel)) {
    throw new Error("TimeMap response has no link relations.");
  }

  return entries
    .filter((entry) => isMementoRel(entry.params.rel))
    .map((entry) => buildSnapshotFromEntry(entry, input.originalUrl, input.sourceHost))
    .filter((snapshot): snapshot is ArchiveSnapshot => snapshot !== null);
}

export function parseLinkFormat(body: string): ParsedTimeMapEntry[] {
  return splitLinkFormat(body)
    .map((entry) => parseLinkFormatEntry(entry.trim()))
    .filter((entry): entry is ParsedTimeMapEntry => entry !== null);
}

function encodeTimeMapTarget(url: string): string {
  return encodeURI(url)
    .replace(/\?/g, "%3F")
    .replace(/#/g, "%23");
}

function splitLinkFormat(body: string): string[] {
  const entries: string[] = [];
  let current = "";
  let inAngle = false;
  let inQuote = false;

  for (const char of body) {
    if (char === "<" && !inQuote) {
      inAngle = true;
    } else if (char === ">" && !inQuote) {
      inAngle = false;
    } else if (char === "\"" && !inAngle) {
      inQuote = !inQuote;
    }

    if (char === "," && !inAngle && !inQuote) {
      entries.push(current);
      current = "";
      continue;
    }

    current += char;
  }

  if (current.trim()) {
    entries.push(current);
  }

  return entries;
}

function parseLinkFormatEntry(entry: string): ParsedTimeMapEntry | null {
  const uriMatch = entry.match(/^\s*<([^>]+)>/);
  if (!uriMatch) {
    return null;
  }

  const params: Record<string, string> = {};
  const paramText = entry.slice(uriMatch[0].length);
  for (const part of paramText.split(";")) {
    const trimmed = part.trim();
    if (!trimmed) {
      continue;
    }

    const equalsIndex = trimmed.indexOf("=");
    if (equalsIndex === -1) {
      params[trimmed.toLowerCase()] = "";
      continue;
    }

    const key = trimmed.slice(0, equalsIndex).trim().toLowerCase();
    const rawValue = trimmed.slice(equalsIndex + 1).trim();
    params[key] = unquoteParamValue(rawValue);
  }

  return {
    uri: uriMatch[1],
    params
  };
}

function unquoteParamValue(value: string): string {
  if (value.startsWith("\"") && value.endsWith("\"")) {
    return value.slice(1, -1).replace(/\\"/g, "\"");
  }

  return value;
}

function isMementoRel(rel: string | undefined): boolean {
  return rel?.split(/\s+/).includes("memento") ?? false;
}

function buildSnapshotFromEntry(
  entry: ParsedTimeMapEntry,
  originalUrl: string,
  sourceHost: string
): ArchiveSnapshot | null {
  const capturedAt = parseMementoDate(entry.params.datetime);
  if (!capturedAt) {
    return null;
  }

  return {
    originalUrl,
    archiveUrl: entry.uri,
    capturedAt,
    archiveId: extractArchiveId(entry.uri),
    sourceHost
  };
}

function parseMementoDate(value: string | undefined): string | null {
  if (!value) {
    return null;
  }

  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    return null;
  }

  return new Date(timestamp).toISOString();
}

function extractArchiveId(archiveUrl: string): string | null {
  try {
    const parsed = new URL(archiveUrl);
    const match = parsed.pathname.match(/^\/(\d{14})(?:\/|$)/);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}
