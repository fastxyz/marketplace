import { validateJsonSchema } from "./json-schema.js";
import {
  getQuerySchemaProperties as getBrowserQuerySchemaProperties,
  serializeQueryInput as serializeBrowserQueryInput,
  type QuerySchemaPropertyDescriptor
} from "./browser-request-input.js";
import type { JsonSchema } from "./types.js";

function coerceScalar(name: string, type: QuerySchemaPropertyDescriptor["scalarType"], value: string): string | number | boolean {
  if (type === "string") {
    return value;
  }

  if (type === "boolean") {
    if (value === "true") {
      return true;
    }
    if (value === "false") {
      return false;
    }
    throw new Error(`Query parameter "${name}" must be "true" or "false".`);
  }

  if (!/^-?\d+(?:\.\d+)?$/.test(value)) {
    throw new Error(`Query parameter "${name}" must be a valid ${type}.`);
  }

  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    throw new Error(`Query parameter "${name}" must be a finite ${type}.`);
  }

  if (type === "integer" && !Number.isInteger(numeric)) {
    throw new Error(`Query parameter "${name}" must be an integer.`);
  }

  return numeric;
}

export { type QuerySchemaPropertyDescriptor };

export function getQuerySchemaProperties(schema: JsonSchema): QuerySchemaPropertyDescriptor[] {
  return getBrowserQuerySchemaProperties(schema);
}

export function coerceQueryInput(input: {
  schema: JsonSchema;
  searchParams: URLSearchParams;
  label?: string;
}): Record<string, unknown> {
  const label = input.label ?? "Query parameters";
  const descriptors = getQuerySchemaProperties(input.schema);
  const descriptorByName = new Map(descriptors.map((descriptor) => [descriptor.name, descriptor]));
  const values: Record<string, unknown> = {};

  for (const key of new Set(input.searchParams.keys())) {
    const descriptor = descriptorByName.get(key);
    if (!descriptor) {
      throw new Error(`${label} include unsupported key "${key}".`);
    }

    const rawValues = input.searchParams.getAll(key);
    if (descriptor.isArray) {
      values[key] = rawValues.map((value) => coerceScalar(key, descriptor.scalarType, value));
      continue;
    }

    if (rawValues.length !== 1) {
      throw new Error(`${label} must include exactly one "${key}" value.`);
    }

    values[key] = coerceScalar(key, descriptor.scalarType, rawValues[0] ?? "");
  }

  validateJsonSchema({
    schema: input.schema,
    value: values,
    label
  });

  return values;
}

export function serializeQueryInput(input: {
  schema: JsonSchema;
  value: unknown;
  label?: string;
}): string {
  validateJsonSchema({
    schema: input.schema,
    value: input.value,
    label: input.label ?? "GET request"
  });

  return serializeBrowserQueryInput(input);
}
