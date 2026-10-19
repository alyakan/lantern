/**
 * Dispatcher bar: under the composer, recommends who should do the task and why, with a runner-up.
 * Nezar picks the goal (Auto, Thrifty, Balanced, Best, Fast) and confirms or overrides.
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Radio, Tooltip } from '@arco-design/web-react';
import { CheckSmall } from '@icon-park/react';
import classNames from 'classnames';
import type { HandoffTarget } from '../handoff/handoffTargets';
import type { Goal, Ranked, Reason } from './dispatch';
import { useDispatcher } from './useDispatcher';
import styles from './DispatcherBar.module.css';

const GOALS: Goal[] = ['auto', 'thrifty', 'balanced', 'best', 'fast'];

type Props = {
  text: string;
  targets: HandoffTarget[];
  /** Key of the target that is selected now, if any. */
  selectedKey?: string;
  where: 'home' | 'continue';
  onUse: (target: HandoffTarget) => void;
};

const Option: React.FC<{
  ranked: Ranked;
  primary: boolean;
  selected: boolean;
  onUse: () => void;
}> = ({ ranked, primary, selected, onUse }) => {
  const { t } = useTranslation();
  const say = (reason: Reason) => t(`cockpit.dispatch.reason.${reason.key}`, reason.values);
  const reasons = ranked.reasons.slice(0, primary ? 3 : 2).map(say);
  return (
    <div className={classNames(styles.option, primary && styles.primary)}>
      <span className={classNames(styles.dot, styles[ranked.candidate.tone])} />
      <div className={styles.body}>
        <div className={styles.label}>
          {ranked.candidate.label}
          {primary ? <span className={styles.badge}>{t('cockpit.dispatch.pick')}</span> : null}
        </div>
        <div className={styles.reasons}>{reasons.join(' · ')}</div>
      </div>
      {selected ? (
        <span className={styles.selected}>
          <CheckSmall size='14' />
          {t('cockpit.dispatch.inUse')}
        </span>
      ) : (
        <Button size='mini' type={primary ? 'primary' : 'secondary'} onClick={onUse}>
          {primary ? t('cockpit.dispatch.use') : t('cockpit.dispatch.useInstead')}
        </Button>
      )}
    </div>
  );
};

const DispatcherBar: React.FC<Props> = ({ text, targets, selectedKey, where, onUse }) => {
  const { t } = useTranslation();
  const { result, goal, setGoal, record } = useDispatcher(text, targets, where);
  if (!result || !result.ranked.length) return null;

  const [first, second] = result.ranked;
  const use = (ranked: Ranked) => {
    const target = targets.find((item) => item.key === ranked.candidate.key);
    if (!target) return;
    void record(ranked);
    onUse(target);
  };

  return (
    <section className={styles.bar} aria-label={t('cockpit.dispatch.title')}>
      <header className={styles.header}>
        <span className={styles.title}>{t('cockpit.dispatch.title')}</span>
        <span className={styles.kind}>
          {t('cockpit.dispatch.looksLike', { kind: t(`cockpit.dispatch.kind.${result.kind}`) })}
          {goal === 'auto' ? <span className={styles.auto}> · {t(`cockpit.dispatch.goal.${result.goal}`)}</span> : null}
        </span>
        <Radio.Group
          type='button'
          size='mini'
          value={goal}
          onChange={(value: Goal) => setGoal(value)}
          className={styles.goals}
        >
          {GOALS.map((value) => (
            <Tooltip key={value} content={t(`cockpit.dispatch.goalHint.${value}`)}>
              <Radio value={value}>{t(`cockpit.dispatch.goal.${value}`)}</Radio>
            </Tooltip>
          ))}
        </Radio.Group>
      </header>
      <Option ranked={first} primary selected={first.candidate.key === selectedKey} onUse={() => use(first)} />
      {second ? (
        <Option
          ranked={second}
          primary={false}
          selected={second.candidate.key === selectedKey}
          onUse={() => use(second)}
        />
      ) : null}
    </section>
  );
};

export default DispatcherBar;
