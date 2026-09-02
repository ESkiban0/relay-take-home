/** Shared domain types + the storage contract the HTTP/WS layers program against. */

export interface Message {
  id: number;
  conversationId: number;
  senderId: number;
  body: string;
  createdAt: Date;
  clientId: string | null;
}

/** A message stripped down to what the conversation list needs. */
export interface MessagePreview {
  id: number;
  senderId: number;
  body: string;
  createdAt: Date;
}

export interface ConversationSummary {
  id: number;
  title: string;
  messageCount: number;
  lastMessage: MessagePreview | null;
}

export interface Conversation {
  id: number;
  title: string;
  participantIds: number[];
}

export interface NewMessage {
  conversationId: number;
  senderId: number;
  body: string;
  clientId: string | null;
}

/**
 * Result of an insert attempt. `deduplicated` is true when `clientId` matched a
 * message this sender already stored, in which case `message` is the original.
 */
export interface CreateMessageResult {
  message: Message;
  deduplicated: boolean;
}

export interface ListMessagesOptions {
  /** Return messages with an id strictly lower than this (backwards paging). */
  before?: number;
  limit: number;
}

export interface SearchHit {
  messageId: number;
  conversationId: number;
  conversationTitle: string;
  senderId: number;
  body: string;
  createdAt: Date;
}

export interface Store {
  listConversationsForUser(userId: number): Promise<ConversationSummary[]>;
  createConversation(title: string, participantIds: number[]): Promise<Conversation>;
  /** Membership check — the authorisation primitive for every conversation-scoped call. */
  isParticipant(conversationId: number, userId: number): Promise<boolean>;
  conversationIdsForUser(userId: number): Promise<number[]>;
  listMessages(conversationId: number, opts: ListMessagesOptions): Promise<Message[]>;
  createMessage(input: NewMessage): Promise<CreateMessageResult>;
  searchMessages(userId: number, query: string, limit: number): Promise<SearchHit[]>;
  close(): Promise<void>;
}
