import type { Store } from '../src/store/types.ts';

/** The same demo fixture the Docker stack seeds, for the in-memory driver. */
export async function seedDemoData(store: Store): Promise<void> {
  const support = await store.createConversation('Support — order #1042', [1, 2]);
  const design = await store.createConversation('Design sync', [1, 3]);

  const seed = [
    { conversationId: support.id, senderId: 2, body: 'Hi, any update on order #1042?' },
    { conversationId: support.id, senderId: 1, body: 'Checking now — give me a minute.' },
    { conversationId: design.id, senderId: 3, body: 'Notes from the design sync are in the doc.' },
  ];

  for (const message of seed) {
    await store.createMessage({ ...message, clientId: null });
  }
}
