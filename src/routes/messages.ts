import express from 'express';
import type { Config } from '../config.ts';
import { currentUserId } from '../http/current-user.ts';
import { asyncHandler, forbidden, HttpError } from '../http/errors.ts';
import { optionalClientId, optionalId, requireId, requireText } from '../http/validate.ts';
import type { Broker } from '../infra/broker.ts';
import type { RateLimiter } from '../infra/rate-limit.ts';
import type { Store } from '../store/types.ts';

export function messagesRouter(
  store: Store,
  broker: Broker,
  rateLimiter: RateLimiter,
  config: Config,
): express.Router {
  const router = express.Router();

  router.post(
    '/',
    asyncHandler(async (req, res) => {
      const senderId = currentUserId(req);
      const { conversationId: rawConversationId, body: rawBody, clientId: rawClientId } = req.body ?? {};

      const conversationId = requireId(rawConversationId, 'conversationId');
      const body = requireText(rawBody, 'body', config.maxMessageLength);
      const clientId = optionalClientId(rawClientId);

      if (!(await store.isParticipant(conversationId, senderId))) {
        throw forbidden('not a participant of this conversation');
      }

      // Keyed per user *and* per conversation, so a noisy sender throttles only
      // their own stream in one room. Checked before the write, not after.
      const decision = await rateLimiter.consume(`msg:${senderId}:${conversationId}`);
      if (!decision.allowed) {
        const retryAfterSeconds = Math.max(1, Math.ceil(decision.retryAfterMs / 1000));
        throw new HttpError(429, 'too many messages, slow down', {
          'Retry-After': String(retryAfterSeconds),
        });
      }

      const { message, deduplicated } = await store.createMessage({
        conversationId,
        senderId,
        body,
        clientId,
      });

      // A replayed clientId must not produce a second broadcast, or every retry
      // would paint a duplicate into everyone's open window.
      if (!deduplicated) {
        await broker.publish({ conversationId, payload: { type: 'message', ...message } });
      }

      res.status(deduplicated ? 200 : 201).json(message);
    }),
  );

  router.get(
    '/',
    asyncHandler(async (req, res) => {
      const userId = currentUserId(req);
      const conversationId = requireId(req.query.conversationId, 'conversationId');
      const before = optionalId(req.query.before, 'before');

      if (!(await store.isParticipant(conversationId, userId))) {
        throw forbidden('not a participant of this conversation');
      }

      // Unbounded history was the previous behaviour; one busy conversation was
      // enough to hand a client megabytes of JSON.
      const messages = await store.listMessages(conversationId, {
        before,
        limit: config.messagePageSize,
      });

      res.json({
        messages,
        // Cursor for the next older page; null once the start is reached.
        nextBefore: messages.length === config.messagePageSize ? messages[0].id : null,
      });
    }),
  );

  return router;
}
