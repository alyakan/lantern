/**
 * "Continue in another agent": write the current chat's transcript to a file,
 * open a new chat with the chosen agent in the same workspace, and send it a
 * first message with the transcript attached.
 */

import { ipcBridge } from '@/common';
import type { TMessage } from '@/common/chat/chatLib';
import type { TChatConversation } from '@/common/config/storage';
import { parseError } from '@/common/utils';
import { emitter } from '@/renderer/utils/emitter';
import { Message } from '@arco-design/web-react';
import { useCallback, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { buildHandoffPrompt, buildHandoffTranscript, type HandoffSource } from './handoffTranscript';
import type { HandoffTarget } from './handoffTargets';

const PAGE_SIZE = 200;
const MAX_PAGES = 25;

/** Read the whole conversation (oldest first), newest pages fetched first. */
export async function fetchAllMessages(conversationId: string): Promise<TMessage[]> {
  const pages: TMessage[][] = [];
  let before: string | undefined;
  for (let i = 0; i < MAX_PAGES; i++) {
    const page = await ipcBridge.database.getConversationMessages.invoke({
      conversation_id: conversationId,
      limit: PAGE_SIZE,
      before,
      content_mode: 'full',
    });
    pages.unshift(page.items ?? []);
    if (!page.has_more_before || !page.oldest_cursor) break;
    before = page.oldest_cursor;
  }
  return pages.flat();
}

export function useContinueInAgent(conversation: TChatConversation | undefined) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false);

  const continueIn = useCallback(
    async (target: HandoffTarget) => {
      if (!conversation || busyRef.current) return;
      busyRef.current = true;
      setBusy(true);
      try {
        const workspace = conversation.extra?.workspace;
        const source: HandoffSource = {
          id: conversation.id,
          name: conversation.name,
          agentName: conversation.assistant?.name ?? conversation.type,
          workspace,
        };
        const messages = await fetchAllMessages(conversation.id);
        const transcript = buildHandoffTranscript(source, messages);
        const transcriptPath = await ipcBridge.cockpit.writeHandoffTranscript.invoke({
          conversation_id: conversation.id,
          content: transcript,
        });

        const created = await ipcBridge.conversation.create.invoke({
          name: conversation.name,
          model: target.model,
          assistant: { id: target.assistantId, locale: i18n.language },
          extra: {
            workspace,
            custom_workspace: Boolean(workspace),
            default_files: [],
            // Read by the Lantern board to draw the handoff edge.
            handoff_from: conversation.id,
          } as Parameters<typeof ipcBridge.conversation.create.invoke>[0]['extra'],
        });
        if (!created?.id) throw new Error('create returned no conversation');

        const initialMessage = {
          input: buildHandoffPrompt(source, transcriptPath),
          files: [{ kind: 'local' as const, path: transcriptPath }],
        };
        const storageKey = target.backend === 'aionrs' ? 'aionrs_initial_message_' : 'acp_initial_message_';
        sessionStorage.setItem(`${storageKey}${created.id}`, JSON.stringify(initialMessage));

        emitter.emit('chat.history.refresh');
        Message.success(t('cockpit.handoff.started', { agent: target.label }));
        await navigate(`/conversation/${created.id}`);
      } catch (error) {
        console.error('Continue in another agent failed:', error);
        Message.error(t('cockpit.handoff.failed', { message: parseError(error) }));
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    },
    [conversation, i18n.language, navigate, t]
  );

  return { continueIn, busy };
}
