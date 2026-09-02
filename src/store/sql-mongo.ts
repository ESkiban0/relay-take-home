/**
 * Production Store: message metadata in MySQL, message bodies in MongoDB.
 *
 * The split is inherited from the original design. Everything that used to be
 * inline in the route handlers lives here, which is what makes the N+1 fix and
 * the clientId de-duplication expressible as single statements.
 */
import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import type { Db } from 'mongodb';
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

interface BodyDoc {
  _id: number;
  conversationId: number;
  senderId: number;
  body: string;
  createdAt: Date;
}

const DUPLICATE_ENTRY = 'ER_DUP_ENTRY';

export class SqlMongoStore implements Store {
  constructor(
    private readonly pool: Pool,
    private readonly db: Db,
  ) {}

  private get bodies() {
    return this.db.collection<BodyDoc>('message_bodies');
  }

  /**
   * Two queries total, regardless of how many conversations the user is in.
   * The previous implementation ran 2N+1.
   */
  async listConversationsForUser(userId: number): Promise<ConversationSummary[]> {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT c.id,
              c.title,
              COALESCE(agg.message_count, 0) AS messageCount,
              agg.last_id                    AS lastId
         FROM conversations c
         JOIN conversation_participants p
           ON p.conversation_id = c.id AND p.user_id = ?
         LEFT JOIN (
              SELECT conversation_id,
                     COUNT(*) AS message_count,
                     MAX(id)  AS last_id
                FROM messages
               GROUP BY conversation_id
         ) agg ON agg.conversation_id = c.id
        ORDER BY agg.last_id IS NULL, agg.last_id DESC, c.id DESC`,
      [userId],
    );
    if (!rows.length) return [];

    const lastIds = rows.map((r) => Number(r.lastId)).filter((id) => Number.isFinite(id));
    const previews = lastIds.length
      ? await this.loadMessages(
          `SELECT id, conversation_id AS conversationId, sender_id AS senderId,
                  client_id AS clientId, created_at AS createdAt
             FROM messages WHERE id IN (?)`,
          [lastIds],
        )
      : [];
    const byId = new Map(previews.map((m) => [m.id, m]));

    return rows.map((r) => {
      const last = byId.get(Number(r.lastId));
      return {
        id: Number(r.id),
        title: String(r.title),
        messageCount: Number(r.messageCount),
        lastMessage: last
          ? { id: last.id, senderId: last.senderId, body: last.body, createdAt: last.createdAt }
          : null,
      };
    });
  }

  async createConversation(title: string, participantIds: number[]): Promise<Conversation> {
    const unique = [...new Set(participantIds)];
    const conn = await this.pool.getConnection();
    try {
      // A conversation with only some of its participants inserted is a broken
      // conversation, so the whole thing is one transaction.
      await conn.beginTransaction();
      const [created] = await conn.execute<ResultSetHeader>(
        'INSERT INTO conversations (title) VALUES (?)',
        [title],
      );
      const id = created.insertId;
      if (unique.length) {
        await conn.query(
          'INSERT INTO conversation_participants (conversation_id, user_id) VALUES ?',
          [unique.map((uid) => [id, uid])],
        );
      }
      await conn.commit();
      return { id, title, participantIds: unique };
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  }

  async isParticipant(conversationId: number, userId: number): Promise<boolean> {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      'SELECT 1 FROM conversation_participants WHERE conversation_id = ? AND user_id = ? LIMIT 1',
      [conversationId, userId],
    );
    return rows.length > 0;
  }

  async conversationIdsForUser(userId: number): Promise<number[]> {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      'SELECT conversation_id AS id FROM conversation_participants WHERE user_id = ?',
      [userId],
    );
    return rows.map((r) => Number(r.id));
  }

  async listMessages(conversationId: number, opts: ListMessagesOptions): Promise<Message[]> {
    // Newest-first at the database (so LIMIT is cheap and index-ordered), then
    // reversed for display. The previous code selected the whole conversation.
    const where = opts.before === undefined ? '' : ' AND id < ?';
    const params: unknown[] = [conversationId];
    if (opts.before !== undefined) params.push(opts.before);
    params.push(opts.limit);

    const messages = await this.loadMessages(
      `SELECT id, conversation_id AS conversationId, sender_id AS senderId,
              client_id AS clientId, created_at AS createdAt
         FROM messages
        WHERE conversation_id = ?${where}
        ORDER BY id DESC
        LIMIT ?`,
      params,
    );
    return messages.reverse();
  }

  async createMessage(input: NewMessage): Promise<CreateMessageResult> {
    let id: number;
    try {
      const [res] = await this.pool.execute<ResultSetHeader>(
        'INSERT INTO messages (conversation_id, sender_id, client_id) VALUES (?, ?, ?)',
        [input.conversationId, input.senderId, input.clientId],
      );
      id = res.insertId;
    } catch (err) {
      // The unique key on (conversation_id, sender_id, client_id) turns a
      // retried or double-clicked send into a no-op instead of a duplicate.
      if ((err as { code?: string }).code === DUPLICATE_ENTRY && input.clientId !== null) {
        const existing = await this.findByClientId(input);
        if (existing) return { message: existing, deduplicated: true };
      }
      throw err;
    }

    const createdAt = new Date();
    try {
      await this.bodies.insertOne({
        _id: id,
        conversationId: input.conversationId,
        senderId: input.senderId,
        body: input.body,
        createdAt,
      });
    } catch (err) {
      // There is no cross-store transaction between MySQL and Mongo. Rather
      // than leave a metadata row whose body renders as '' forever, undo it.
      await this.pool.execute('DELETE FROM messages WHERE id = ?', [id]).catch(() => {
        /* best effort; the rethrow below is what the caller acts on */
      });
      throw err;
    }

    return { message: { id, ...input, createdAt }, deduplicated: false };
  }

  async searchMessages(userId: number, query: string, limit: number): Promise<SearchHit[]> {
    const visible = await this.conversationIdsForUser(userId);
    if (!visible.length) return [];

    const docs = await this.bodies
      .find(
        { conversationId: { $in: visible }, $text: { $search: query } },
        { projection: { score: { $meta: 'textScore' } } },
      )
      .sort({ score: { $meta: 'textScore' }, _id: -1 })
      .limit(limit)
      .toArray();
    if (!docs.length) return [];

    const [rows] = await this.pool.query<RowDataPacket[]>(
      'SELECT id, title FROM conversations WHERE id IN (?)',
      [[...new Set(docs.map((d) => d.conversationId))]],
    );
    const titleById = new Map(rows.map((r) => [Number(r.id), String(r.title)]));

    return docs.map((d) => ({
      messageId: d._id,
      conversationId: d.conversationId,
      conversationTitle: titleById.get(d.conversationId) ?? '',
      senderId: d.senderId,
      body: d.body,
      createdAt: d.createdAt,
    }));
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  /** Runs a metadata query and joins the bodies from Mongo in one round trip. */
  private async loadMessages(sql: string, params: unknown[]): Promise<Message[]> {
    const [rows] = await this.pool.query<RowDataPacket[]>(sql, params);
    if (!rows.length) return [];

    const ids = rows.map((r) => Number(r.id));
    const docs = await this.bodies.find({ _id: { $in: ids } }).toArray();
    const bodyById = new Map(docs.map((d) => [d._id, d.body]));

    return rows.map((r) => ({
      id: Number(r.id),
      conversationId: Number(r.conversationId),
      senderId: Number(r.senderId),
      clientId: r.clientId === null ? null : String(r.clientId),
      createdAt: new Date(r.createdAt),
      body: bodyById.get(Number(r.id)) ?? '',
    }));
  }

  private async findByClientId(input: NewMessage): Promise<Message | null> {
    const [found] = await this.loadMessages(
      `SELECT id, conversation_id AS conversationId, sender_id AS senderId,
              client_id AS clientId, created_at AS createdAt
         FROM messages
        WHERE conversation_id = ? AND sender_id = ? AND client_id = ?
        LIMIT 1`,
      [input.conversationId, input.senderId, input.clientId],
    );
    return found ?? null;
  }
}
