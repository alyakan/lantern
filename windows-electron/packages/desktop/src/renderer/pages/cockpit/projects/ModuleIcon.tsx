/**
 * Icon for a Lantern module (`icon` in .cockpit/project.json), drawn on a
 * tile tinted with the module's colour.
 */

import {
  BranchOne,
  Chip,
  CodeBrackets,
  Magic,
  CheckOne,
  Clear,
  Compass,
  Computer,
  Earth,
  Electrocardiogram,
  Link,
  Platte,
  Plus,
  Radar,
  Robot,
  ScanCode,
  Server,
  Tool,
} from '@icon-park/react';
import React from 'react';
import type { AgentKind } from './projectsGraph';

const ICONS: Record<string, React.ComponentType<{ size?: number; strokeWidth?: number }>> = {
  compass: Compass,
  palette: Platte,
  globe: Earth,
  radar: Radar,
  plus: Plus,
  branch: BranchOne,
  barcode: ScanCode,
  broom: Clear,
  link: Link,
  check: CheckOne,
  server: Server,
  pulse: Electrocardiogram,
  tool: Tool,
  pc: Computer,
};

/** `solid` fills the tile with the colour and draws the glyph in cream (HUD cards). */
const ModuleIcon: React.FC<{ icon?: string; color?: string; size?: number; solid?: boolean }> = ({
  icon,
  color,
  size = 30,
  solid,
}) => {
  const Icon = (icon && ICONS[icon]) || Robot;
  const tone = color ?? 'var(--bg-6)';
  return (
    <span
      className={
        solid
          ? 'inline-flex items-center justify-center shrink-0 rd-3px'
          : 'inline-flex items-center justify-center shrink-0 rd-8px'
      }
      style={
        solid
          ? {
              width: size,
              height: size,
              color: 'var(--hud-cream, #efe6cf)',
              background: `linear-gradient(145deg, ${tone}, color-mix(in srgb, ${tone} 70%, #000))`,
              boxShadow: `inset 0 1px 0 rgba(255, 255, 255, 0.25), 0 2px 6px color-mix(in srgb, ${tone} 45%, transparent)`,
            }
          : {
              width: size,
              height: size,
              color: tone,
              background: `color-mix(in srgb, ${tone} 14%, transparent)`,
              border: `1px solid color-mix(in srgb, ${tone} 30%, transparent)`,
            }
      }
    >
      <Icon size={Math.round(size * 0.55)} strokeWidth={3} />
    </span>
  );
};

const AGENT_ICONS: Record<AgentKind, React.ComponentType<{ size?: number; strokeWidth?: number }>> = {
  claude: Magic,
  codex: CodeBrackets,
  qwen: Chip,
  other: Robot,
};

/** HUD agent-type tile: a solid square in the agent's colour (Claude spark, Codex brackets, Qwen chip). */
export const AgentTile: React.FC<{ kind: AgentKind; size?: number }> = ({ kind, size = 22 }) => {
  const Icon = AGENT_ICONS[kind];
  return (
    <span
      className='inline-flex items-center justify-center shrink-0 rd-3px'
      style={{ width: size, height: size, background: `var(--agent-${kind})`, color: 'var(--hud-cream, #efe6cf)' }}
    >
      <Icon size={Math.round(size * 0.62)} strokeWidth={3} />
    </span>
  );
};

export default ModuleIcon;
