import express from 'express';
import type { Config } from '../config.ts';
import { currentUserId } from '../http/current-user.ts';
import { asyncHandler, badRequest } from '../http/errors.ts';
import { requireIdList, requireText } from '../http/validate.ts';
import type { Store } from '../store/types.ts';

export function conversationsRouter(store: Store, config: Config): express.Router {
  const router = express.Router();

  router.get(
    '/',
    asyncHandler(async (req, res) => {
      const userId = currentUserId(req);
      res.json(await store.listConversationsForUser(userId));
    }),
  );

  router.post(
    '/',
    asyncHandler(async (req, res) => {
      const userId = currentUserId(req);
      const { title, participantIds } = req.body ?? {};

      const cleanTitle = requireText(title, 'title', 200);
      const participants = requireIdList(participantIds, 'participantIds');
      // Creating a conversation you are not in produces a room you cannot open.
      if (!participants.includes(userId)) {
        throw badRequest('participantIds must include the calling user');
      }

      res.status(201).json(await store.createConversation(cleanTitle, participants));
    }),
  );

  return router;
}
