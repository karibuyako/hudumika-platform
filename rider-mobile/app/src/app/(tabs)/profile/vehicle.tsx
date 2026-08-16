import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { ApiError } from '@/api/client';
import { Btn, Card, Chip, Empty, Field, Pill, Row, Screen, SectionTitle, SheetModal, Spinner, ToggleRow } from '@/components/ui';
import { Colors, FontSize, NumberStyle, Spacing } from '@/constants/theme';
import { formatTZS, t, type I18nKey } from '@/i18n';
import { dateISO } from '@/lib/format';
import { getVehicleRepository } from '@/repos';
import type {
  ExportRiderReport202,
  ExportRiderReportBodyFormat,
  ExportRiderReportBodyReportType,
  RiderExpense,
  RiderExpenseCategory,
  RiderGoals,
  TrainingModule,
  TrainingModuleStatus,
  VehicleMaintenance,
  VehicleMaintenanceType,
} from '@hudumika/contract';

const MAINTENANCE_TYPES: VehicleMaintenanceType[] = ['oil_change', 'tire_pressure', 'battery_health', 'brake_service', 'general_service'];
const EXPENSE_CATEGORIES: RiderExpenseCategory[] = ['fuel', 'maintenance', 'insurance', 'equipment', 'tax_deduction', 'other'];
const REPORT_TYPES: ExportRiderReportBodyReportType[] = ['tax', 'earnings', 'trips'];
const EXPORT_FORMATS: ExportRiderReportBodyFormat[] = ['csv', 'pdf', 'json'];
const DAYS = [0, 1, 2, 3, 4, 5, 6];

const DAY_KEYS: Record<number, I18nKey> = {
  0: 'vehicle.day.0',
  1: 'vehicle.day.1',
  2: 'vehicle.day.2',
  3: 'vehicle.day.3',
  4: 'vehicle.day.4',
  5: 'vehicle.day.5',
  6: 'vehicle.day.6',
};

const TRAINING_STATUS_KEY: Record<TrainingModuleStatus, I18nKey> = {
  not_started: 'vehicle.notStarted',
  in_progress: 'vehicle.inProgress',
  completed: 'vehicle.completed',
  certified: 'vehicle.certified',
};

const TRAINING_STATUS_TONE: Record<TrainingModuleStatus, 'neutral' | 'info' | 'success'> = {
  not_started: 'neutral',
  in_progress: 'info',
  completed: 'info',
  certified: 'success',
};

const EXPORT_STATUS_KEY: Record<ExportRiderReport202['status'], I18nKey> = {
  queued: 'vehicle.exportStatus.queued',
  processing: 'vehicle.exportStatus.processing',
  ready: 'vehicle.exportStatus.ready',
  failed: 'vehicle.exportStatus.failed',
};

const EXPORT_STATUS_TONE: Record<ExportRiderReport202['status'], 'neutral' | 'info' | 'success' | 'danger'> = {
  queued: 'neutral',
  processing: 'info',
  ready: 'success',
  failed: 'danger',
};

