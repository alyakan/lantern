/**
 * Pulse: an always-on strip at the bottom of the sidebar. One glance shows how much of each plan is left,
 * whether the local model holds the GPU, and a one-click Game mode that gives the GPU back.
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Popover, Switch, Tooltip } from '@arco-design/web-react';
import { GameHandle, Refresh } from '@icon-park/react';
import classNames from 'classnames';
import type { PlanUsage, PulseSnapshot, PulseWindow } from '@/common/types/cockpitPulse';
import { exhaustAt, FIVE_HOURS, formatGb, formatVram, formatIn, formatWhen, levelOf, WEEK } from './pulseMath';
import { usePulse } from './usePulse';
import { useLanternStyle } from '@/renderer/utils/theme/lanternStyle';
import styles from './PulseStrip.module.css';

type Tone = 'claude' | 'codex' | 'qwen';

/** Two hairline bars in one block: the 5-hour window on top, the week below; the text names the tighter one. */
const DoubleBar: React.FC<{ usage?: PlanUsage }> = ({ usage }) => {
  const five = usage?.fiveHour?.usedPercent;
  const week = usage?.week?.usedPercent;
  const binding = (week ?? -1) >= (five ?? -1) ? { value: week, label: 'wk' } : { value: five, label: '5h' };
  const fill = (percent?: number) => (
    <span className={styles.track}>
      <span
        className={classNames(styles.fill, styles[levelOf(percent)])}
        style={{ transform: `scaleX(${(percent ?? 0) / 100})` }}
      />
    </span>
  );
  return (
    <span className={styles.meter}>
      <span className={styles.bars}>
        {fill(five)}
        {fill(week)}
      </span>
      <span className={styles.meterValue}>
        {binding.value === undefined ? '–' : `${Math.round(binding.value)}%`}
        <span className={styles.meterLabel}>{binding.value === undefined ? '' : binding.label}</span>
      </span>
    </span>
  );
};

const PlanDetails: React.FC<{ name: string; usage?: PlanUsage }> = ({ name, usage }) => {
  const { t } = useTranslation();
  const now = Date.now() / 1000;
  if (!usage) return <div className={styles.detail}>{t('cockpit.pulse.noReading', { name })}</div>;
  const rows: [string, PulseWindow | undefined, number][] = [
    [t('cockpit.pulse.fiveHour'), usage.fiveHour, FIVE_HOURS],
    [t('cockpit.pulse.week'), usage.week, WEEK],
  ];
  return (
    <div className={styles.detail}>
      <div className={styles.detailTitle}>
        {name}
        {usage.plan ? <span className={styles.chip}>{usage.plan}</span> : null}
      </div>
      {rows.map(([label, window, length]) => {
        if (!window) return null;
        const runsOut = exhaustAt(window, length, now);
        return (
          <div key={label} className={styles.detailRow}>
            <span>
              {label}: {Math.round(window.usedPercent)}%
            </span>
            {window.resetsAt ? (
              <span className={styles.muted}>{t('cockpit.pulse.resets', { when: formatWhen(window.resetsAt) })}</span>
            ) : null}
            {runsOut ? (
              <span className={styles.warnText}>
                {t('cockpit.pulse.runsOut', { when: formatWhen(runsOut), in: formatIn(runsOut - now) })}
              </span>
            ) : null}
          </div>
        );
      })}
      {usage.note ? <div className={styles.warnText}>{usage.note}</div> : null}
      <div className={styles.muted}>{t('cockpit.pulse.seen', { ago: formatIn(now - usage.seenAt) })}</div>
    </div>
  );
};

const PlanRow: React.FC<{ tone: Tone; name: string; usage?: PlanUsage }> = ({ tone, name, usage }) => (
  <Popover position='right' trigger='hover' content={<PlanDetails name={name} usage={usage} />}>
    <div className={styles.row}>
      <span className={classNames(styles.dot, styles[tone])} />
      <span className={styles.name}>{name}</span>
      <DoubleBar usage={usage} />
    </div>
  </Popover>
);

const QwenRow: React.FC<{
  pulse: PulseSnapshot;
  busy: boolean;
  onLoad: (model: string, loaded: boolean) => void;
}> = ({ pulse, busy, onLoad }) => {
  const { t } = useTranslation();
  const loaded = pulse.qwen.loaded[0];
  const model = loaded?.name ?? pulse.qwen.installed[0];
  let status: string;
  if (!pulse.qwen.running) status = t('cockpit.pulse.ollamaOff');
  else if (loaded) status = formatGb(loaded.vramBytes);
  else status = t('cockpit.pulse.idle');
  return (
    <div className={styles.row}>
      <span className={classNames(styles.dot, styles.qwen, loaded && styles.live)} />
      <span className={styles.name}>Qwen</span>
      <span className={styles.status}>{status}</span>
      {pulse.qwen.running && model && !pulse.gameMode ? (
        <Tooltip content={loaded ? t('cockpit.pulse.unloadHint') : t('cockpit.pulse.loadHint', { model })}>
          <Button
            size='mini'
            type='text'
            className={styles.action}
            disabled={busy}
            onClick={() => onLoad(model, !loaded)}
          >
            {loaded ? t('cockpit.pulse.unload') : t('cockpit.pulse.load')}
          </Button>
        </Tooltip>
      ) : null}
    </div>
  );
};

