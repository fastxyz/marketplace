type QueryScalarType = "string" | "number" | "integer" | "boolean";

interface QuerySchemaPropertyDescriptor {
  name: string;
  required: boolean;
  isArray: boolean;
  scalarType: QueryScalarType;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function getQuerySchemaProperties(schema: unknown): QuerySchemaPropertyDescriptor[] {
  if (!isRecord(schema) || schema.type !== "object") {
    throw new Error("GET routes require requestSchemaJson.type to be object.");
  }

  if (schema.additionalProperties !== undefined && schema.additionalProperties !== false) {
    throw new Error("GET routes do not support additionalProperties in requestSchemaJson.");
  }

  if (schema.properties === undefined) {
    return [];
  }

  if (!isRecord(schema.properties)) {
    throw new Error("GET routes require requestSchemaJson.properties to be an object.");
  }

  const requiredNames = Array.isArray(schema.required)
    ? new Set(schema.required.filter((value): value is string => typeof value === "string"))
    : new Set<string>();

  return Object.entries(schema.properties)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, propertySchema]) => {
      if (!isRecord(propertySchema)) {
        throw new Error(`GET routes require a JSON schema object for property "${name}".`);
      }

      if (propertySchema.type === "array") {
        if (!isRecord(propertySchema.items)) {
          throw new Error(`GET array property "${name}" must declare an item schema.`);
        }

        const itemType = propertySchema.items.type;
        if (itemType !== "string" && itemType !== "number" && itemType !== "integer" && itemType !== "boolean") {
          throw new Error(`GET array property "${name}" only supports string, number, integer, or boolean items.`);
        }

        return {
          name,
          required: requiredNames.has(name),
          isArray: true,
          scalarType: itemType
        };
      }

      if (
        propertySchema.type !== "string"
        && propertySchema.type !== "number"
        && propertySchema.type !== "integer"
        && propertySchema.type !== "boolean"
      ) {
        throw new Error(`GET property "${name}" only supports string, number, integer, or boolean schemas.`);
      }

      return {
        name,
        required: requiredNames.has(name),
        isArray: false,
        scalarType: propertySchema.type
      };
    });
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

export function serializeBrowserQueryInput(input: {
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
