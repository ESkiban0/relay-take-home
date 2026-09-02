import type { NextFunction, Request, RequestHandler, Response } from 'express';

/** An error carrying the HTTP status the client should see. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export const badRequest = (message: string) => new HttpError(400, message);
export const forbidden = (message: string) => new HttpError(403, message);
export const notFound = (message: string) => new HttpError(404, message);

/**
 * Express 4 does not catch rejected promises from async handlers: the rejection
 * escapes to `unhandledRejection` and the request is simply never answered, so
 * the caller hangs until it times out. Wrapping every async handler routes the
 * rejection into the normal error middleware instead.
 */
export function asyncHandler(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    handler(req, res, next).catch(next);
  };
}

export function errorHandler(): (
  err: unknown,
  req: Request,
  res: Response,
  next: NextFunction,
) => void {
  return (err, _req, res, next) => {
    if (res.headersSent) return next(err);

    if (err instanceof HttpError) {
      res.set(err.headers).status(err.status).json({ error: err.message });
      return;
    }

    // body-parser and friends throw plain Errors carrying an HTTP status — a
    // malformed JSON body is a 400, not a server fault. Honour that rather than
    // reporting every one of them as 500.
    const status = (err as { status?: unknown; statusCode?: unknown }).status ??
      (err as { statusCode?: unknown }).statusCode;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      res.status(status).json({ error: (err as Error).message || 'bad request' });
      return;
    }

    // Anything unrecognised is a bug: log it in full, but do not leak internals.
    console.error('[http] unhandled error', err);
    res.status(500).json({ error: 'internal error' });
  };
}
