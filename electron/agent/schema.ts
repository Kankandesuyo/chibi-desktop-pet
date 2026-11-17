import type { JsonSchema, ObjectSchema } from './types';

/**
 * Validates tool arguments against the tool's schema. Unknown properties are rejected so a model cannot
 * smuggle in options the tool author never meant to expose. Returns a list of problems (empty = valid).
 */
export function validate(schema: JsonSchema, value: unknown, path = 'arguments'): string[] {
  switch (schema.type) {
    case 'string': {
      if (typeof value !== 'string') return [`${path} 应为字符串`];
      const errs: string[] = [];
      if (schema.enum && !schema.enum.includes(value)) errs.push(`${path} 只能是 ${schema.enum.join(' / ')}`);
      if (schema.maxLength !== undefined && value.length > schema.maxLength) errs.push(`${path} 太长（最多 ${schema.maxLength} 字符）`);
      if (schema.minLength !== undefined && value.length < schema.minLength) errs.push(`${path} 不能为空`);
      return errs;
    }
    case 'number':
    case 'integer': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return [`${path} 应为数字`];
      if (schema.type === 'integer' && !Number.isInteger(value)) return [`${path} 应为整数`];
      const errs: string[] = [];
      if (schema.minimum !== undefined && value < schema.minimum) errs.push(`${path} 不能小于 ${schema.minimum}`);
      if (schema.maximum !== undefined && value > schema.maximum) errs.push(`${path} 不能大于 ${schema.maximum}`);
      return errs;
    }
    case 'boolean':
      return typeof value === 'boolean' ? [] : [`${path} 应为 true/false`];
    case 'array': {
      if (!Array.isArray(value)) return [`${path} 应为数组`];
      const errs: string[] = [];
      if (schema.maxItems !== undefined && value.length > schema.maxItems) errs.push(`${path} 最多 ${schema.maxItems} 项`);
      if (schema.minItems !== undefined && value.length < schema.minItems) errs.push(`${path} 至少 ${schema.minItems} 项`);
      value.forEach((v, i) => errs.push(...validate(schema.items, v, `${path}[${i}]`)));
      return errs;
    }
    case 'object':
      return validateObject(schema, value, path);
    default:
      return [];                                     // unknown keyword: don't block on it
  }
}

function validateObject(schema: ObjectSchema, value: unknown, path: string): string[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return [`${path} 应为对象`];
  const obj = value as Record<string, unknown>;
  const errs: string[] = [];
  for (const key of schema.required ?? []) {
    if (obj[key] === undefined || obj[key] === null) errs.push(`缺少必填参数 ${path === 'arguments' ? key : `${path}.${key}`}`);
  }
  for (const [key, v] of Object.entries(obj)) {
    const sub = schema.properties?.[key];
    if (!sub) { errs.push(`不认识的参数 ${key}`); continue; }
    if (v === undefined || v === null) continue;
    errs.push(...validate(sub, v, path === 'arguments' ? key : `${path}.${key}`));
  }
  return errs;
}

/** Drops nulls so optional parameters the model filled with null behave like "not given". */
export function stripNulls(value: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) if (v !== null && v !== undefined) out[k] = v;
  return out;
}
