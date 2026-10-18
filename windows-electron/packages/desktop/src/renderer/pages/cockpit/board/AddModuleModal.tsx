/**
 * "Add module": start a new chat with any agent in the board's project,
 * optionally linked under the selected card.
 */

import { ipcBridge } from '@/common';
import type { Assistant } from '@/common/types/agent/assistantTypes';
import { parseError } from '@/common/utils';
import { useProvidersQuery } from '@/renderer/hooks/agent/useModelProviderList';
import { emitter } from '@/renderer/utils/emitter';
import { Form, Input, Message, Modal, Select } from '@arco-design/web-react';
import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import useSWR from 'swr';
import { buildHandoffTargets } from '../handoff/handoffTargets';
import type { BoardModule } from './boardGraph';

type Props = {
  visible: boolean;
  project: string;
  modules: BoardModule[];
  defaultParentId?: string;
  onClose: () => void;
  onCreated: () => void;
};

const NO_PARENT = '__none__';

const AddModuleModal: React.FC<Props> = ({ visible, project, modules, defaultParentId, onClose, onCreated }) => {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const { data: assistants } = useSWR('assistants.list', () =>
    ipcBridge.assistants.list.invoke().catch(() => [] as Assistant[])
  );
  const { data: providers } = useProvidersQuery();
  const targets = useMemo(() => buildHandoffTargets(assistants ?? [], providers ?? []), [assistants, providers]);
  const [targetKey, setTargetKey] = useState<string>();
  const [name, setName] = useState('');
  const [message, setMessage] = useState('');
  const [parentId, setParentId] = useState(NO_PARENT);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (visible) {
      setName('');
      setMessage('');
      setParentId(defaultParentId ?? NO_PARENT);
    }
  }, [visible, defaultParentId]);

  useEffect(() => {
    if (!targetKey && targets.length) setTargetKey(targets[0].key);
  }, [targetKey, targets]);

  const create = async () => {
    const target = targets.find((item) => item.key === targetKey);
    if (!target) return;
    setBusy(true);
    try {
      const created = await ipcBridge.conversation.create.invoke({
        name: name.trim() || message.trim().slice(0, 40) || t('cockpit.board.newModuleName', { agent: target.label }),
        model: target.model,
        assistant: { id: target.assistantId, locale: i18n.language },
        extra: {
          workspace: project,
          custom_workspace: true,
          default_files: [],
          // Draws the "module" edge on the board.
          board_parent: parentId === NO_PARENT ? undefined : parentId,
        } as Parameters<typeof ipcBridge.conversation.create.invoke>[0]['extra'],
      });
      if (!created?.id) throw new Error('create returned no conversation');
      emitter.emit('chat.history.refresh');
      onCreated();
      onClose();
      if (message.trim()) {
        const storageKey = target.backend === 'aionrs' ? 'aionrs_initial_message_' : 'acp_initial_message_';
        sessionStorage.setItem(`${storageKey}${created.id}`, JSON.stringify({ input: message.trim(), files: [] }));
        await navigate(`/conversation/${created.id}`);
      } else {
        Message.success(t('cockpit.board.moduleAdded', { agent: target.label }));
      }
    } catch (error) {
      Message.error(t('cockpit.board.addFailed', { message: parseError(error) }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={t('cockpit.board.addModule')}
      visible={visible}
      onCancel={onClose}
      onOk={create}
      okText={t('cockpit.board.create')}
      cancelText={t('cockpit.remote.cancel')}
      confirmLoading={busy}
      okButtonProps={{ disabled: !targetKey }}
      unmountOnExit
    >
      <Form layout='vertical' size='small'>
        <Form.Item label={t('cockpit.board.agent')}>
          <Select value={targetKey} onChange={setTargetKey}>
            {targets.map((target) => (
              <Select.Option key={target.key} value={target.key}>
                <span className='flex items-center gap-8px'>
                  {target.avatar && <img src={target.avatar} alt='' className='w-14px h-14px' />}
                  {target.label}
                </span>
              </Select.Option>
            ))}
          </Select>
        </Form.Item>
        <Form.Item label={t('cockpit.board.moduleName')}>
          <Input value={name} onChange={setName} placeholder={t('cockpit.board.moduleNamePlaceholder')} />
        </Form.Item>
        <Form.Item label={t('cockpit.board.firstMessage')}>
          <Input.TextArea
            value={message}
            onChange={setMessage}
            autoSize={{ minRows: 3, maxRows: 8 }}
            placeholder={t('cockpit.board.firstMessagePlaceholder')}
          />
        </Form.Item>
        <Form.Item label={t('cockpit.board.linkUnder')}>
          <Select value={parentId} onChange={setParentId} showSearch>
            <Select.Option value={NO_PARENT}>{t('cockpit.board.noLink')}</Select.Option>
            {modules.map((item) => (
              <Select.Option key={item.id} value={item.id}>
                {item.name}
              </Select.Option>
            ))}
          </Select>
        </Form.Item>
      </Form>
      <div className='text-12px text-t-secondary'>{t('cockpit.board.projectHint', { project })}</div>
    </Modal>
  );
};

export default AddModuleModal;
