/**
 * In-memory Store. Used by the test suite and by `STORE=memory npm run dev`, so
 * the app can be exercised end-to-end without MySQL/Mongo.
 *
 * It deliberately mirrors the SQL implementation's *contract* (id ordering,
 * clientId de-duplication, membership scoping, search term matching) rather
 * than its internals — see docs/0001-store-abstraction.md.
 */
import type {
  Conversation,
  ConversationSummary,
  CreateMessageResult,
  ListMessagesOptions,
  Message,
  NewMessage,
  SearchHit,
  Store,
} from './types.ts';

interface ConversationRow {
  id: number;
  title: string;
  participantIds: Set<number>;
}

/** Lowercased word tokens, matching the tokenisation the search contract assumes. */
function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

export class MemoryStore implements Store {
  #conversations = new Map<number, ConversationRow>();
  #messages: Message[] = [];
  #nextConversationId = 1;
  #nextMessageId = 1;

  async listConversationsForUser(userId: number): Promise<ConversationSummary[]> {
    const summaries: ConversationSummary[] = [];
    for (const c of this.#conversations.values()) {
      if (!c.participantIds.has(userId)) continue;
      const msgs = this.#messages.filter((m) => m.conversationId === c.id);
      const last = msgs.length ? msgs[msgs.length - 1] : null;
      summaries.push({
        id: c.id,
        title: c.title,
        messageCount: msgs.length,
        lastMessage: last
          ? { id: last.id, senderId: last.senderId, body: last.body, createdAt: last.createdAt }
          : null,
      });
    }
    // Most recently active first, mirroring the SQL ORDER BY.
    summaries.sort((a, b) => (b.lastMessage?.id ?? 0) - (a.lastMessage?.id ?? 0) || b.id - a.id);
    return summaries;
  }

  async createConversation(title: string, participantIds: number[]): Promise<Conversation> {
    const id = this.#nextConversationId++;
    const unique = [...new Set(participantIds)];
    this.#conversations.set(id, { id, title, participantIds: new Set(unique) });
    return { id, title, participantIds: unique };
  }

  async isParticipant(conversationId: number, userId: number): Promise<boolean> {
    return this.#conversations.get(conversationId)?.participantIds.has(userId) ?? false;
  }

  async conversationIdsForUser(userId: number): Promise<number[]> {
    return [...this.#conversations.values()]
      .filter((c) => c.participantIds.has(userId))
      .map((c) => c.id);
  }

  async listMessages(conversationId: number, opts: ListMessagesOptions): Promise<Message[]> {
    const all = this.#messages.filter(
      (m) => m.conversationId === conversationId && (opts.before === undefined || m.id < opts.before),
    );
    // Newest `limit` rows, returned oldest-first.
    return all.slice(Math.max(0, all.length - opts.limit));
  }

  async createMessage(input: NewMessage): Promise<CreateMessageResult> {
    if (input.clientId !== null) {
      const existing = this.#messages.find(
        (m) =>
          m.conversationId === input.conversationId &&
          m.senderId === input.senderId &&
          m.clientId === input.clientId,
      );
      if (existing) return { message: existing, deduplicated: true };
    }
    const message: Message = {
      id: this.#nextMessageId++,
      conversationId: input.conversationId,
      senderId: input.senderId,
      body: input.body,
      clientId: input.clientId,
      createdAt: new Date(),
    };
    this.#messages.push(message);
    return { message, deduplicated: false };
  }

  async searchMessages(userId: number, query: string, limit: number): Promise<SearchHit[]> {
    const terms = tokenize(query);
    if (!terms.length) return [];
    const visible = new Set(await this.conversationIdsForUser(userId));

    return this.#messages
      .filter((m) => {
        if (!visible.has(m.conversationId)) return false;
        const tokens = tokenize(m.body);
        return terms.every((t) => tokens.some((tok) => tok.startsWith(t)));
      })
      .sort((a, b) => b.id - a.id)
      .slice(0, limit)
      .map((m) => ({
        messageId: m.id,
        conversationId: m.conversationId,
        conversationTitle: this.#conversations.get(m.conversationId)?.title ?? '',
        senderId: m.senderId,
        body: m.body,
        createdAt: m.createdAt,
      }));
  }

  async close(): Promise<void> {}
}
