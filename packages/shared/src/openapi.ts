import type {
  HttpMethod,
  JsonSchema,
  OpenApiImportCandidate,
  OpenApiImportPreview,
  UpstreamAuthMode
} from "./types.js";
import { getQuerySchemaProperties } from "./request-input.js";

const HTTP_METHODS = new Set(["get", "put", "post", "delete", "options", "head", "patch", "trace"]);
const DEFAULT_REQUEST_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false
};
const DEFAULT_RESPONSE_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: true
};

export function parseOpenApiImportDocument(input: {
  document: unknown;
  documentUrl: string;
}): OpenApiImportPreview {
  const root = expectObject(input.document, "OpenAPI document");
  const version = readOptionalString(root, "openapi");
  if (!version?.startsWith("3.")) {
    throw new Error("Only OpenAPI 3.x documents are supported.");
  }

  const info = readOptionalObject(root, "info");
  const paths = expectObject(root.paths, "OpenAPI document.paths");
  const warnings: string[] = [];
  const endpoints: OpenApiImportCandidate[] = [];
  const seenOperations = new Set<string>();
  let skippedUnsupported = 0;

  for (const [path, rawPathItem] of Object.entries(paths)) {
    if (typeof path !== "string" || !path.startsWith("/")) {
      warnings.push(`Skipped invalid OpenAPI path entry: ${String(path)}.`);
      continue;
    }

    const pathItem = expectObject(resolveOpenApiNode(root, rawPathItem), `OpenAPI path ${path}`);
    skippedUnsupported += countUnsupportedImportOperations(pathItem);

    if ("post" in pathItem) {
      endpoints.push(
        buildImportCandidate({
          method: "POST",
          root,
          documentUrl: input.documentUrl,
          path,
          pathItem,
          operationValue: pathItem.post,
          seenOperations
        })
      );
    }

    if ("get" in pathItem) {
      const candidate = buildSafeGetImportCandidate({
        root,
        documentUrl: input.documentUrl,
        path,
        pathItem,
        seenOperations
      });
      if ("reason" in candidate) {
        warnings.push(`Skipped GET ${path}: ${candidate.reason}`);
      } else {
        endpoints.push(candidate);
      }
    }
  }

  if (skippedUnsupported > 0) {
    warnings.push(
      `Skipped ${skippedUnsupported} unsupported operation${skippedUnsupported === 1 ? "" : "s"} because imports only support POST and flat-query GET routes.`
    );
  }

  if (endpoints.length === 0) {
    warnings.push("No importable POST or safe GET operations were found in this document.");
  }

  return {
    documentUrl: input.documentUrl,
    title: readOptionalString(info, "title"),
    version: readOptionalString(info, "version"),
    endpoints,
    warnings
  };
}

export function extractOpenApiOperationPayloads(input: {
  document: unknown;
  method: HttpMethod;
  path: string;
}): {
  requestSchemaJson: JsonSchema;
  responseSchemaJson: JsonSchema;
  requestExample: unknown;
  responseExample: unknown;
  warnings: string[];
} | null {
  const root = expectObject(input.document, "OpenAPI document");
  const version = readOptionalString(root, "openapi");
  if (!version?.startsWith("3.")) {
    throw new Error("Only OpenAPI 3.x documents are supported.");
  }

  const paths = expectObject(root.paths, "OpenAPI document.paths");
  const pathItemValue = paths[input.path];
  if (pathItemValue === undefined) {
    return null;
  }

  const pathItem = expectObject(resolveOpenApiNode(root, pathItemValue), `OpenAPI path ${input.path}`);
  const operationKey = input.method.toLowerCase();
  const operationValue = pathItem[operationKey];
  if (operationValue === undefined) {
    return null;
  }

  const operation = expectObject(
    resolveOpenApiNode(root, operationValue),
    `OpenAPI operation ${input.method} ${input.path}`
  );
  const request = input.method === "GET"
    ? extractGetRequestPayload(root, pathItem, operation)
    : extractRequestPayload(root, operation);
  const response = extractResponsePayload(root, operation);

  return {
    requestSchemaJson: request.schema,
    responseSchemaJson: response.schema,
    requestExample: request.example,
    responseExample: response.example,
    warnings: [...request.warnings, ...response.warnings]
  };
}