const TICKS = Array.from({ length: 11 }, (_, i) => {
  const a = Math.PI * (1 - i / 10);
  const inner = i % 5 ? 17 : 15;
  return {
    x1: 24 + 20 * Math.cos(a),
    y1: 24 - 20 * Math.sin(a),
    x2: 24 + inner * Math.cos(a),
    y2: 24 - inner * Math.sin(a),
  };
});
const RED_ZONE = `M${24 + 20 * Math.cos(Math.PI * 0.2)} ${24 - 20 * Math.sin(Math.PI * 0.2)} A20 20 0 0 1 44 24`;

/** HUD needle gauge for one window: the needle swings past and settles on the used share; red zone near the limit. */
const Gauge: React.FC<{ label: string; percent?: number }> = ({ label, percent }) => (
  <div className={styles.dialRow}>
    <svg width='48' height='28' className={styles.dial} aria-hidden='true'>
      {TICKS.map((tick, i) => (
        <line key={i} {...tick} className={styles.tick} />
      ))}
      <path d={RED_ZONE} className={styles.redZone} />
      <g className={styles.needle} style={{ ['--needle' as string]: `${((percent ?? 0) / 100) * 180}deg` }}>
        <line x1='24' y1='24' x2='6' y2='24' />
      </g>
      <circle cx='24' cy='24' r='2.5' className={styles.hub} />
    </svg>
    <div className='min-w-0'>
      <div className={classNames(styles.readout, styles[levelOf(percent)])}>
        {percent === undefined ? '–' : `${Math.round(percent)}%`}
      </div>
      <div className={styles.gaugeLabel}>{label}</div>
    </div>
  </div>
);

/** One plan: the 5-hour session dial and the weekly dial side by side. */
const Dial: React.FC<{ name: string; usage?: PlanUsage }> = ({ name, usage }) => {
  const { t } = useTranslation();
  return (
    <Popover position='right' trigger='hover' content={<PlanDetails name={name} usage={usage} />}>
      <div className={styles.dialGroup} data-testid={`pulse-dial-${name.toLowerCase()}`}>
        <div className={styles.hudLabel}>{name}</div>
        <div className={styles.dialPair}>
          <Gauge label={t('cockpit.pulse.fiveHour')} percent={usage?.fiveHour?.usedPercent} />
          <Gauge label={t('cockpit.pulse.week')} percent={usage?.week?.usedPercent} />
        </div>
      </div>
    </Popover>
  );
};

const SEGMENTS = 14;

const HudPulse: React.FC<{
  pulse: PulseSnapshot;
  busy: boolean;
  setGameMode: (on: boolean) => void;
  setModelLoaded: (model: string, loaded: boolean) => void;
}> = ({ pulse, busy, setGameMode, setModelLoaded }) => {
  const { t } = useTranslation();
  const gpu = pulse.gpu;
  const loaded = pulse.qwen.loaded[0];
  const model = loaded?.name ?? pulse.qwen.installed[0];
  const filled = gpu ? Math.round((gpu.vramUsedBytes / Math.max(1, gpu.vramTotalBytes)) * SEGMENTS) : 0;
  const qwenStatus = !pulse.qwen.running
    ? t('cockpit.pulse.ollamaOff')
    : loaded
      ? formatGb(loaded.vramBytes)
      : t('cockpit.pulse.idle');
  return (
    <section className={classNames(styles.strip, styles.hud)} aria-label={t('cockpit.pulse.title')}>
      <div className={styles.hudLabel}>{t('cockpit.pulse.usage')}</div>
      <Dial name='Claude' usage={pulse.claude} />
      <Dial name='Codex' usage={pulse.codex} />
      <div className={styles.hudSep} />
      <div className={styles.hudRow}>
        <span className='flex items-center gap-6px'>
          <span className='hud-lamp' data-state={loaded ? 'running' : 'idle'} />
          Qwen
        </span>
        {pulse.qwen.running && model && !pulse.gameMode ? (
          <Tooltip content={loaded ? t('cockpit.pulse.unloadHint') : t('cockpit.pulse.loadHint', { model })}>
            <Button
              size='mini'
              type='text'
              className={styles.action}
              disabled={busy}
              onClick={() => void setModelLoaded(model, !loaded)}
            >
              {qwenStatus}
            </Button>
          </Tooltip>
        ) : (
          <span className={styles.hudLabel}>{qwenStatus}</span>
        )}
      </div>
      <div className={styles.hudRow}>
        <span className={styles.hudLabel}>GPU</span>
        <span className={styles.hudValue}>
          {gpu ? formatVram(gpu.vramUsedBytes, gpu.vramTotalBytes) : t('cockpit.pulse.noGpu')}
        </span>
      </div>
      <div className={styles.segments} aria-hidden='true'>
        {Array.from({ length: SEGMENTS }, (_, i) => (
          <i
            key={i}
            className={classNames(i < filled && (i > 10 ? styles.segHot : styles.segOn))}
            style={{ ['--seg' as string]: i }}
          />
        ))}
      </div>
      <div className={classNames(styles.hudRow, styles.gameRow)}>
        <span>{t('cockpit.pulse.gameMode')}</span>
        <Tooltip content={pulse.gameMode ? t('cockpit.pulse.gameModeOn') : t('cockpit.pulse.gameModeOff')}>
          <Switch size='small' checked={pulse.gameMode} disabled={busy} onChange={(on) => void setGameMode(on)} />
        </Tooltip>
      </div>
    </section>
  );
};

