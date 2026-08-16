import { Stack, router } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Btn, Card, Chip, Empty, Field, Icon, Pill, Row, Screen, SheetModal } from '@/components/ui';
import { Colors, FontSize, Spacing } from '@/constants/theme';
import { t, onLocaleChange } from '@/i18n';
import { fullTime } from '@/lib/format';
import type { ActivitySubmission, SetupStep, TaskItem, TaskSeverity, TaskStatus } from '@/api/types';
import { useTaskStore } from '@/store/tasks';
import { useMessageStore } from '@/store/messages';

type Tab = 'anomalies' | 'violations' | 'activities' | 'setup';

const TABS: { key: Tab; label: string }[] = [
  { key: 'anomalies', label: t('tsk.tabAnomalies') },
  { key: 'violations', label: t('tsk.tabViolations') },
  { key: 'activities', label: t('tsk.tabActivities') },
  { key: 'setup', label: t('tsk.tabSetup') },
];

const STATUS_PILL: Record<TaskStatus, { label: string; tone: 'neutral' | 'danger' | 'success' | 'info' | 'warning' }> = {
  open: { label: t('tsk.open'), tone: 'warning' },
  in_progress: { label: t('tsk.inProgress'), tone: 'info' },
  done: { label: t('tsk.done'), tone: 'success' },
  dismissed: { label: t('tsk.dismissed'), tone: 'neutral' },
};

const SEVERITY_PILL: Record<TaskSeverity, { label: string; tone: 'neutral' | 'danger' | 'success' | 'info' | 'warning' }> = {
  info: { label: t('tsk.sevInfo'), tone: 'info' },
  warning: { label: t('tsk.sevWarning'), tone: 'warning' },
  critical: { label: t('tsk.sevCritical'), tone: 'danger' },
};

const SUBMISSION_PILL: Record<ActivitySubmission['status'], { label: string; tone: 'neutral' | 'danger' | 'success' | 'info' | 'warning' }> = {
  submitted: { label: t('tsk.submitted'), tone: 'info' },
  approved: { label: t('tsk.approved'), tone: 'success' },
  rejected: { label: t('tsk.rejected'), tone: 'danger' },
};