function buildImportCandidate(input: {
  method: HttpMethod;
  root: Record<string, unknown>;
  documentUrl: string;
  path: string;
  pathItem: Record<string, unknown>;
  operationValue: unknown;
  seenOperations: Set<string>;
}): OpenApiImportCandidate {
  const operation = expectObject(
    resolveOpenApiNode(input.root, input.operationValue),
    `OpenAPI operation ${input.method} ${input.path}`
  );
  const warnings: string[] = [];
  const upstreamBaseUrl = resolveServerUrl({
    root: input.root,
    documentUrl: input.documentUrl,
    operation,
    pathItem: input.pathItem
  });
  const request = input.method === "GET"
    ? extractGetRequestPayload(input.root, input.pathItem, operation)
    : extractRequestPayload(input.root, operation);
  const response = extractResponsePayload(input.root, operation);
  const auth = inferUpstreamAuthMode(input.root, operation);
  const operationSlug = dedupeOperationSlug(
    slugifyOperation(readOptionalString(operation, "operationId") ?? input.path),
    input.seenOperations
  );

  warnings.push(...request.warnings, ...response.warnings, ...auth.warnings);

  if (input.method === "POST" && input.path.includes("{")) {
    warnings.push("Path parameters are not mapped automatically. Review upstreamPath before saving.");
  }

  if (input.method === "POST" && hasNonHeaderParameters(input.root, input.pathItem, operation)) {
    warnings.push("Query, path, and cookie parameters are not mapped automatically from the marketplace JSON body.");
  }

  if (auth.mode !== "none") {
    warnings.push("Add the upstream secret before creating this draft.");
  }

  return {
    operation: operationSlug,
    method: input.method,
    title: readOptionalString(operation, "summary") ?? titleCaseFromSlug(operationSlug),
    description:
      readOptionalString(operation, "description")
      ?? readOptionalString(operation, "summary")
      ?? `Imported from ${input.method} ${input.path}.`,
    requestSchemaJson: request.schema,
    responseSchemaJson: response.schema,
    requestExample: request.example,
    responseExample: response.example,
    usageNotes: null,
    upstreamBaseUrl,
    upstreamPath: input.path,
    upstreamAuthMode: auth.mode,
    upstreamAuthHeaderName: auth.headerName,
    warnings
  };
}

function buildSafeGetImportCandidate(input: {
  root: Record<string, unknown>;
  documentUrl: string;
  path: string;
  pathItem: Record<string, unknown>;
  seenOperations: Set<string>;
}): OpenApiImportCandidate | { reason: string } {
  if (input.path.includes("{")) {
    return { reason: "path parameters are not supported for imported GET routes." };
  }

  const operation = expectObject(
    resolveOpenApiNode(input.root, input.pathItem.get),
    `OpenAPI operation GET ${input.path}`
  );

  if (operation.requestBody !== undefined) {
    return { reason: "GET request bodies are not supported." };
  }

  const parameterValues = [...collectParameters(input.pathItem), ...collectParameters(operation)];
  for (const parameterValue of parameterValues) {
    const parameter = expectObject(resolveOpenApiNode(input.root, parameterValue), "OpenAPI parameter");
    const location = readOptionalString(parameter, "in");
    if (location === "path" || location === "cookie" || location === "header") {
      return { reason: "only query parameters are supported for imported GET routes." };
    }

    if (location === "query") {
      const style = readOptionalString(parameter, "style");
      if (style && style !== "form") {
        return { reason: "only form-style query parameters are supported for imported GET routes." };
      }

      const schema = parameter.schema
        ? normalizeJsonSchema(input.root, parameter.schema)
        : structuredClone(DEFAULT_REQUEST_SCHEMA);

      if (parameter.explode === false && !supportsNonExplodedScalarQueryParameter(schema)) {
        return { reason: "only exploded query parameters are supported for imported GET routes." };
      }
    }
  }

  try {
    return buildImportCandidate({
      method: "GET",
      root: input.root,
      documentUrl: input.documentUrl,
      path: input.path,
      pathItem: input.pathItem,
      operationValue: input.pathItem.get,
      seenOperations: input.seenOperations
    });
  } catch (error) {
    return {
      reason: error instanceof Error ? error.message : "query parameters could not be mapped safely."
    };
  }
}