const PulseStrip: React.FC<{ collapsed?: boolean }> = ({ collapsed }) => {
  const { t } = useTranslation();
  const { pulse, busy, refresh, setGameMode, setModelLoaded } = usePulse();
  const hud = useLanternStyle() === 'hud';
  if (!pulse) return null;

  const gpu = pulse.gpu;
  const qwenLoaded = pulse.qwen.loaded.length > 0;
  const gameRunning = (gpu?.otherLoad ?? 0) > 30;

  if (collapsed) {
    const worst = (u?: PlanUsage) => levelOf(Math.max(u?.fiveHour?.usedPercent ?? 0, u?.week?.usedPercent ?? 0));
    return (
      <div className={styles.collapsed}>
        <span className={classNames(styles.dot, styles.claude, styles[`ring_${worst(pulse.claude)}`])} />
        <span className={classNames(styles.dot, styles.codex, styles[`ring_${worst(pulse.codex)}`])} />
        <span className={classNames(styles.dot, styles.qwen, qwenLoaded && styles.live)} />
      </div>
    );
  }

  if (hud)
    return (
      <HudPulse
        pulse={pulse}
        busy={busy}
        setGameMode={(on) => void setGameMode(on)}
        setModelLoaded={(model, on) => void setModelLoaded(model, on)}
      />
    );

  return (
    <section className={styles.strip} aria-label={t('cockpit.pulse.title')}>
      <header className={styles.header}>
        <span>{t('cockpit.pulse.title')}</span>
        <Tooltip content={t('cockpit.pulse.refresh')}>
          <Button
            size='mini'
            type='text'
            className={styles.iconButton}
            loading={busy}
            icon={<Refresh size='12' />}
            onClick={() => void refresh()}
          />
        </Tooltip>
      </header>
      <PlanRow tone='claude' name='Claude' usage={pulse.claude} />
      <PlanRow tone='codex' name='Codex' usage={pulse.codex} />
      <QwenRow pulse={pulse} busy={busy} onLoad={(model, loaded) => void setModelLoaded(model, loaded)} />
      <div className={classNames(styles.row, styles.gpuRow)}>
        <span className={styles.name}>GPU</span>
        <span className={styles.status}>
          {gpu
            ? `${Math.round(gpu.load)}% · ${formatVram(gpu.vramUsedBytes, gpu.vramTotalBytes)}`
            : t('cockpit.pulse.noGpu')}
        </span>
        <Tooltip content={pulse.gameMode ? t('cockpit.pulse.gameModeOn') : t('cockpit.pulse.gameModeOff')}>
          <span className={styles.game}>
            <GameHandle size='13' />
            <Switch size='small' checked={pulse.gameMode} disabled={busy} onChange={(on) => void setGameMode(on)} />
          </span>
        </Tooltip>
      </div>
      {gameRunning && qwenLoaded && !pulse.gameMode ? (
        <div className={styles.nudge}>
          <span>{t('cockpit.pulse.gameNudge')}</span>
          <Button size='mini' type='primary' disabled={busy} onClick={() => void setGameMode(true)}>
            {t('cockpit.pulse.freeGpu')}
          </Button>
        </div>
      ) : null}
    </section>
  );
};

export default PulseStrip;
