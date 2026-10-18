/**
 * `@@` links for the board: read the latest user messages of each chat on the
 * board and collect the conversations they referenced.
 */

import { ipcBridge } from '@/common';
import type { TMessage } from '@/common/chat/chatLib';
import { useEffect, useState } from 'react';
import { parseSessionMentions } from './boardGraph';

const MESSAGES_PER_CHAT = 100;

export function mentionsFromMessages(messages: TMessage[]): string[] {
  const ids = new Set<string>();
  for (const message of messages) {
    if (message.type !== 'text' || message.position !== 'right') continue;
    for (const id of parseSessionMentions(message.content.content)) ids.add(id);
  }
  return [...ids];
}

/** `{ sourceConversationId: [mentionedConversationIds] }`, refreshed when `key` changes. */
export function useBoardMentions(conversationIds: string[], key: string): Record<string, string[]> {
  const [mentions, setMentions] = useState<Record<string, string[]>>({});
  const idsKey = conversationIds.join(',');

  useEffect(() => {
    let cancelled = false;
    const ids = idsKey ? idsKey.split(',') : [];
    void Promise.all(
      ids.map(async (id): Promise<readonly [string, string[]]> => {
        const page = await ipcBridge.database.getConversationMessages
          .invoke({ conversation_id: id, limit: MESSAGES_PER_CHAT, content_mode: 'full' })
          .catch((): undefined => undefined);
        return [id, mentionsFromMessages(page?.items ?? [])] as const;
      })
    ).then((entries) => {
      if (!cancelled) setMentions(Object.fromEntries(entries.filter(([, targets]) => targets.length > 0)));
    });
    return () => {
      cancelled = true;
    };
  }, [idsKey, key]);

  return mentions;
}