function supportsNonExplodedScalarQueryParameter(schema: JsonSchema): boolean {
  return (
    schema.type === "string"
    || schema.type === "number"
    || schema.type === "integer"
    || schema.type === "boolean"
  );
}

function countUnsupportedImportOperations(pathItem: Record<string, unknown>): number {
  let count = 0;
  for (const key of Object.keys(pathItem)) {
    if (HTTP_METHODS.has(key) && key !== "post" && key !== "get") {
      count += 1;
    }
  }

  return count;
}

function extractGetRequestPayload(
  root: Record<string, unknown>,
  pathItem: Record<string, unknown>,
  operation: Record<string, unknown>
): {
  schema: JsonSchema;
  example: unknown;
  warnings: string[];
} {
  const parameterValues = [...collectParameters(pathItem), ...collectParameters(operation)];
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const parameterValue of parameterValues) {
    const parameter = expectObject(resolveOpenApiNode(root, parameterValue), "OpenAPI parameter");
    const location = readOptionalString(parameter, "in");
    if (location !== "query") {
      throw new Error("only query parameters are supported.");
    }

    const name = readOptionalString(parameter, "name");
    if (!name) {
      throw new Error("query parameters must declare a name.");
    }

    const schema = parameter.schema
      ? normalizeJsonSchema(root, parameter.schema)
      : structuredClone(DEFAULT_REQUEST_SCHEMA);
    properties[name] = schema;
    if (parameter.required === true) {
      required.push(name);
    }
  }

  const schema: JsonSchema = {
    type: "object",
    properties,
    additionalProperties: false
  };
  if (required.length > 0) {
    schema.required = required;
  }

  getQuerySchemaProperties(schema);

  return {
    schema,
    example: exampleFromSchema(schema) ?? {},
    warnings: []
  };
}

function extractRequestPayload(root: Record<string, unknown>, operation: Record<string, unknown>): {
  schema: JsonSchema;
  example: unknown;
  warnings: string[];
} {
  const requestBodyValue = operation.requestBody;
  if (requestBodyValue === undefined) {
    return {
      schema: structuredClone(DEFAULT_REQUEST_SCHEMA),
      example: {},
      warnings: []
    };
  }

  const requestBody = expectObject(resolveOpenApiNode(root, requestBodyValue), "OpenAPI requestBody");
  const content = readOptionalObject(requestBody, "content");
  if (!content) {
    return {
      schema: structuredClone(DEFAULT_REQUEST_SCHEMA),
      example: {},
      warnings: ["Request body content was missing. Review the imported request schema manually."]
    };
  }

  const media = pickJsonMediaType(root, content);
  if (!media) {
    return {
      schema: structuredClone(DEFAULT_REQUEST_SCHEMA),
      example: {},
      warnings: ["Request body is not declared as JSON. Review this endpoint manually before saving."]
    };
  }

  const schema = media.schema ? normalizeJsonSchema(root, media.schema) : structuredClone(DEFAULT_REQUEST_SCHEMA);
  const example = media.example ?? exampleFromSchema(schema);

  return {
    schema,
    example: example === undefined ? {} : example,
    warnings: media.schema ? [] : ["Request body schema was missing. Review the imported request schema manually."]
  };
}

