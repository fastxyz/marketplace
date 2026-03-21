import { validateJsonSchema } from "./json-schema.js";
import type { JsonSchema } from "./types.js";

type QueryScalarType = "string" | "number" | "integer" | "boolean";

export interface QuerySchemaPropertyDescriptor {
  name: string;
  required: boolean;
  isArray: boolean;
  scalarType: QueryScalarType;
  schema: JsonSchema;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function expectObjectSchema(schema: JsonSchema): Record<string, unknown> {
  if (!isRecord(schema) || schema.type !== "object") {
    throw new Error("GET routes require requestSchemaJson.type to be object.");
  }

  const additionalProperties = schema.additionalProperties;
  if (additionalProperties !== undefined && additionalProperties !== false) {
    throw new Error("GET routes do not support additionalProperties in requestSchemaJson.");
  }

  return schema;
}

function readRequiredNames(schema: Record<string, unknown>): Set<string> {
  if (!Array.isArray(schema.required)) {
    return new Set();
  }

  return new Set(schema.required.filter((value): value is string => typeof value === "string"));
}

function expectPropertySchema(name: string, schemaValue: unknown): QuerySchemaPropertyDescriptor["schema"] {
  if (!isRecord(schemaValue)) {
    throw new Error(`GET routes require a JSON schema object for property "${name}".`);
  }

  return schemaValue as JsonSchema;
}

function resolveScalarType(name: string, schema: QuerySchemaPropertyDescriptor["schema"]): {
  isArray: boolean;
  scalarType: QueryScalarType;
  schema: JsonSchema;
} {
  if (schema.type === "array") {
    if (!isRecord(schema.items)) {
      throw new Error(`GET array property "${name}" must declare an item schema.`);
    }

    const itemType = schema.items.type;
    if (itemType !== "string" && itemType !== "number" && itemType !== "integer" && itemType !== "boolean") {
      throw new Error(`GET array property "${name}" only supports string, number, integer, or boolean items.`);
    }

    return {
      isArray: true,
      scalarType: itemType,
      schema
    };
  }

  if (schema.type !== "string" && schema.type !== "number" && schema.type !== "integer" && schema.type !== "boolean") {
    throw new Error(`GET property "${name}" only supports string, number, integer, or boolean schemas.`);
  }

  return {
    isArray: false,
    scalarType: schema.type,
    schema
  };
}

function coerceScalar(name: string, type: QueryScalarType, value: string): string | number | boolean {
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

function serializeScalar(name: string, type: QueryScalarType, value: unknown): string {
  if (type === "string") {
    if (typeof value !== "string") {
      throw new Error(`GET property "${name}" must be a string.`);
    }
    return value;
  }

  if (type === "boolean") {
    if (typeof value !== "boolean") {
      throw new Error(`GET property "${name}" must be a boolean.`);
    }
    return value ? "true" : "false";
  }

  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`GET property "${name}" must be a finite ${type}.`);
  }

  if (type === "integer" && !Number.isInteger(value)) {
    throw new Error(`GET property "${name}" must be an integer.`);
  }

  return String(value);
}

export function getQuerySchemaProperties(schema: JsonSchema): QuerySchemaPropertyDescriptor[] {
  const root = expectObjectSchema(schema);
  const properties = root.properties;
  if (properties === undefined) {
    return [];
  }

  if (!isRecord(properties)) {
    throw new Error("GET routes require requestSchemaJson.properties to be an object.");
  }

  const required = readRequiredNames(root);

  return Object.entries(properties)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, schemaValue]) => {
      const propertySchema = expectPropertySchema(name, schemaValue);
      const scalar = resolveScalarType(name, propertySchema);
      return {
        name,
        required: required.has(name),
        isArray: scalar.isArray,
        scalarType: scalar.scalarType,
        schema: scalar.schema
      };
    });
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
  const label = input.label ?? "GET request";
  const descriptors = getQuerySchemaProperties(input.schema);

  validateJsonSchema({
    schema: input.schema,
    value: input.value,
    label
  });

  if (!isRecord(input.value)) {
    throw new Error(`${label} must be a JSON object.`);
  }

  const searchParams = new URLSearchParams();
  for (const descriptor of descriptors) {
    if (!(descriptor.name in input.value) || input.value[descriptor.name] === undefined) {
      continue;
    }

    const rawValue = input.value[descriptor.name];
    if (descriptor.isArray) {
      if (!Array.isArray(rawValue)) {
        throw new Error(`GET property "${descriptor.name}" must be an array.`);
      }

      for (const item of rawValue) {
        searchParams.append(descriptor.name, serializeScalar(descriptor.name, descriptor.scalarType, item));
      }

      continue;
    }

    searchParams.append(descriptor.name, serializeScalar(descriptor.name, descriptor.scalarType, rawValue));
  }

  const queryString = searchParams.toString();
  return queryString.length === 0 ? "" : `?${queryString}`;
}
