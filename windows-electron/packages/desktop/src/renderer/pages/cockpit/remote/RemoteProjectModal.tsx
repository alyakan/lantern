/**
 * "Open remote project (SSH)": pick a folder on a remote host and turn it into
 * a local marker workspace that the "Claude Code · Mac mini" agent runs in.
 */

import { ipcBridge } from '@/common';
import { Alert, Button, Form, Input, Message, Modal, Spin } from '@arco-design/web-react';
import { FolderOpen, Left } from '@icon-park/react';
import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

type RemoteHost = { host: string; user: string; key: string };

const STORAGE_KEY = 'cockpit.remoteProject.lastHost';

function loadLastHost(): RemoteHost {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return { host: '', user: '', key: '', ...(JSON.parse(raw) as Partial<RemoteHost>) };
  } catch {
    // Storage may be unavailable; start empty.
  }
  return { host: '', user: '', key: '' };
}

function saveLastHost(host: RemoteHost): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(host));
  } catch {
    // Not critical.
  }
}

/** Parent of a POSIX path ("/a/b" -> "/a"). */
export function remoteParent(dir: string): string {
  const trimmed = dir.replace(/\/+$/, '');
  const index = trimmed.lastIndexOf('/');
  return index <= 0 ? '/' : trimmed.slice(0, index);
}

type Props = {
  visible: boolean;
  onClose: () => void;
  onOpened: (workspace: string) => void;
};

const RemoteProjectModal: React.FC<Props> = ({ visible, onClose, onOpened }) => {
  const { t } = useTranslation();
  const [host, setHost] = useState<RemoteHost>(loadLastHost);
  const [remotePath, setRemotePath] = useState('');
  const [listing, setListing] = useState<{ path: string; dirs: string[] }>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [opening, setOpening] = useState(false);

  useEffect(() => {
    if (!visible) {
      setListing(undefined);
      setError(undefined);
    }
  }, [visible]);

  const browse = useCallback(
    async (dir: string) => {
      setLoading(true);
      setError(undefined);
      const result = await ipcBridge.cockpit.listRemoteDir.invoke({ ...host, key: host.key || undefined, dir });
      setLoading(false);
      if (result.error) {
        setError(result.error);
        return;
      }
      setListing(result);
      setRemotePath(result.path);
      saveLastHost(host);
    },
    [host]
  );

  const open = useCallback(async () => {
    setOpening(true);
    setError(undefined);
    const result = await ipcBridge.cockpit.openRemoteProject.invoke({
      ...host,
      key: host.key || undefined,
      remotePath,
    });
    setOpening(false);
    if (result.error || !result.workspace) {
      setError(result.error ?? t('cockpit.remote.failed'));
      return;
    }
    saveLastHost(host);
    Message.success(t('cockpit.remote.opened'));
    onOpened(result.workspace);
    onClose();
  }, [host, remotePath, onOpened, onClose, t]);

  const canConnect = Boolean(host.host.trim() && host.user.trim());

  return (
    <Modal
      title={t('cockpit.remote.title')}
      visible={visible}
      onCancel={onClose}
      unmountOnExit
      footer={
        <>
          <Button onClick={onClose}>{t('cockpit.remote.cancel')}</Button>
          <Button type='primary' loading={opening} disabled={!canConnect || !remotePath.startsWith('/')} onClick={open}>
            {t('cockpit.remote.open')}
          </Button>
        </>
      }
    >
      <div className='text-12px text-t-secondary mb-12px'>{t('cockpit.remote.description')}</div>
      <Form layout='vertical' size='small'>
        <div className='flex gap-8px'>
          <Form.Item label={t('cockpit.remote.host')} className='flex-1'>
            <Input
              value={host.host}
              placeholder='my-mac.local'
              onChange={(value) => setHost((prev) => ({ ...prev, host: value.trim() }))}
            />
          </Form.Item>
          <Form.Item label={t('cockpit.remote.user')} className='flex-1'>
            <Input value={host.user} onChange={(value) => setHost((prev) => ({ ...prev, user: value.trim() }))} />
          </Form.Item>
        </div>
        <Form.Item label={t('cockpit.remote.key')}>
          <Input
            value={host.key}
            placeholder={t('cockpit.remote.keyPlaceholder')}
            onChange={(value) => setHost((prev) => ({ ...prev, key: value }))}
          />
        </Form.Item>
        <Form.Item label={t('cockpit.remote.folder')}>
          <div className='flex gap-8px'>
            <Input value={remotePath} placeholder='/Users/me/project' onChange={setRemotePath} />
            <Button icon={<FolderOpen />} disabled={!canConnect} loading={loading} onClick={() => browse(remotePath)}>
              {t('cockpit.remote.browse')}
            </Button>
          </div>
        </Form.Item>
      </Form>
      {error && <Alert type='error' content={error} className='mb-8px' />}
      {listing && (
        <Spin loading={loading} className='w-full'>
          <div className='border-1 border-solid border-3 rd-6px py-4px max-h-220px overflow-auto'>
            <Button
              type='text'
              size='mini'
              long
              icon={<Left />}
              className='!justify-start'
              onClick={() => browse(remoteParent(listing.path))}
            >
              {t('cockpit.remote.up')}
            </Button>
            {listing.dirs.map((name) => (
              <Button
                key={name}
                type='text'
                size='mini'
                long
                className='!justify-start'
                onClick={() => browse(`${listing.path.replace(/\/+$/, '')}/${name}`)}
              >
                {name}
              </Button>
            ))}
          </div>
        </Spin>
      )}
    </Modal>
  );
};

export default RemoteProjectModal;