function extractResponsePayload(root: Record<string, unknown>, operation: Record<string, unknown>): {
  schema: JsonSchema;
  example: unknown;
  warnings: string[];
} {
  const responses = readOptionalObject(operation, "responses");
  if (!responses) {
    return {
      schema: structuredClone(DEFAULT_RESPONSE_SCHEMA),
      example: {},
      warnings: ["No success response schema was declared. Review the imported response schema manually."]
    };
  }

  const hasDefaultResponse = Object.keys(responses).some((status) => status.toLowerCase() === "default");
  for (const [status, responseValue] of sortResponseEntries(responses)) {
    if (!isSuccessfulResponse(status)) {
      continue;
    }

    const response = expectObject(resolveOpenApiNode(root, responseValue), `OpenAPI response ${status}`);
    const content = readOptionalObject(response, "content");
    if (!content) {
      return {
        schema: structuredClone(DEFAULT_RESPONSE_SCHEMA),
        example: {},
        warnings: [`Response ${status} did not declare JSON content. Review the imported response schema manually.`]
      };
    }

    const media = pickJsonMediaType(root, content);
    if (!media) {
      return {
        schema: structuredClone(DEFAULT_RESPONSE_SCHEMA),
        example: {},
        warnings: [`Response ${status} is not declared as JSON. Review this endpoint manually before saving.`]
      };
    }

    const schema = media.schema ? normalizeJsonSchema(root, media.schema) : structuredClone(DEFAULT_RESPONSE_SCHEMA);
    const example = media.example ?? exampleFromSchema(schema);
    return {
      schema,
      example: example === undefined ? {} : example,
      warnings: media.schema ? [] : [`Response ${status} schema was missing. Review the imported response schema manually.`]
    };
  }

  return {
    schema: structuredClone(DEFAULT_RESPONSE_SCHEMA),
    example: {},
    warnings: [
      hasDefaultResponse
        ? "No explicit 2xx success response schema was declared. The OpenAPI default response was ignored because it is usually an error shape."
        : "No success response schema was declared. Review the imported response schema manually."
    ]
  };
}

function inferUpstreamAuthMode(
  root: Record<string, unknown>,
  operation: Record<string, unknown>
): { mode: UpstreamAuthMode; headerName: string | null; warnings: string[] } {
  const warnings: string[] = [];
  const securityValue = operation.security ?? root.security;

  if (securityValue === undefined) {
    return {
      mode: "none",
      headerName: null,
      warnings
    };
  }

  if (!Array.isArray(securityValue)) {
    return {
      mode: "none",
      headerName: null,
      warnings: ["Security requirements could not be parsed. Review auth settings manually."]
    };
  }

  if (securityValue.length === 0) {
    return {
      mode: "none",
      headerName: null,
      warnings
    };
  }

  const securitySchemes =
    readOptionalObject(readOptionalObject(root, "components"), "securitySchemes") ?? {};
  const supportedCandidates: Array<{ mode: UpstreamAuthMode; headerName: string | null }> = [];
  let allowsAnonymous = false;
  let sawUnsupported = false;

  for (const requirement of securityValue) {
    if (!isRecord(requirement)) {
      sawUnsupported = true;
      continue;
    }

    const schemeNames = Object.keys(requirement);
    if (schemeNames.length === 0) {
      allowsAnonymous = true;
      continue;
    }

    if (schemeNames.length !== 1) {
      sawUnsupported = true;
      continue;
    }

    const schemeName = schemeNames[0] ?? "";
    const schemeValue = securitySchemes[schemeName];
    if (!schemeValue) {
      sawUnsupported = true;
      continue;
    }

    const scheme = expectObject(resolveOpenApiNode(root, schemeValue), `OpenAPI security scheme ${schemeName}`);
    const type = readOptionalString(scheme, "type");
    if (type === "http" && readOptionalString(scheme, "scheme")?.toLowerCase() === "bearer") {
      supportedCandidates.push({
        mode: "bearer",
        headerName: null
      });
      continue;
    }

    if (type === "apiKey" && readOptionalString(scheme, "in") === "header") {
      const headerName = readOptionalString(scheme, "name");
      if (headerName) {
        supportedCandidates.push({
          mode: "header",
          headerName
        });
        continue;
      }
    }

    sawUnsupported = true;
  }

  if (allowsAnonymous) {
    warnings.push("Security requirements allow unauthenticated access. Imported auth settings as none.");
    return {
      mode: "none",
      headerName: null,
      warnings
    };
  }

  if (supportedCandidates.length === 0) {
    warnings.push("Could not infer a supported upstream auth scheme. Review auth settings manually.");
    return {
      mode: "none",
      headerName: null,
      warnings
    };
  }

  const uniqueCandidates = new Map<string, { mode: UpstreamAuthMode; headerName: string | null }>();
  for (const candidate of supportedCandidates) {
    uniqueCandidates.set(`${candidate.mode}:${candidate.headerName ?? ""}`, candidate);
  }

  if (uniqueCandidates.size > 1) {
    warnings.push("Multiple alternative auth schemes were declared. Review auth settings manually.");
    return {
      mode: "none",
      headerName: null,
      warnings
    };
  }

  if (sawUnsupported) {
    warnings.push("Some security requirements could not be mapped automatically. Review auth settings manually.");
  }

  const resolved = uniqueCandidates.values().next().value;
  if (!resolved) {
    warnings.push("Could not infer a supported upstream auth scheme. Review auth settings manually.");
    return {
      mode: "none",
      headerName: null,
      warnings
    };
  }

  return {
    mode: resolved.mode,
    headerName: resolved.headerName,
    warnings
  };
}

