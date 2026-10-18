/**
 * Today: what needs Nezar right now across every project, and a small daily practice (intention, evening
 * check-in, weekly review with the private local coach). Sits under the home composer.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Button, Input, Message, Tooltip } from '@arco-design/web-react';
import { CheckOne, Down, Right } from '@icon-park/react';
import classNames from 'classnames';
import useSWR from 'swr';
import { ipcBridge } from '@/common';
import type { JournalDay, JournalState } from '@/common/types/cockpitLife';
import { parseError } from '@/common/utils';
import { useConversationHistoryContext } from '@/renderer/hooks/context/ConversationHistoryContext';
import { emitter } from '@/renderer/utils/emitter';
import type { HandoffTarget } from '../handoff/handoffTargets';
import { usePulse } from '../pulse/usePulse';
import { localDate, needsYouItems, type NeedsItem } from './todayItems';
import styles from './TodayPanel.module.css';

const NeedsYou: React.FC = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { conversations, isConversationWaitingConfirmation } = useConversationHistoryContext();
  const { data: listing } = useSWR('cockpit.projects', () => ipcBridge.cockpit.listProjects.invoke());
  const projects = listing?.projects ?? [];
  const dirs = useMemo(() => projects.flatMap((p) => [p.dir, ...p.members]), [projects]);
  const prefixes = useMemo(() => [...new Set(projects.flatMap((p) => p.servicePrefixes))], [projects]);
  const { data: git } = useSWR(dirs.length ? ['cockpit.git', dirs] : null, () =>
    ipcBridge.cockpit.gitStatus.invoke({ dirs })
  );
  const { data: mac } = useSWR(prefixes.length ? ['cockpit.mac', prefixes] : null, () =>
    ipcBridge.cockpit.macServices.invoke({ prefixes })
  );

  const items = needsYouItems({
    waiting: conversations
      .filter((c) => isConversationWaitingConfirmation(c.id))
      .map((c) => ({ id: c.id, name: c.name })),
    git: Object.values(git ?? {}).filter((g): g is NonNullable<typeof g> => Boolean(g)),
    services: mac?.services ?? [],
    macError: mac?.error,
  });

  const open = (item: NeedsItem) => {
    if (item.conversationId) void navigate(`/conversation/${item.conversationId}`);
    else void navigate('/board');
  };

  return (
    <section className={styles.card}>
      <header className={styles.cardHeader}>
        <span>{t('cockpit.today.needsYou')}</span>
        {items.length ? <span className={styles.count}>{items.length}</span> : null}
      </header>
      {items.length === 0 ? (
        <div className={styles.clear}>
          <CheckOne size='14' />
          {t('cockpit.today.allClear')}
        </div>
      ) : (
        <ul className={styles.list}>
          {items.slice(0, 6).map((item) => (
            <li key={item.key}>
              <Button type='text' long className={styles.item} onClick={() => open(item)}>
                <span className={classNames(styles.sev, styles[item.severity])} />
                <span className={styles.itemText}>{t(`cockpit.today.item.${item.kind}`, item.values)}</span>
                <Right size='12' className={styles.chev} />
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
};

const WEEKLY_REVIEW_PROMPT =
  'Weekly review. Read the journal entries in journal/ from the last 7 days and .cockpit/modules/coach.md. ' +
  "Also run `git log --since='7 days ago' --oneline` in each folder under C:\\Users\\Nezar\\Projects to see what I shipped. " +
  'Notice patterns in my energy, wins and drains, ask me one or two good questions, then help me set three ' +
  'intentions for next week. Keep it warm and brief. These notes are private: do not copy them anywhere.';

const Life: React.FC<{ targets: HandoffTarget[] }> = ({ targets }) => {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const { pulse } = usePulse();
  const today = localDate(new Date());
  const { data, mutate } = useSWR<JournalState>(['cockpit.journal', today], () =>
    ipcBridge.cockpit.getJournal.invoke({ date: today })
  );
  const [draft, setDraft] = useState<JournalDay>({ date: today });
  const [evening, setEvening] = useState(() => new Date().getHours() >= 17);
  const [busy, setBusy] = useState(false);

  // Load the saved day once; after that the form is the source of truth, so a save that finishes
  // while Nezar is typing in another field never overwrites what he typed.
  const loadedFor = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!data || loadedFor.current === data.day.date) return;
    loadedFor.current = data.day.date;
    setDraft(data.day);
  }, [data]);

  const save = async (fields: Partial<JournalDay>) => {
    try {
      await mutate(await ipcBridge.cockpit.saveJournal.invoke({ ...fields, date: today }), { revalidate: false });
    } catch (error) {
      Message.error(parseError(error));
    }
  };

  const coach = targets.find((target) => target.backend === 'aionrs');
  const startReview = async () => {
    if (!coach || !data) return;
    setBusy(true);
    try {
      await ipcBridge.cockpit.saveJournal.invoke({ date: today });
      const created = await ipcBridge.conversation.create.invoke({
        name: t('cockpit.today.reviewTitle', { date: today }),
        model: coach.model,
        assistant: { id: coach.assistantId, locale: i18n.language },
        extra: { workspace: data.dir, custom_workspace: true, default_files: [] } as Parameters<
          typeof ipcBridge.conversation.create.invoke
        >[0]['extra'],
      });
      if (!created?.id) throw new Error('create returned no conversation');
      sessionStorage.setItem(
        `aionrs_initial_message_${created.id}`,
        JSON.stringify({ input: WEEKLY_REVIEW_PROMPT, files: [] })
      );
      emitter.emit('chat.history.refresh');
      await navigate(`/conversation/${created.id}`);
    } catch (error) {
      Message.error(parseError(error));
    } finally {
      setBusy(false);
    }
  };

  const field = (key: 'wins' | 'drains' | 'tomorrow') => (
    <label className={styles.field}>
      <span className={styles.fieldLabel}>{t(`cockpit.today.${key}`)}</span>
      <Input.TextArea
        autoSize={{ minRows: 1, maxRows: 4 }}
        value={draft[key] ?? ''}
        placeholder={t(`cockpit.today.${key}Placeholder`)}
        onChange={(value) => setDraft((d) => ({ ...d, [key]: value }))}
        onBlur={() => void save({ [key]: draft[key] ?? '' })}
      />
    </label>
  );

  return (
    <section className={styles.card}>
      <header className={styles.cardHeader}>
        <span>{t('cockpit.today.life')}</span>
        {data?.streak ? (
          <span className={styles.streak}>{t('cockpit.today.streak', { count: data.streak })}</span>
        ) : null}
      </header>
      {data?.carried ? (
        <div className={styles.carried}>
          <span className={styles.fieldLabel}>{t('cockpit.today.fromYesterday')}</span> {data.carried}
        </div>
      ) : null}
      <Input
        className={styles.intention}
        value={draft.intention ?? ''}
        placeholder={t('cockpit.today.intentionPlaceholder')}
        onChange={(value) => setDraft((d) => ({ ...d, intention: value }))}
        onBlur={() => void save({ intention: draft.intention ?? '' })}
        onPressEnter={() => void save({ intention: draft.intention ?? '' })}
      />
      <Button type='text' size='mini' className={styles.toggle} onClick={() => setEvening((v) => !v)}>
        {evening ? <Down size='12' /> : <Right size='12' />}
        {t('cockpit.today.checkIn')}
      </Button>
      {evening ? (
        <div className={styles.fields}>
          {field('wins')}
          {field('drains')}
          {field('tomorrow')}
        </div>
      ) : null}
      <footer className={styles.footer}>
        <span className={styles.private}>{t('cockpit.today.private')}</span>
        <Tooltip content={pulse?.gameMode ? t('cockpit.today.reviewGameMode') : t('cockpit.today.reviewHint')}>
          <Button
            size='small'
            disabled={!coach || busy || pulse?.gameMode}
            loading={busy}
            onClick={() => void startReview()}
          >
            {t('cockpit.today.weeklyReview')}
          </Button>
        </Tooltip>
      </footer>
    </section>
  );
};

const TodayPanel: React.FC<{ targets: HandoffTarget[] }> = ({ targets }) => (
  <div className={styles.today}>
    <NeedsYou />
    <Life targets={targets} />
  </div>
);

export default TodayPanel;
