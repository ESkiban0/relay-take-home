import { badRequest } from './errors.ts';

/**
 * Small hand-rolled validators. A schema library (zod) would be the reach for a
 * real service; at this surface area it would be more dependency than value,
 * but the boundary is deliberately in one place so swapping it is a local edit.
 */

export function requireId(value: unknown, field: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw badRequest(`${field} must be a positive integer`);
  return n;
}

export function optionalId(value: unknown, field: string): number | undefined {
  if (value === undefined || value === '') return undefined;
  return requireId(value, field);
}

export function requireText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string') throw badRequest(`${field} must be a string`);
  const trimmed = value.trim();
  if (!trimmed) throw badRequest(`${field} must not be empty`);
  if (trimmed.length > maxLength) {
    throw badRequest(`${field} must be at most ${maxLength} characters`);
  }
  return trimmed;
}

export function optionalClientId(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw badRequest('clientId must be a string');
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > 64) throw badRequest('clientId must be at most 64 characters');
  return trimmed;
}

export function requireIdList(value: unknown, field: string): number[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw badRequest(`${field} must be a non-empty array`);
  }
  if (value.length > 100) throw badRequest(`${field} must contain at most 100 entries`);
  return value.map((v) => requireId(v, `${field}[]`));
}
