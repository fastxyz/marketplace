export type QueryScalarType = "string" | "number" | "integer" | "boolean";

export interface QuerySchemaPropertyDescriptor {
  name: string;
  required: boolean;
  isArray: boolean;
  scalarType: QueryScalarType;
  schema: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function expectObjectSchema(schema: unknown): Record<string, unknown> {
  if (!isRecord(schema) || schema.type !== "object") {
    throw new Error("GET routes require requestSchemaJson.type to be object.");
  }

  if (schema.additionalProperties !== undefined && schema.additionalProperties !== false) {
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

function expectPropertySchema(name: string, schemaValue: unknown): Record<string, unknown> {
  if (!isRecord(schemaValue)) {
    throw new Error(`GET routes require a JSON schema object for property "${name}".`);
  }

  return schemaValue;
}

function resolveScalarType(name: string, schema: Record<string, unknown>): {
  isArray: boolean;
  scalarType: QueryScalarType;
  schema: Record<string, unknown>;
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

export function getQuerySchemaProperties(schema: unknown): QuerySchemaPropertyDescriptor[] {
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

export function serializeQueryInput(input: {
  schema: unknown;
  value: unknown;
  label?: string;
}): string {
  const label = input.label ?? "GET request";
  const descriptors = getQuerySchemaProperties(input.schema);

  if (!isRecord(input.value)) {
    throw new Error(`${label} must be a JSON object.`);
  }

  const searchParams = new URLSearchParams();
  for (const descriptor of descriptors) {
    const rawValue = input.value[descriptor.name];
    if (rawValue === undefined) {
      if (descriptor.required) {
        throw new Error(`GET property "${descriptor.name}" is required.`);
      }
      continue;
    }

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
