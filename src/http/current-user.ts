import type { Request } from 'express';
import { HttpError } from './errors.ts';
import { requireId } from './validate.ts';

/**
 * Resolves "who is calling".
 *
 * THIS IS NOT AUTHENTICATION. The caller still asserts its own identity, exactly
 * as the original code did by taking `userId` straight off the query string —
 * anyone can claim to be user 7. What it buys us is a single seam: every handler
 * now asks one function who the caller is, so replacing this with a session or a
 * verified token is a one-file change rather than a rewrite of every route.
 *
 * Everything downstream (membership checks, search scoping, rate-limit keys) is
 * written as if the identity were trustworthy, so it becomes correct the moment
 * this function is.
 */
export function currentUserId(req: Request): number {
  const header = req.get('x-user-id');
  const raw =
    header ?? (req.query.userId as string | undefined) ?? (req.body as { userId?: unknown })?.userId;

  if (raw === undefined || raw === null || raw === '') {
    throw new HttpError(401, 'x-user-id header is required');
  }
  return requireId(raw, 'x-user-id');
}