/** Warning window for predictive nextDueAt: overdue or due within 7 days. */
const DUE_WINDOW_MS = 7 * 24 * 3600_000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function dateOnly(ts?: string | null): string {
  if (!ts) return '—';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '—';
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

function dueState(nextDueAt?: string | null): 'overdue' | 'soon' | null {
  if (!nextDueAt) return null;
  const due = Date.parse(nextDueAt);
  if (Number.isNaN(due)) return null;
  if (due < Date.now()) return 'overdue';
  if (due - Date.now() <= DUE_WINDOW_MS) return 'soon';
  return null;
}

export default function VehicleScreen() {
  /* ---- Maintenance ---- */
  const [maintenance, setMaintenance] = useState<VehicleMaintenance[] | null>(null);
  const [maintenanceError, setMaintenanceError] = useState('');
  const [addVisible, setAddVisible] = useState(false);
  const [recordType, setRecordType] = useState<VehicleMaintenanceType>('oil_change');
  const [recordMileage, setRecordMileage] = useState('');
  const [recordCost, setRecordCost] = useState('');
  const [recordNotes, setRecordNotes] = useState('');
  const [adding, setAdding] = useState(false);
  const [recordError, setRecordError] = useState('');
  const [recordSaved, setRecordSaved] = useState(false);

  /* ---- Expenses ---- */
  const [expenses, setExpenses] = useState<RiderExpense[] | null>(null);
  const [expensesError, setExpensesError] = useState('');
  const [expenseVisible, setExpenseVisible] = useState(false);
  const [expenseCategory, setExpenseCategory] = useState<RiderExpenseCategory>('fuel');
  const [expenseAmount, setExpenseAmount] = useState('');
  const [expenseNote, setExpenseNote] = useState('');
  const [expenseDeductible, setExpenseDeductible] = useState(false);
  const [addingExpense, setAddingExpense] = useState(false);
  const [expenseError, setExpenseError] = useState('');
  const [expenseSaved, setExpenseSaved] = useState(false);

  /* ---- Goals & schedule ---- */
  const [goals, setGoals] = useState<RiderGoals | null>(null);
  const [goalsError, setGoalsError] = useState('');
  const [hoursDraft, setHoursDraft] = useState('');
  const [earningsDraft, setEarningsDraft] = useState('');
  const [daysSelected, setDaysSelected] = useState<number[]>([]);
  const [peakAlerts, setPeakAlerts] = useState(true);
  const [savingGoals, setSavingGoals] = useState(false);
  const [goalsFormError, setGoalsFormError] = useState('');
  const [goalsSaved, setGoalsSaved] = useState(false);

  /* ---- Export center ---- */
  const [reportType, setReportType] = useState<ExportRiderReportBodyReportType>('earnings');
  const [exportFormat, setExportFormat] = useState<ExportRiderReportBodyFormat>('pdf');
  const [exportFrom, setExportFrom] = useState('');
  const [exportTo, setExportTo] = useState('');
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState('');
  const [exportJob, setExportJob] = useState<ExportRiderReport202 | null>(null);

  /* ---- Training center ---- */
  const [training, setTraining] = useState<TrainingModule[] | null>(null);
  const [trainingError, setTrainingError] = useState('');
  const [completingId, setCompletingId] = useState('');
  const [completeError, setCompleteError] = useState('');

  const loadMaintenance = useCallback(async () => {
    setMaintenanceError('');
    try {
      setMaintenance(await getVehicleRepository().listMaintenance());
    } catch (e) {
      setMaintenanceError(e instanceof ApiError ? e.message : t('vehicle.maintenanceLoadFailed'));
    }
  }, []);

  const loadExpenses = useCallback(async () => {
    setExpensesError('');
    try {
      setExpenses(await getVehicleRepository().listExpenses());
    } catch (e) {
      setExpensesError(e instanceof ApiError ? e.message : t('vehicle.expensesLoadFailed'));
    }
  }, []);

  const loadGoals = useCallback(async () => {
    setGoalsError('');
    try {
      const g = await getVehicleRepository().getGoals();
      setGoals(g);
      setHoursDraft(String(g.hoursGoalPerWeek));
      setEarningsDraft(String(g.earningsGoalTZS));
      setDaysSelected((g.weeklyAvailability ?? []).map((d) => d.dayOfWeek));
      setPeakAlerts(g.peakHourAlerts ?? true);
    } catch (e) {
      setGoalsError(e instanceof ApiError ? e.message : t('vehicle.goalsLoadFailed'));
    }
  }, []);

  const loadTraining = useCallback(async () => {
    setTrainingError('');
    try {
      setTraining(await getVehicleRepository().listTraining());
    } catch (e) {
      setTrainingError(e instanceof ApiError ? e.message : t('vehicle.trainingLoadFailed'));
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      loadMaintenance();
      loadExpenses();
      loadGoals();
      loadTraining();
    }, [loadMaintenance, loadExpenses, loadGoals, loadTraining]),
  );

  /* ---- Maintenance mutations ---- */

  const openAddRecord = () => {
    setRecordType('oil_change');
    setRecordMileage('');
    setRecordCost('');
    setRecordNotes('');
    setRecordError('');
    setRecordSaved(false);
    setAddVisible(true);
  };

  const submitRecord = async () => {
    const mileage = recordMileage.trim() === '' ? null : Number(recordMileage);
    const cost = recordCost.trim() === '' ? null : Number(recordCost);
    if (mileage !== null && (!Number.isInteger(mileage) || mileage < 0)) {
      setRecordError(t('vehicle.invalidMileage'));
      return;
    }
    if (cost !== null && (!Number.isInteger(cost) || cost < 0)) {
      setRecordError(t('vehicle.invalidCost'));
      return;
    }
    setAdding(true);
    setRecordError('');
    try {
      await getVehicleRepository().createMaintenance({
        type: recordType,
        performedAt: new Date().toISOString(),
        mileageKm: mileage,
        costTZS: cost,
        notes: recordNotes.trim() || undefined,
      });
      setAddVisible(false);
      setRecordSaved(true);
      await loadMaintenance();
    } catch (e) {
      setRecordError(e instanceof ApiError ? e.message : t('vehicle.recordFailed'));
    } finally {
      setAdding(false);
    }
  };

  /* ---- Expense mutations ---- */

  const openAddExpense = () => {
    setExpenseCategory('fuel');
    setExpenseAmount('');
    setExpenseNote('');
    setExpenseDeductible(false);
    setExpenseError('');
    setExpenseSaved(false);
    setExpenseVisible(true);
  };

  const submitExpense = async () => {
    const amount = Number(expenseAmount);
    if (!Number.isInteger(amount) || amount < 0) {
      setExpenseError(t('vehicle.expenseInvalidAmount'));
      return;
    }
    setAddingExpense(true);
    setExpenseError('');
    try {
      await getVehicleRepository().createExpense({
        category: expenseCategory,
        amountTZS: amount,
        deductible: expenseDeductible,
        note: expenseNote.trim() || undefined,
        incurredAt: new Date().toISOString(),
      });
      setExpenseVisible(false);
      setExpenseSaved(true);
      await loadExpenses();
    } catch (e) {
      setExpenseError(e instanceof ApiError ? e.message : t('vehicle.expenseFailed'));
    } finally {
      setAddingExpense(false);
    }
  };

  /* ---- Goals mutations (optimistic PUT with previous-values revert) ---- */

  const toggleDay = (day: number) => {
    setDaysSelected((prev) => (prev.includes(day) ? prev.filter((d) => d !== day) : [...prev, day]));
    setGoalsFormError('');
  };

  const saveGoals = async () => {
    const hours = Number(hoursDraft);
    const earnings = Number(earningsDraft);
    if (!Number.isInteger(hours) || hours < 1 || hours > 100) {
      setGoalsFormError(t('vehicle.goalsInvalidHours'));
      return;
    }
    if (!Number.isInteger(earnings) || earnings < 0) {
      setGoalsFormError(t('vehicle.goalsInvalidEarnings'));
      return;
    }
    setSavingGoals(true);
    setGoalsFormError('');
    const previous = goals;
    const weeklyAvailability = daysSelected.map((day) => {
      const existing = previous?.weeklyAvailability?.find((a) => a.dayOfWeek === day);
      return { dayOfWeek: day, startTime: existing?.startTime ?? '09:00', endTime: existing?.endTime ?? '18:00' };
    });
    const next: RiderGoals = {
      hoursGoalPerWeek: hours,
      earningsGoalTZS: earnings,
      weeklyAvailability,
      peakHourAlerts: peakAlerts,
    };
    try {
      setGoals(await getVehicleRepository().putGoals(next));
      setGoalsSaved(true);
    } catch (e) {
      setGoalsFormError(e instanceof ApiError ? e.message : t('vehicle.goalsFailed'));
      if (previous) {
        setHoursDraft(String(previous.hoursGoalPerWeek));
        setEarningsDraft(String(previous.earningsGoalTZS));
        setDaysSelected((previous.weeklyAvailability ?? []).map((d) => d.dayOfWeek));
        setPeakAlerts(previous.peakHourAlerts ?? true);
      }
    } finally {
      setSavingGoals(false);
    }
  };

  /* ---- Export mutations ---- */

  const submitExport = async () => {
    if ((exportFrom.trim() !== '' && !DATE_RE.test(exportFrom.trim())) || (exportTo.trim() !== '' && !DATE_RE.test(exportTo.trim()))) {
      setExportError(t('vehicle.exportInvalidDate'));
      return;
    }
    setExporting(true);
    setExportError('');
    try {
      const job = await getVehicleRepository().requestExport({
        reportType,
        format: exportFormat,
        from: exportFrom.trim() || undefined,
        to: exportTo.trim() || undefined,
      });
      setExportJob(job);
    } catch (e) {
      setExportError(e instanceof ApiError ? e.message : t('vehicle.exportFailed'));
    } finally {
      setExporting(false);
    }
  };

  /* ---- Training mutations ---- */

  const completeModule = async (moduleId: string) => {
    setCompletingId(moduleId);
    setCompleteError('');
    try {
      const updated = await getVehicleRepository().completeTraining(moduleId);
      setTraining((list) => (list ?? []).map((m) => (m.id === updated.id ? updated : m)));
    } catch (e) {
      setCompleteError(e instanceof ApiError ? e.message : t('vehicle.completeFailed'));
    } finally {
      setCompletingId('');
    }
  };

  return (
    <Screen scroll>
      {/* Vehicle maintenance */}
      <SectionTitle title={t('vehicle.maintenance')} icon="construct-outline" action={t('vehicle.addRecord')} onAction={openAddRecord} />
      {maintenanceError ? (
        <Card style={{ gap: Spacing.sm }}>
          <Text style={styles.error}>{maintenanceError}</Text>
          <Btn label={t('common.retry')} variant="ghost" size="sm" onPress={loadMaintenance} />
        </Card>
      ) : maintenance === null ? (
        <View style={styles.loadingBox}>
          <Spinner color={Colors.primary} />
        </View>
      ) : maintenance.length === 0 ? (
        <Empty icon="construct-outline" title={t('vehicle.maintenanceEmpty')} sub={t('vehicle.maintenanceEmptySub')} />
      ) : (
        <View style={{ gap: Spacing.md }}>
          {recordSaved ? <Text style={styles.successText}>{t('vehicle.recordSaved')}</Text> : null}
          {maintenance.map((r) => {
            const due = dueState(r.nextDueAt);
            return (
              <Card key={r.id} style={{ gap: Spacing.xs }}>
                <Row style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <View style={{ flex: 1, gap: 2 }}>
                    <Text style={styles.cardTitle}>{t(`vehicle.type.${r.type}`)}</Text>
                    <Text style={styles.metaText}>{t('vehicle.performedAt', { time: dateISO(r.performedAt) })}</Text>
                    {r.mileageKm != null ? <Text style={styles.metaText}>{r.mileageKm} km</Text> : null}
                    {r.notes ? <Text style={styles.noteText}>{r.notes}</Text> : null}
                  </View>
                  {r.costTZS != null ? <Text style={styles.amountText}>{formatTZS(r.costTZS)}</Text> : null}
                </Row>
                {r.nextDueAt ? (
                  <Row style={{ justifyContent: 'space-between' }}>
                    <Text style={styles.metaText}>{t('vehicle.due', { date: dateOnly(r.nextDueAt) })}</Text>
                    {due ? <Pill label={due === 'overdue' ? t('vehicle.overdue') : t('vehicle.dueSoon')} tone="warning" /> : null}
                  </Row>
                ) : null}
              </Card>
            );
          })}
        </View>
      )}

      {/* Expenses */}
      <SectionTitle title={t('vehicle.expenses')} icon="receipt-outline" action={t('vehicle.addExpense')} onAction={openAddExpense} />
      {expensesError ? (
        <Card style={{ gap: Spacing.sm }}>
          <Text style={styles.error}>{expensesError}</Text>
          <Btn label={t('common.retry')} variant="ghost" size="sm" onPress={loadExpenses} />
        </Card>
      ) : expenses === null ? (
        <View style={styles.loadingBox}>
          <Spinner color={Colors.primary} />
        </View>
      ) : expenses.length === 0 ? (
        <Empty icon="receipt-outline" title={t('vehicle.expensesEmpty')} sub={t('vehicle.expensesEmptySub')} />
      ) : (
        <View style={{ gap: Spacing.md }}>
          {expenseSaved ? <Text style={styles.successText}>{t('vehicle.expenseSaved')}</Text> : null}
          {expenses.map((e) => (
            <Card key={e.id} style={{ gap: Spacing.xs }}>
              <Row style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <View style={{ flex: 1, gap: 2 }}>
                  <Text style={styles.cardTitle}>{t(`vehicle.expenseCategory.${e.category}`)}</Text>
                  <Text style={styles.metaText}>{dateISO(e.incurredAt)}</Text>
                  {e.note ? <Text style={styles.noteText}>{e.note}</Text> : null}
                  {e.deductible === true ? <Pill label={t('vehicle.expenseDeductible')} tone="info" /> : null}
                </View>
                <Text style={styles.amountText}>{formatTZS(e.amountTZS)}</Text>
              </Row>
            </Card>
          ))}
        </View>
      )}

      {/* Goals & schedule */}
      <SectionTitle title={t('vehicle.goals')} icon="calendar-outline" />
      {goalsError ? (
        <Card style={{ gap: Spacing.sm }}>
          <Text style={styles.error}>{goalsError}</Text>
          <Btn label={t('common.retry')} variant="ghost" size="sm" onPress={loadGoals} />
        </Card>
      ) : goals === null ? (
        <View style={styles.loadingBox}>
          <Spinner color={Colors.primary} />
        </View>
      ) : (
        <Card style={{ gap: Spacing.md }}>
          <Field label={t('vehicle.hoursGoal')} value={hoursDraft} onChangeText={setHoursDraft} keyboardType="number-pad" />
          <Field label={t('vehicle.earningsGoal')} value={earningsDraft} onChangeText={setEarningsDraft} keyboardType="number-pad" />
          <View style={{ gap: Spacing.sm }}>
            <Text style={styles.fieldLabel}>{t('vehicle.availability')}</Text>
            <Text style={styles.fieldSub}>{t('vehicle.availabilitySub')}</Text>
            <Row gap={Spacing.sm} style={{ flexWrap: 'wrap' }}>
              {DAYS.map((day) => (
                <Chip key={day} label={t(DAY_KEYS[day])} selected={daysSelected.includes(day)} onPress={() => toggleDay(day)} />
              ))}
            </Row>
          </View>
          <View style={styles.toggleBorder}>
            <ToggleRow label={t('vehicle.peakHourAlerts')} sub={t('vehicle.peakHourAlertsSub')} value={peakAlerts} onChange={setPeakAlerts} />
          </View>
          {goalsSaved ? <Text style={styles.successText}>{t('vehicle.goalsSaved')}</Text> : null}
          {goalsFormError ? <Text style={styles.error}>{goalsFormError}</Text> : null}
          <Btn label={t('vehicle.saveGoals')} onPress={saveGoals} loading={savingGoals} />
        </Card>
      )}

      {/* Export center */}
      <SectionTitle title={t('vehicle.exports')} icon="download-outline" />
      <Card style={{ gap: Spacing.md }}>
        {exportJob ? (
          <View style={{ gap: Spacing.sm }}>
            <Row style={{ justifyContent: 'space-between' }}>
              <Text style={styles.cardTitle}>{t('vehicle.exportRequested')}</Text>
            </Row>
            <Text style={styles.metaText}>{t('vehicle.exportJobId', { jobId: exportJob.jobId })}</Text>
            <Row>
              <Pill label={t(EXPORT_STATUS_KEY[exportJob.status])} tone={EXPORT_STATUS_TONE[exportJob.status]} />
            </Row>
            <Btn label={t('vehicle.exportRequest')} variant="outline" size="sm" onPress={() => setExportJob(null)} />
          </View>
        ) : (
          <View style={{ gap: Spacing.md }}>
            <Text style={styles.fieldLabel}>{t('vehicle.reportType')}</Text>
            <Row gap={Spacing.sm} style={{ flexWrap: 'wrap' }}>
              {REPORT_TYPES.map((rt) => (
                <Chip key={rt} label={t(`vehicle.reportType.${rt}`)} selected={reportType === rt} onPress={() => setReportType(rt)} />
              ))}
            </Row>
            <Text style={styles.fieldLabel}>{t('vehicle.exportFormat')}</Text>
            <Row gap={Spacing.sm} style={{ flexWrap: 'wrap' }}>
              {EXPORT_FORMATS.map((f) => (
                <Chip key={f} label={t(`vehicle.format.${f}`)} selected={exportFormat === f} onPress={() => setExportFormat(f)} />
              ))}
            </Row>
            <Field label={t('vehicle.exportFrom')} value={exportFrom} onChangeText={setExportFrom} placeholder="YYYY-MM-DD" />
            <Field label={t('vehicle.exportTo')} value={exportTo} onChangeText={setExportTo} placeholder="YYYY-MM-DD" />
            {exportError ? <Text style={styles.error}>{exportError}</Text> : null}
            <Btn label={t('vehicle.exportRequest')} icon="download-outline" onPress={submitExport} loading={exporting} />
          </View>
        )}
      </Card>

      {/* Training center */}
      <SectionTitle title={t('vehicle.training')} icon="school-outline" />
      {trainingError ? (
        <Card style={{ gap: Spacing.sm }}>
          <Text style={styles.error}>{trainingError}</Text>
          <Btn label={t('common.retry')} variant="ghost" size="sm" onPress={loadTraining} />
        </Card>
      ) : training === null ? (
        <View style={styles.loadingBox}>
          <Spinner color={Colors.primary} />
        </View>
      ) : training.length === 0 ? (
        <Empty icon="school-outline" title={t('vehicle.trainingEmpty')} sub={t('vehicle.trainingEmptySub')} />
      ) : (
        <View style={{ gap: Spacing.md }}>
          {completeError ? <Text style={styles.error}>{completeError}</Text> : null}
          {training.map((m) => {
            const certified = m.status === 'certified';
            return (
              <Card key={m.id} style={{ gap: Spacing.sm }}>
                <Row style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <View style={{ flex: 1, gap: 2 }}>
                    <Text style={styles.cardTitle}>{m.title}</Text>
                    <Text style={styles.metaText}>
                      {m.category ? t(`vehicle.category.${m.category}`) : ''}
                      {m.durationMinutes ? ` · ${t('vehicle.duration', { minutes: m.durationMinutes })}` : ''}
                    </Text>
                  </View>
                  <Pill label={t(TRAINING_STATUS_KEY[m.status])} tone={TRAINING_STATUS_TONE[m.status]} />
                </Row>
                <View style={styles.progressTrack}>
                  <View style={[styles.progressFill, { width: `${m.progressPct ?? 0}%` }]} />
                </View>
                {certified ? (
                  <Row style={{ justifyContent: 'space-between' }}>
                    <Text style={styles.metaText}>
                      {m.completedAt ? `${t('vehicle.completedAt', { time: dateISO(m.completedAt) })} · ` : ''}
                      {m.certificateUrl ? t('vehicle.certificate') : ''}
                    </Text>
                    {m.rewardTZS != null ? <Text style={styles.rewardText}>{t('vehicle.reward', { amount: formatTZS(m.rewardTZS) })}</Text> : null}
                  </Row>
                ) : m.rewardTZS != null ? (
                  <Text style={styles.metaText}>{t('vehicle.reward', { amount: formatTZS(m.rewardTZS) })}</Text>
                ) : null}
                {!certified ? (
                  <Btn
                    label={t('vehicle.markComplete')}
                    variant="ghost"
                    size="sm"
                    onPress={() => completeModule(m.id)}
                    loading={completingId === m.id}
                  />
                ) : null}
              </Card>
            );
          })}
        </View>
      )}

      {/* Add maintenance record sheet */}
      <SheetModal visible={addVisible} onClose={() => setAddVisible(false)} title={t('vehicle.addRecord')}>
        <View style={{ gap: Spacing.md }}>
          <Text style={styles.fieldLabel}>{t('vehicle.recordType')}</Text>
          <Row gap={Spacing.sm} style={{ flexWrap: 'wrap' }}>
            {MAINTENANCE_TYPES.map((ty) => (
              <Chip key={ty} label={t(`vehicle.type.${ty}`)} selected={recordType === ty} onPress={() => setRecordType(ty)} />
            ))}
          </Row>
          <Field label={t('vehicle.mileage')} value={recordMileage} onChangeText={setRecordMileage} placeholder={t('vehicle.mileagePlaceholder')} keyboardType="number-pad" />
          <Field label={t('vehicle.cost')} value={recordCost} onChangeText={setRecordCost} placeholder={t('vehicle.costPlaceholder')} keyboardType="number-pad" />
          <Field label={t('vehicle.notes')} value={recordNotes} onChangeText={setRecordNotes} placeholder={t('vehicle.notesPlaceholder')} multiline maxLength={500} />
          {recordError ? <Text style={styles.error}>{recordError}</Text> : null}
          <Btn label={t('vehicle.addRecord')} icon="add" onPress={submitRecord} loading={adding} size="lg" />
        </View>
      </SheetModal>

      {/* Add expense sheet */}
      <SheetModal visible={expenseVisible} onClose={() => setExpenseVisible(false)} title={t('vehicle.addExpense')}>
        <View style={{ gap: Spacing.md }}>
          <Text style={styles.fieldLabel}>{t('vehicle.expenseCategory')}</Text>
          <Row gap={Spacing.sm} style={{ flexWrap: 'wrap' }}>
            {EXPENSE_CATEGORIES.map((c) => (
              <Chip key={c} label={t(`vehicle.expenseCategory.${c}`)} selected={expenseCategory === c} onPress={() => setExpenseCategory(c)} />
            ))}
          </Row>
          <Field label={t('vehicle.expenseAmount')} value={expenseAmount} onChangeText={setExpenseAmount} placeholder={t('vehicle.expenseAmountPlaceholder')} keyboardType="number-pad" />
          <Field label={t('vehicle.expenseNote')} value={expenseNote} onChangeText={setExpenseNote} placeholder={t('vehicle.expenseNotePlaceholder')} maxLength={500} />
          <ToggleRow label={t('vehicle.expenseDeductible')} sub={t('vehicle.expenseDeductibleSub')} value={expenseDeductible} onChange={setExpenseDeductible} />
          {expenseError ? <Text style={styles.error}>{expenseError}</Text> : null}
          <Btn label={t('vehicle.addExpense')} icon="add" onPress={submitExpense} loading={addingExpense} size="lg" />
        </View>
      </SheetModal>
    </Screen>
  );
}

const styles = StyleSheet.create({
  loadingBox: { paddingVertical: Spacing.xl, alignItems: 'center' },
  error: { color: Colors.danger, fontSize: FontSize.sm },
  successText: { color: Colors.success, fontSize: FontSize.sm, fontWeight: '700' },
  fieldLabel: { fontSize: FontSize.sm, color: Colors.textSecondary, fontWeight: '700' },
  fieldSub: { fontSize: FontSize.xs, color: Colors.textTertiary, lineHeight: 17 },
  cardTitle: { fontSize: FontSize.md, fontWeight: '700', color: Colors.text },
  metaText: { fontSize: FontSize.xs, color: Colors.textTertiary, lineHeight: 17 },
  noteText: { fontSize: FontSize.sm, color: Colors.textSecondary, lineHeight: 18 },
  amountText: { color: Colors.text, fontSize: FontSize.md, fontWeight: '800', fontVariant: NumberStyle.fontVariant },
  rewardText: { color: Colors.primaryDeep, fontSize: FontSize.xs, fontWeight: '700', fontVariant: NumberStyle.fontVariant },
  toggleBorder: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: Colors.border },
  progressTrack: {
    height: 6,
    borderRadius: 3,
    backgroundColor: Colors.surface,
    overflow: 'hidden',
  },
  progressFill: {
    height: 6,
    borderRadius: 3,
    backgroundColor: Colors.primary,
  },
});
