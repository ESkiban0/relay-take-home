import express from 'express';
import type { Config } from '../config.ts';
import { currentUserId } from '../http/current-user.ts';
import { asyncHandler } from '../http/errors.ts';
import type { Store } from '../store/types.ts';

export function searchRouter(store: Store, config: Config): express.Router {
  const router = express.Router();

  // GET /api/search?q=... — results are always scoped to conversations the
  // caller participates in. Search is the easiest place to accidentally build a
  // read-anything endpoint, so the scoping lives in the store query itself
  // rather than as a filter applied afterwards.
  router.get(
    '/',
    asyncHandler(async (req, res) => {
      const userId = currentUserId(req);
      const q = String(req.query.q ?? '').trim();
      if (!q) return res.json([]);

      const hits = await store.searchMessages(userId, q, config.searchLimit);
      res.json(hits);
    }),
  );

  return router;
}
