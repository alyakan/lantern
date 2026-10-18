/**
 * Ctrl+K (Cmd+K on Mac): jump to any project, module or chat, or run an
 * action. Arrow keys move, Enter opens, Esc closes.
 */

import { ipcBridge } from '@/common';
import { useConversationHistoryContext } from '@/renderer/hooks/context/ConversationHistoryContext';
import { useThemeContext } from '@/renderer/hooks/context/ThemeContext';
import { getLanternStyle, setLanternStyle } from '@/renderer/utils/theme/lanternStyle';
import { Input, Modal } from '@arco-design/web-react';
import { Command, Comment, FolderOpen, Lightning, Robot } from '@icon-park/react';
import classNames from 'classnames';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import useSWR from 'swr';
import styles from './CommandPalette.module.css';
import { buildPaletteItems, filterPalette, type PaletteGroup, type PaletteItem } from './paletteItems';

const GROUP_ICON: Record<PaletteGroup, React.ReactNode> = {
  action: <Lightning size={14} />,
  project: <FolderOpen size={14} />,
  module: <Robot size={14} />,
  chat: <Comment size={14} />,
};

const isPaletteKey = (event: KeyboardEvent) =>
  (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'k';

const CommandPalette: React.FC = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { theme, setTheme } = useThemeContext();
  const { conversations } = useConversationHistoryContext();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!isPaletteKey(event)) return;
      event.preventDefault();
      setOpen((value) => !value);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  const { data: listing } = useSWR(open ? 'cockpit.projects' : null, () => ipcBridge.cockpit.listProjects.invoke());

  const actions = useMemo<PaletteItem[]>(
    () => [
      { id: 'a:new', group: 'action', title: t('cockpit.palette.newChat'), route: '/guid' },
      { id: 'a:board', group: 'action', title: t('cockpit.palette.board'), route: '/board' },
      { id: 'a:chats', group: 'action', title: t('cockpit.palette.boardChats'), route: '/board?view=chats' },
      { id: 'a:scheduled', group: 'action', title: t('cockpit.palette.scheduled'), route: '/scheduled' },
      { id: 'a:appearance', group: 'action', title: t('cockpit.palette.appearance'), route: '/settings/appearance' },
      {
        id: 'a:dark',
        group: 'action',
        title: theme === 'dark' ? t('cockpit.palette.light') : t('cockpit.palette.dark'),
        keywords: 'theme night day',
        action: 'toggleDark',
      },
      {
        id: 'a:style',
        group: 'action',
        title: getLanternStyle() === 'hud' ? t('cockpit.palette.styleClassic') : t('cockpit.palette.styleHud'),
        keywords: 'theme style look',
        action: 'toggleStyle',
      },
    ],
    // getLanternStyle is read when the palette opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [t, theme, open]
  );

  const items = useMemo(
    () =>
      buildPaletteItems({
        projects: listing?.projects ?? [],
        chats: conversations.map((chat) => ({
          id: chat.id,
          name: chat.name,
          workspace: (chat.extra as { workspace?: string } | undefined)?.workspace,
          modifiedAt: chat.modified_at,
        })),
        actions,
      }),
    [listing, conversations, actions]
  );
  const results = useMemo(() => filterPalette(items, query), [items, query]);

  useEffect(() => setActive(0), [query, open]);
  useEffect(() => {
    if (!open) setQuery('');
  }, [open]);
  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const run = useCallback(
    (item: PaletteItem | undefined) => {
      if (!item) return;
      setOpen(false);
      if (item.action === 'toggleDark') void setTheme(theme === 'dark' ? 'light' : 'dark');
      else if (item.action === 'toggleStyle') void setLanternStyle(getLanternStyle() === 'hud' ? 'classic' : 'hud');
      else if (item.route) void navigate(item.route);
    },
    [navigate, setTheme, theme]
  );

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive((index) => Math.min(index + 1, results.length - 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((index) => Math.max(index - 1, 0));
    } else if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
      event.preventDefault();
      run(results[active]);
    }
  };

  return (
    <Modal
      visible={open}
      onCancel={() => setOpen(false)}
      footer={null}
      closable={false}
      alignCenter={false}
      unmountOnExit
      className={styles.palette}
      wrapClassName={styles.wrap}
      maskStyle={{ background: 'rgba(0, 0, 0, 0.35)' }}
    >
      <div onKeyDown={onKeyDown} data-testid='command-palette'>
        <Input
          autoFocus
          size='large'
          value={query}
          onChange={setQuery}
          prefix={<Command size={16} />}
          placeholder={t('cockpit.palette.placeholder')}
          className={styles.input}
          data-testid='command-palette-input'
        />
        <div ref={listRef} className={styles.list} role='listbox'>
          {results.length === 0 && <div className={styles.empty}>{t('cockpit.palette.empty')}</div>}
          {results.map((item, index) => (
            <div
              key={item.id}
              data-index={index}
              role='option'
              aria-selected={index === active}
              className={classNames(styles.item, index === active && styles.active)}
              onMouseMove={() => setActive(index)}
              onClick={() => run(item)}
            >
              <span className={styles.icon}>{GROUP_ICON[item.group]}</span>
              <span className={styles.title}>{item.title}</span>
              {item.meta && <span className={styles.meta}>{item.meta}</span>}
              <span className={styles.group}>{t(`cockpit.palette.group.${item.group}`)}</span>
            </div>
          ))}
        </div>
        <div className={styles.footer}>{t('cockpit.palette.hint')}</div>
      </div>
    </Modal>
  );
};

export default CommandPalette;
