/**
 * One chat ("module") on the Lantern board, drawn as an agent console card:
 * agent-coloured border and dot, agent name, status pill, chat title.
 * Memoised: React Flow re-renders it only when its data object changes, and
 * BoardPage keeps that object stable unless the card's content changes.
 */

import ThemedLogo from '@/renderer/components/agent/ThemedLogo';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import classNames from 'classnames';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { agentTone, type BoardModule } from './boardGraph';
import styles from './BoardPage.module.css';

export type ModuleNodeData = BoardModule & { agentAvatarIsEmoji?: boolean };

const ModuleNode: React.FC<NodeProps> = ({ data, selected, dragging }) => {
  const { t } = useTranslation();
  const module = data as unknown as ModuleNodeData;
  const tone = agentTone(module);
  return (
    <div
      className={classNames(
        styles.node,
        styles[`tone_${tone}`],
        styles[`status_${module.status}`],
        selected && styles.nodeSelected,
        dragging && styles.nodeDragging
      )}
      data-testid={`board-node-${module.id}`}
    >
      <Handle type='target' position={Position.Top} className={styles.handle} />
      <div className={styles.nodeHeader}>
        <span className={styles.dot} />
        {module.agentAvatar && module.agentAvatarIsEmoji ? (
          <span className='text-13px leading-none shrink-0'>{module.agentAvatar}</span>
        ) : module.agentAvatar ? (
          <ThemedLogo src={module.agentAvatar} alt='' className='w-14px h-14px shrink-0 rounded-50%' />
        ) : null}
        <span className={styles.agentName}>{module.agentName}</span>
        <span className={styles.pill}>{t(`cockpit.board.status.${module.status}`)}</span>
      </div>
      <div className={styles.nodeTitle}>{module.name}</div>
      <Handle type='source' position={Position.Bottom} className={styles.handle} />
    </div>
  );
};

export default React.memo(ModuleNode);