function resolveServerUrl(input: {
  root: Record<string, unknown>;
  documentUrl: string;
  operation: Record<string, unknown>;
  pathItem: Record<string, unknown>;
}): string {
  const candidates = [input.operation.servers, input.pathItem.servers, input.root.servers];

  for (const candidate of candidates) {
    if (!Array.isArray(candidate) || candidate.length === 0) {
      continue;
    }

    const server = candidate[0];
    if (!isRecord(server) || typeof server.url !== "string" || server.url.trim().length === 0) {
      continue;
    }

    return new URL(server.url, input.documentUrl).toString().replace(/\/$/, "");
  }

  return new URL(input.documentUrl).origin;
}

function hasNonHeaderParameters(
  root: Record<string, unknown>,
  pathItem: Record<string, unknown>,
  operation: Record<string, unknown>
): boolean {
  const parameterValues = [...collectParameters(pathItem), ...collectParameters(operation)];

  return parameterValues.some((parameterValue) => {
    const parameter = expectObject(resolveOpenApiNode(root, parameterValue), "OpenAPI parameter");
    const location = readOptionalString(parameter, "in");
    return location === "path" || location === "query" || location === "cookie";
  });
}

function collectParameters(container: Record<string, unknown>): unknown[] {
  return Array.isArray(container.parameters) ? container.parameters : [];
}

function sortResponseEntries(responses: Record<string, unknown>): Array<[string, unknown]> {
  return Object.entries(responses).sort(([left], [right]) => compareResponseStatus(left, right));
}

function compareResponseStatus(left: string, right: string): number {
  const leftRank = responseStatusRank(left);
  const rightRank = responseStatusRank(right);
  if (leftRank !== rightRank) {
    return leftRank - rightRank;
  }

  return left.localeCompare(right);
}

function responseStatusRank(status: string): number {
  if (/^2\d\d$/.test(status)) {
    return Number.parseInt(status, 10);
  }

  if (/^2xx$/i.test(status)) {
    return 299;
  }

  return 500;
}

function isSuccessfulResponse(status: string): boolean {
  return /^2\d\d$/.test(status) || /^2xx$/i.test(status);
}

function pickJsonMediaType(
  root: Record<string, unknown>,
  content: Record<string, unknown>
): { schema: unknown; example: unknown } | null {
  for (const [contentType, mediaValue] of Object.entries(content)) {
    if (!isJsonContentType(contentType)) {
      continue;
    }

    const media = expectObject(resolveOpenApiNode(root, mediaValue), `OpenAPI media type ${contentType}`);
    return {
      schema: media.schema,
      example: extractMediaExample(root, media)
    };
  }

  return null;
}

