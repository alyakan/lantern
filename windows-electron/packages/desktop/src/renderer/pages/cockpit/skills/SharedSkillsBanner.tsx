/**
 * Settings → Skills: explains the shared skills folder that every agent gets.
 */

import { ipcBridge } from '@/common';
import { Alert, Button } from '@arco-design/web-react';
import { FolderOpen } from '@icon-park/react';
import React from 'react';
import { useTranslation } from 'react-i18next';
import useSWR from 'swr';

const SharedSkillsBanner: React.FC = () => {
  const { t } = useTranslation();
  const { data } = useSWR('cockpit.sharedSkillsDir', () => ipcBridge.cockpit.getSharedSkillsDir.invoke());
  if (!data) return null;

  return (
    <Alert
      type='info'
      data-testid='cockpit-shared-skills-banner'
      title={t('cockpit.sharedSkills.title')}
      content={
        <div className='flex flex-col gap-4px'>
          <span>{t('cockpit.sharedSkills.description')}</span>
          <span className='font-mono text-12px text-t-secondary break-all'>{data.path}</span>
          <span className='text-12px text-t-secondary'>
            {data.skills.length
              ? t('cockpit.sharedSkills.count', { count: data.skills.length, names: data.skills.join(', ') })
              : t('cockpit.sharedSkills.empty')}
          </span>
        </div>
      }
      action={
        <Button
          size='small'
          icon={<FolderOpen theme='outline' size='14' />}
          onClick={() => void ipcBridge.shell.openFolderWith.invoke({ folder_path: data.path, tool: 'explorer' })}
        >
          {t('cockpit.sharedSkills.open')}
        </Button>
      }
    />
  );
};

export default SharedSkillsBanner;
