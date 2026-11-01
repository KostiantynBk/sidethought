import { z } from 'zod';
import { InterpreterOutputSchema, InvestigatorOutputSchema, DeliberatorOutputSchema, CheckerOutputSchema } from '../../contract/roles.js';
import { object } from './stream.js';

type Schema = Record<string, unknown>;
const original = z.toJSONSchema(InterpreterOutputSchema, {
  reused: 'inline',
  cycles: 'throw',
}) as Schema;

function strictSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(strictSchema);
  const source = object(value);
  if (!source) return value;
  const result = Object.fromEntries(Object.entries(source).map(([key, child]) => [key, strictSchema(child)]));
  // zod's discriminated unions have disjoint literal op tags, so anyOf preserves their meaning.
  if (result.oneOf) {
    result.anyOf = result.oneOf;
    delete result.oneOf;
  }
  const properties = object(result.properties);
  if (properties) {
    const required = source.required as string[] | undefined;
    for (const key of Object.keys(properties)) {
      if (!required?.includes(key) && key !== 'lessonIds') {
        properties[key] = { anyOf: [properties[key], { type: 'null' }] };
      }
    }
    result.required = Object.keys(properties);
    result.additionalProperties = false;
  }
  return result;
}

export const interpreterJsonSchema = strictSchema(original) as Schema;
const investigatorOriginal = z.toJSONSchema(InvestigatorOutputSchema, {
  reused: 'inline',
  cycles: 'throw',
}) as Schema;
export const investigatorJsonSchema = strictSchema(investigatorOriginal) as Schema;

const deliberatorOriginal = z.toJSONSchema(DeliberatorOutputSchema, { reused: 'inline', cycles: 'throw' }) as Schema;
const checkerOriginal = z.toJSONSchema(CheckerOutputSchema, { reused: 'inline', cycles: 'throw' }) as Schema;
export const deliberatorJsonSchema = strictSchema(deliberatorOriginal) as Schema;
export const checkerJsonSchema = strictSchema(checkerOriginal) as Schema;

function unionBranch(schema: Schema, value: unknown): Schema | undefined {
  const branches = (schema.oneOf ?? schema.anyOf) as Schema[] | undefined;
  if (!branches) return schema;
  const data = object(value);
  if (!data) return;
  // Only discriminated object unions occur in the original Interpreter schema.
  return branches.find(branch => Object.entries(object(branch.properties) ?? {}).some(([key, field]) => {
    const property = object(field);
    return property && Object.hasOwn(property, 'const') && property.const === data[key];
  }));
}

function normalize(value: unknown, candidate: Schema): unknown {
  const schema = unionBranch(candidate, value);
  if (!schema) return value;
  if (Array.isArray(value)) {
    const items = object(schema.items);
    return items ? value.map(item => normalize(item, items)) : value;
  }
  const data = object(value);
  const properties = object(schema.properties);
  if (!data || !properties) return value;
  const required = schema.required as string[] | undefined;
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(data)) {
    const property = object(properties[key]);
    if (property && child === null && !required?.includes(key)) continue;
    result[key] = property ? normalize(child, property) : child;
  }
  return result;
}

// Strict wire schemas express optional fields as required nullable fields. Restore absence only at
// originally optional positions; required nulls and unknown properties still fail the original zod contract.
export function normalizeInterpreterWire(value: unknown): unknown {
  return normalize(value, original);
}

export function normalizeInvestigatorWire(value: unknown): unknown {
  return normalize(value, investigatorOriginal);
}
