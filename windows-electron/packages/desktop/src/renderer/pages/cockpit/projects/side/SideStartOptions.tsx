/**
 * Model + effort and permission pickers under the side panel's first-message
 * composer, so a new side chat starts the way the New Chat page would.
 */

import AgentModeSelector from '@/renderer/components/agent/AgentModeSelector';
import GuidModelSelector from '@/renderer/pages/guid/components/GuidModelSelector';
import { iconColors } from '@/renderer/styles/colors';
import { Shield } from '@icon-park/react';
import React from 'react';
import { useTranslation } from 'react-i18next';
import type { useSideStartOptions } from './useSideStartOptions';

type Props = { options: ReturnType<typeof useSideStartOptions> };

const noop = async () => {};

const SideStartOptions: React.FC<Props> = ({ options }) => {
  const { t } = useTranslation();
  const { modelInfo, model, setModel, modes, mode, setMode, thoughtOption, setThought, backend } = options;
  if (!modelInfo && modes.length === 0 && !thoughtOption) return null;
  return (
    <div className='flex items-center gap-6px min-w-0 flex-wrap' data-testid='board-side-start-options'>
      {(modelInfo || thoughtOption) && (
        <GuidModelSelector
          isGeminiMode={false}
          modelList={[]}
          current_model={undefined}
          setCurrentModel={noop}
          currentAcpCachedModelInfo={modelInfo}
          selectedAcpModel={model}
          setSelectedAcpModel={(value) => setModel(typeof value === 'function' ? value(model) : value)}
          thoughtLevelOption={thoughtOption}
          onThoughtLevelSelect={setThought}
        />
      )}
      {modes.length > 0 && (
        <AgentModeSelector
          key={backend}
          backend={backend}
          compact
          initialMode={mode}
          onModeSelect={setMode}
          dynamicModes={modes}
          compactLeadingIcon={<Shield theme='outline' size='14' fill={iconColors.secondary} />}
          compactLabelPrefix={t('agentMode.permission')}
          modeLabelFormatter={(item) => t(`agentMode.${item.value}`, { defaultValue: item.label })}
        />
      )}
    </div>
  );
};

export default SideStartOptions;