function isJsonContentType(contentType: string): boolean {
  const normalized = contentType.toLowerCase();
  return normalized === "application/json" || normalized.endsWith("+json") || normalized === "*/*";
}

function extractMediaExample(root: Record<string, unknown>, media: Record<string, unknown>): unknown {
  if ("example" in media) {
    return cloneValue(media.example);
  }

  const examples = readOptionalObject(media, "examples");
  if (examples) {
    for (const exampleValue of Object.values(examples)) {
      const resolved = resolveOpenApiNode(root, exampleValue);
      if (isRecord(resolved) && "value" in resolved) {
        return cloneValue(resolved.value);
      }
    }
  }

  if ("schema" in media) {
    const schema = normalizeJsonSchema(root, media.schema);
    if (isRecord(schema) && "example" in schema) {
      return cloneValue(schema.example);
    }
  }

  return undefined;
}

function normalizeJsonSchema(root: Record<string, unknown>, schemaValue: unknown): JsonSchema {
  const resolved = resolveOpenApiNode(root, schemaValue);
  if (!isRecord(resolved)) {
    return structuredClone(DEFAULT_REQUEST_SCHEMA);
  }

  return normalizeSchemaNode(resolved) as JsonSchema;
}

function normalizeSchemaNode(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeSchemaNode(entry));
  }

  if (!isRecord(value)) {
    return value;
  }

  const normalizedEntries = Object.entries(value).filter(([key]) => key !== "nullable").map(([key, entry]) => [
    key,
    normalizeSchemaNode(entry)
  ]);
  const normalized = Object.fromEntries(normalizedEntries) as Record<string, unknown>;

  if (value.nullable !== true) {
    return normalized;
  }

  if (typeof normalized.type === "string") {
    return {
      ...normalized,
      type: [normalized.type, "null"]
    };
  }

  if (Array.isArray(normalized.type) && !normalized.type.includes("null")) {
    return {
      ...normalized,
      type: [...normalized.type, "null"]
    };
  }

  if (Array.isArray(normalized.enum) && !normalized.enum.includes(null)) {
    return {
      ...normalized,
      enum: [...normalized.enum, null]
    };
  }

  return {
    anyOf: [normalized, { type: "null" }]
  };
}

function exampleFromSchema(schema: unknown, depth = 0): unknown {
  if (depth > 4 || !isRecord(schema)) {
    return {};
  }

  if ("example" in schema) {
    return cloneValue(schema.example);
  }

  if ("default" in schema) {
    return cloneValue(schema.default);
  }

  if ("const" in schema) {
    return cloneValue(schema.const);
  }

  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    return cloneValue(schema.enum[0]);
  }

  if (Array.isArray(schema.anyOf) && schema.anyOf.length > 0) {
    return exampleFromSchema(schema.anyOf[0], depth + 1);
  }

  if (Array.isArray(schema.oneOf) && schema.oneOf.length > 0) {
    return exampleFromSchema(schema.oneOf[0], depth + 1);
  }

  if (Array.isArray(schema.allOf) && schema.allOf.length > 0) {
    return exampleFromSchema(schema.allOf[0], depth + 1);
  }

  const schemaType = Array.isArray(schema.type)
    ? schema.type.find((entry) => entry !== "null")
    : schema.type;

  switch (schemaType) {
    case "string":
      return stringExample(schema);
    case "integer":
    case "number":
      return typeof schema.minimum === "number" ? schema.minimum : 0;
    case "boolean":
      return true;
    case "array":
      return [exampleFromSchema(schema.items, depth + 1)];
    case "object":
      return objectExample(schema, depth + 1);
    case "null":
      return null;
    default:
      if (isRecord(schema.properties)) {
        return objectExample(schema, depth + 1);
      }
      return {};
  }
}

export function buildJsonExample(schema: unknown): unknown {
  return exampleFromSchema(schema);
}

