/**
 * Top of the side panel for a module or project: what it does, where it
 * runs, its tools, services and links, and its context files rendered
 * (module notes first). Collapsible so the chat below gets the room.
 */

import { ipcBridge } from '@/common';
import type { LanternModule, LanternProject } from '@/common/types/cockpitProjects';
import MarkdownView from '@/renderer/components/Markdown';
import { Spin } from '@arco-design/web-react';
import { Down, Right } from '@icon-park/react';
import classNames from 'classnames';
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import useSWR from 'swr';
import styles from './ProjectsBoard.module.css';
import type { BoardTarget } from './projectsGraph';
import { useDragSize } from './useDragSize';

type Props = {
  project: LanternProject;
  module?: LanternModule;
  /** Collapse by default once the chat has started. */
  hasChat: boolean;
  onSelect: (target: BoardTarget) => void;
};

const fileName = (file: string) => file.split(/[\\/]/).slice(-2).join('/');

const ModuleDetails: React.FC<Props> = ({ project, module, hasChat, onSelect }) => {
  const { t } = useTranslation();
  const files = [module?.context, ...project.contextFiles].filter((file): file is string => Boolean(file));
  const [open, setOpen] = useState(!hasChat);
  const [file, setFile] = useState(files[0]);
  const id = module?.id ?? project.dir;
  useEffect(() => {
    setOpen(!hasChat);
    setFile(files[0]);
    // Reset only when the selection changes, not on every chat-state refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const { data, isLoading } = useSWR(open && file ? ['cockpit.context', file] : null, () =>
    ipcBridge.cockpit.readContextFile.invoke({ file: file! })
  );
  // Drag the bottom edge to split details and chat; the height is kept across selections.
  const split: ReturnType<typeof useDragSize<HTMLDivElement>> = useDragSize<HTMLDivElement>({
    storageKey: '__lantern_details_h',
    initial: 240,
    min: 90,
    max: (): number => (split.targetRef.current?.parentElement?.clientHeight ?? 600) * 0.75,
    axis: 'y',
  });
  const byId = new Map(project.modules.map((item) => [item.id, item]));
  const linkedFrom = project.modules.filter((item) => module && item.links?.includes(module.id));
  const summary = module?.summary ?? project.summary;

  return (
    <div
      ref={split.targetRef}
      className={classNames(styles.details, open && styles.detailsOpen)}
      style={open ? { height: split.size } : undefined}
      data-testid='board-module-details'
    >
      <div className={styles.detailsToggle} onClick={() => setOpen((value) => !value)} role='presentation'>
        {open ? <Down size={12} /> : <Right size={12} />}
        <span>{t('cockpit.details.title')}</span>
        {!open && summary && <span className={styles.detailsPeek}>{summary}</span>}
      </div>
      {open && (
        <div className={styles.detailsBody}>
          {summary && <div className={styles.detailsSummary}>{summary}</div>}
          <dl className={styles.facts}>
            {module && (
              <>
                <dt>{t('cockpit.details.kind')}</dt>
                <dd>{t(`cockpit.projects.kind.${module.kind}`)}</dd>
                <dt>{t('cockpit.details.runsOn')}</dt>
                <dd>{module.runsOn ?? 'pc'}</dd>
                {module.llm && (
                  <>
                    <dt>{t('cockpit.details.model')}</dt>
                    <dd>{module.llm}</dd>
                  </>
                )}
                <dt>{t('cockpit.details.folder')}</dt>
                <dd className={styles.mono}>{module.folder}</dd>
              </>
            )}
            {(module?.tools ?? []).length > 0 && (
              <>
                <dt>{t('cockpit.details.tools')}</dt>
                <dd className={styles.chipRow}>
                  {module!.tools!.map((tool) => (
                    <span key={tool} className={styles.chip}>
                      {tool}
                    </span>
                  ))}
                </dd>
              </>
            )}
            {(module?.services ?? []).length > 0 && (
              <>
                <dt>{t('cockpit.details.services')}</dt>
                <dd className={styles.chipRow}>
                  {module!.services!.map((label) => (
                    <span key={label} className={styles.chip}>
                      {label}
                    </span>
                  ))}
                </dd>
              </>
            )}
            {module && ((module.links ?? []).length > 0 || linkedFrom.length > 0) && (
              <>
                <dt>{t('cockpit.details.links')}</dt>
                <dd className={styles.chipRow}>
                  {[...linkedFrom, ...(module.links ?? []).map((link) => byId.get(link))]
                    .filter((item): item is LanternModule => Boolean(item) && item!.id !== module.id)
                    .filter((item, index, all) => all.findIndex((other) => other.id === item.id) === index)
                    .map((item) => (
                      <span
                        key={item.id}
                        role='button'
                        tabIndex={0}
                        className={classNames(styles.chip, styles.chipLink)}
                        style={{ ['--tone' as string]: item.color ?? 'var(--bg-6)' }}
                        onClick={() => onSelect({ kind: 'module', project, module: item })}
                        onKeyDown={(event) =>
                          event.key === 'Enter' && onSelect({ kind: 'module', project, module: item })
                        }
                      >
                        <span className={styles.chipDot} />
                        {item.name}
                      </span>
                    ))}
                </dd>
              </>
            )}
          </dl>
          {files.length > 0 && (
            <>
              <div className={styles.fileTabs}>
                {files.map((item) => (
                  <span
                    key={item}
                    role='button'
                    tabIndex={0}
                    title={item}
                    className={classNames(styles.chip, item === file && styles.chipActive)}
                    onClick={() => setFile(item)}
                    onKeyDown={(event) => event.key === 'Enter' && setFile(item)}
                  >
                    {fileName(item)}
                  </span>
                ))}
              </div>
              <div className={styles.notes} data-testid='board-module-notes'>
                {isLoading ? (
                  <Spin size={16} />
                ) : data?.content ? (
                  <MarkdownView hiddenCodeCopyButton>{data.content}</MarkdownView>
                ) : (
                  <span className={styles.sideHint}>{data?.error ?? t('cockpit.details.noNotes')}</span>
                )}
              </div>
            </>
          )}
          {files.length === 0 && <div className={styles.sideHint}>{t('cockpit.details.noNotes')}</div>}
        </div>
      )}
      {open && (
        <div
          className={styles.splitterY}
          onPointerDown={split.onPointerDown}
          role='separator'
          aria-orientation='horizontal'
          aria-label={t('cockpit.side.resize')}
          data-testid='board-details-splitter'
        />
      )}
    </div>
  );
};

export default ModuleDetails;