export default function TasksScreen() {
  useSyncExternalStore(onLocaleChange, () => 0);
  const anomalies = useTaskStore((s) => s.anomalies);
  const violations = useTaskStore((s) => s.violations);
  const activities = useTaskStore((s) => s.activities);
  const setupGuide = useTaskStore((s) => s.setupGuide);
  const error = useTaskStore((s) => s.error);
  const hydrateTasks = useTaskStore((s) => s.hydrateTasks);
  const hydrateSetupGuide = useTaskStore((s) => s.hydrateSetupGuide);
  const updateStatus = useTaskStore((s) => s.updateStatus);
  const submitActivity = useTaskStore((s) => s.submitActivity);
  const completeStep = useTaskStore((s) => s.completeStep);
  const pushMessage = useMessageStore((s) => s.push);

  const [tab, setTab] = useState<Tab>('anomalies');
  const [target, setTarget] = useState<TaskItem | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [formError, setFormError] = useState('');
  const [activitySheet, setActivitySheet] = useState(false);
  const [platformEventId, setPlatformEventId] = useState('');

  useEffect(() => {
    hydrateTasks().catch(() => undefined);
    hydrateSetupGuide().catch(() => undefined);
  }, [hydrateTasks, hydrateSetupGuide]);

  const changeStatus = async (task: TaskItem, status: TaskStatus) => {
    setTarget(task);
    setNote('');
    setFormError('');
    setBusy(true);
    const res = await updateStatus(task.id, { status, ...(note.trim() ? { note: note.trim() } : {}) });
    setBusy(false);
    if (res.ok) {
      setTarget(null);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      pushMessage({ type: 'system', title: t('tsk.statusUpdated'), body: task.title });
    } else {
      setFormError(res.message ?? t('tsk.errLoad'));
    }
  };

  const openStatus = (task: TaskItem) => {
    setTarget(task);
    setNote('');
    setFormError('');
  };

  const doSubmitActivity = async () => {
    const id = platformEventId.trim();
    if (!id) {
      setFormError(t('tsk.errSubmit'));
      return;
    }
    setBusy(true);
    setFormError('');
    const res = await submitActivity({ platformEventId: id });
    setBusy(false);
    if (res.ok) {
      setActivitySheet(false);
      setPlatformEventId('');
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      pushMessage({ type: 'system', title: t('tsk.submitted'), body: id });
    } else {
      setFormError(res.code === 'ACTIVITY_ALREADY_SUBMITTED' ? t('tsk.dupActivity') : (res.message ?? t('tsk.errSubmit')));
    }
  };

  const doCompleteStep = async (step: SetupStep) => {
    setBusy(true);
    const res = await completeStep(step.id);
    setBusy(false);
    if (res.ok) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } else {
      setFormError(res.message ?? t('tsk.errStep'));
    }
  };

  const doneSteps = setupGuide.filter((s) => s.completed).length;
  const taskList: TaskItem[] = tab === 'anomalies' ? anomalies : tab === 'violations' ? violations : [];

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: Colors.bg }} edges={['top']}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.topBar}>
        <Pressable onPress={() => router.back()} hitSlop={12}>
          <Icon name="chevron-back" size={26} color={Colors.text} />
        </Pressable>
        <Text style={styles.topTitle}>{t('tsk.title')}</Text>
        <View style={{ width: 26 }} />
      </View>

      <Screen scroll>
        <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary, marginTop: Spacing.md }}>{t('tsk.sub')}</Text>

        <Row gap={8} style={{ marginTop: Spacing.md, flexWrap: 'wrap' }}>
          {TABS.map((tb) => (
            <Chip key={tb.key} label={tb.label} selected={tab === tb.key} onPress={() => setTab(tb.key)} />
          ))}
        </Row>

        {error ? (
          <View style={{ alignItems: 'center', gap: Spacing.sm, paddingVertical: Spacing.lg }}>
            <Text style={{ fontSize: FontSize.sm, color: Colors.textSecondary, fontWeight: '600' }}>{t('tsk.errLoad')}</Text>
            <Btn label={t('common.retry')} size="sm" variant="outline" onPress={() => hydrateTasks()} />
          </View>
        ) : null}

        {tab === 'setup' ? (
          <View style={{ gap: Spacing.md, marginTop: Spacing.md }}>
            <Card style={{ gap: 6, backgroundColor: Colors.primarySoft }}>
              <Text style={styles.stepsDone}>
                {doneSteps === setupGuide.length ? t('tsk.allStepsDone') : t('tsk.stepsDone', { done: doneSteps, total: setupGuide.length })}
              </Text>
            </Card>
            {setupGuide.map((s) => (
              <Card key={s.id} flat style={[styles.stepCard, s.completed && styles.stepCardDone]}>
                <Row style={{ justifyContent: 'space-between' }}>
                  <View style={{ flex: 1, gap: 2 }}>
                    <Row gap={8}>
                      {s.completed ? (
                        <Icon name="checkmark-circle" size={18} color={Colors.success} />
                      ) : (
                        <Icon name="ellipse-outline" size={18} color={Colors.textTertiary} />
                      )}
                      <Text style={[styles.stepTitle, s.completed && { color: Colors.textTertiary }]} numberOfLines={2}>
                        {s.order}. {s.title}
                      </Text>
                    </Row>
                  </View>
                  <Pill label={s.completed ? t('tsk.stepDone') : t('tsk.stepTodo')} tone={s.completed ? 'success' : 'neutral'} />
                </Row>
                {!s.completed ? (
                  <Btn label={t('tsk.markDone')} size="sm" style={{ alignSelf: 'flex-start', marginTop: 8 }} loading={busy} onPress={() => doCompleteStep(s)} />
                ) : null}
              </Card>
            ))}
          </View>
        ) : tab === 'activities' ? (
          <View style={{ gap: Spacing.md, marginTop: Spacing.md }}>
            <Btn label={t('tsk.submitActivity')} icon="add" size="sm" style={{ alignSelf: 'flex-start' }} onPress={() => { setActivitySheet(true); setFormError(''); }} />
            {activities.length === 0 ? <Empty icon="albums-outline" title={t('tsk.noActivities')} sub={t('tsk.noActivitiesSub')} /> : null}
            {activities.map((a) => (
              <Card key={a.id} flat style={{ gap: 4 }}>
                <Row style={{ justifyContent: 'space-between' }}>
                  <Text style={styles.activityTitle} numberOfLines={1}>{a.platformEventId}</Text>
                  <Pill label={SUBMISSION_PILL[a.status].label} tone={SUBMISSION_PILL[a.status].tone} />
                </Row>
                <Text style={styles.meta}>{t('tsk.submittedAt', { time: fullTime(a.submittedAt) })}</Text>
              </Card>
            ))}
          </View>
        ) : (
          <View style={{ gap: Spacing.md, marginTop: Spacing.md }}>
            {taskList.length === 0 ? <Empty icon="checkmark-done-outline" title={t('tsk.empty')} sub={t('tsk.emptySub')} /> : null}
            {taskList.map((task) => (
              <Card key={task.id} style={{ gap: Spacing.sm }}>
                <Row style={{ justifyContent: 'space-between' }}>
                  <Text style={styles.taskTitle} numberOfLines={2}>{task.title}</Text>
                  <Pill label={STATUS_PILL[task.status].label} tone={STATUS_PILL[task.status].tone} />
                </Row>
                {task.description ? (
                  <Text style={styles.taskDesc} numberOfLines={3}>{task.description}</Text>
                ) : null}
                {task.severity ? (
                  <Row gap={8}>
                    <Pill label={SEVERITY_PILL[task.severity].label} tone={SEVERITY_PILL[task.severity].tone} />
                    {task.refType ? <Text style={styles.meta}>{task.refType} · {task.refId ?? ''}</Text> : null}
                  </Row>
                ) : null}
                {task.status === 'open' || task.status === 'in_progress' ? (
                  <Row gap={Spacing.sm}>
                    {task.status === 'open' ? (
                      <Btn label={t('tsk.markInProgress')} variant="outline" size="sm" style={{ flex: 1 }} onPress={() => changeStatus(task, 'in_progress')} />
                    ) : null}
                    <Btn label={t('tsk.markDone')} variant="success" size="sm" style={{ flex: 1 }} onPress={() => changeStatus(task, 'done')} />
                    <Btn label={t('tsk.markDismissed')} variant="ghost" size="sm" style={{ flex: 1 }} onPress={() => openStatus(task)} />
                  </Row>
                ) : null}
              </Card>
            ))}
          </View>
        )}
      </Screen>

      <SheetModal visible={target !== null} onClose={() => setTarget(null)} title={target?.title ?? ''}>
        <View style={{ gap: Spacing.md }}>
          {target?.description ? (
            <Text style={{ fontSize: FontSize.sm, color: Colors.textSecondary, lineHeight: 19 }}>{target.description}</Text>
          ) : null}
          <Field label={t('tsk.updateNote')} value={note} onChangeText={setNote} multiline maxLength={500} />
          {formError ? <Text style={{ color: Colors.danger, fontSize: FontSize.xs }}>{formError}</Text> : null}
          <Row gap={Spacing.sm}>
            <Btn label={t('common.cancel')} variant="outline" size="sm" style={{ flex: 1 }} onPress={() => setTarget(null)} />
            <Btn
              label={t('tsk.markDismissed')}
              variant="danger"
              size="sm"
              style={{ flex: 1 }}
              loading={busy}
              onPress={async () => {
                if (!target) return;
                await changeStatus(target, 'dismissed');
              }}
            />
          </Row>
        </View>
      </SheetModal>

      <SheetModal visible={activitySheet} onClose={() => setActivitySheet(false)} title={t('tsk.submitTitle')}>
        <View style={{ gap: Spacing.md }}>
          <Field label={t('tsk.platformEventId')} value={platformEventId} onChangeText={setPlatformEventId} placeholder={t('tsk.platformEventIdPh')} />
          {formError ? <Text style={{ color: Colors.danger, fontSize: FontSize.xs }}>{formError}</Text> : null}
          <Btn label={t('tsk.submitActivity')} size="lg" loading={busy} disabled={!platformEventId.trim()} onPress={doSubmitActivity} />
        </View>
      </SheetModal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.md,
    backgroundColor: Colors.card,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Colors.border,
  },
  topTitle: { fontSize: FontSize.lg, fontWeight: '800', color: Colors.text },
  taskTitle: { fontSize: FontSize.md, fontWeight: '700', color: Colors.text, flex: 1 },
  taskDesc: { fontSize: FontSize.xs, color: Colors.textSecondary, lineHeight: 16 },
  activityTitle: { fontSize: FontSize.sm, fontWeight: '700', color: Colors.text, flexShrink: 1 },
  meta: { fontSize: FontSize.xs, color: Colors.textTertiary },
  stepsDone: { fontSize: FontSize.md, fontWeight: '800', color: Colors.text },
  stepCard: { borderWidth: 1, borderColor: Colors.border },
  stepCardDone: { backgroundColor: Colors.surface },
  stepTitle: { fontSize: FontSize.sm, fontWeight: '600', color: Colors.text, flex: 1 },
});