function objectExample(schema: Record<string, unknown>, depth: number): Record<string, unknown> {
  const properties = readOptionalObject(schema, "properties");
  if (!properties) {
    return {};
  }

  const required = Array.isArray(schema.required)
    ? new Set(schema.required.filter((entry): entry is string => typeof entry === "string"))
    : new Set<string>();
  const entries = Object.entries(properties);
  const objectEntries = entries
    .filter(([key]) => required.size === 0 || required.has(key))
    .slice(0, 8)
    .map(([key, value]) => [key, exampleFromSchema(value, depth)]);

  return Object.fromEntries(objectEntries);
}

function stringExample(schema: Record<string, unknown>): string {
  if (Array.isArray(schema.enum) && typeof schema.enum[0] === "string") {
    return schema.enum[0];
  }

  switch (schema.format) {
    case "uri":
    case "url":
      return "https://example.com";
    case "email":
      return "builder@example.com";
    case "date-time":
      return "2026-01-01T00:00:00Z";
    case "date":
      return "2026-01-01";
    case "uuid":
      return "00000000-0000-0000-0000-000000000000";
    default:
      return "string";
  }
}

function resolveOpenApiNode(root: Record<string, unknown>, value: unknown, seenRefs = new Set<string>()): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => resolveOpenApiNode(root, entry, seenRefs));
  }

  if (!isRecord(value)) {
    return value;
  }

  if (typeof value.$ref === "string") {
    const ref = value.$ref;
    if (!ref.startsWith("#/")) {
      throw new Error(`Only local OpenAPI references are supported: ${ref}`);
    }

    if (seenRefs.has(ref)) {
      throw new Error(`Recursive OpenAPI references are not supported: ${ref}`);
    }

    const target = resolveJsonPointer(root, ref);
    const merged = {
      ...(isRecord(target) ? cloneValue(target) as Record<string, unknown> : {}),
      ...Object.fromEntries(Object.entries(value).filter(([key]) => key !== "$ref"))
    };

    return resolveOpenApiNode(root, merged, new Set([...seenRefs, ref]));
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, resolveOpenApiNode(root, entry, seenRefs)])
  );
}

function resolveJsonPointer(root: Record<string, unknown>, ref: string): unknown {
  const parts = ref
    .slice(2)
    .split("/")
    .map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"));

  let current: unknown = root;
  for (const part of parts) {
    if (!isRecord(current) && !Array.isArray(current)) {
      throw new Error(`Unable to resolve OpenAPI reference: ${ref}`);
    }

    current = (current as Record<string, unknown> | unknown[])[part as keyof typeof current];
  }

  if (current === undefined) {
    throw new Error(`Unable to resolve OpenAPI reference: ${ref}`);
  }

  return current;
}

function dedupeOperationSlug(base: string, seen: Set<string>): string {
  let next = base;
  let index = 2;
  while (seen.has(next)) {
    next = truncateSlug(`${base}-${index}`);
    index += 1;
  }

  seen.add(next);
  return next;
}

function slugifyOperation(value: string): string {
  const normalized = value
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
  return truncateSlug(normalized.length >= 2 ? normalized : "operation");
}

function truncateSlug(value: string): string {
  return value.slice(0, 64).replace(/-+$/g, "") || "operation";
}

function titleCaseFromSlug(slug: string): string {
  return slug
    .split("-")
    .filter(Boolean)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(" ");
}

function cloneValue<T>(value: T): T {
  return value === undefined ? value : structuredClone(value);
}

function expectObject(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object.`);
  }

  return value;
}

function readOptionalObject(value: unknown, key: string): Record<string, unknown> | null {
  if (!isRecord(value)) {
    return null;
  }

  const next = value[key];
  return isRecord(next) ? next : null;
}

function readOptionalString(value: unknown, key: string): string | null {
  if (!isRecord(value)) {
    return null;
  }

  const next = value[key];
  return typeof next === "string" && next.trim().length > 0 ? next.trim() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
