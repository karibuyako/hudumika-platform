/* Payment methods (MASTER-BLUEPRINT §15 screen 1).
 *
 * Contract reality: GET /payments/methods is the ONLY payment-methods
 * endpoint (packages/contract/src/generated/endpoints/payments/payments.ts) —
 * add/remove/set-default are mock-first app-only mutations until the contract
 * ships them (docs/CONTRACT-ADDITIONS.md #7). The screen stays read-only when
 * the methods repo returns nothing (empty state), and every mutation carries
 * an idempotency key like any other money-touching action.
 */
import { useCallback, useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import {
  Btn,
  Card,
  Chip,
  EmptyState,
  ErrorState,
  Icon,
  ListRow,
  Pill,
  Row,
  Screen,
  SheetModal,
  SkeletonCard,
  type IconName,
} from '@/components/ui';
import { Colors, Fonts, FontSize, Spacing } from '@/constants/theme';
import { t } from '@/i18n';
import { getPaymentsRepository, type PaymentMethodRecord } from '@/repos';
import { toast } from '@/store/ui';
import { idempotencyKey } from '@/lib/idempotency';
import { ApiError } from '@/api/client';
import { PaymentIntentCreateMethod } from '@hudumika/contract';

// The add-sheet offers exactly the contract method enum values (the mock
// validates against the same list — VALIDATION_FAILED otherwise).
const CONTRACT_METHODS = Object.values(PaymentIntentCreateMethod) as string[];

function methodIcon(method: string): IconName {
  switch (method) {
    case 'mpesa':
    case 'tigo_pesa':
    case 'airtel_money':
    case 'ezy_pesa':
    case 'halotel':
      return 'phone-portrait-outline';
    case 'card':
      return 'card-outline';
    case 'cod':
      return 'cash-outline';
    case 'bank':
      return 'business-outline';
    default:
      return 'wallet-outline';
  }
}

function methodLabel(method: string): string {
  switch (method) {
    case 'mpesa':
      return t('payments.mpesa');
    case 'tigo_pesa':
      return t('payments.tigoPesa');
    case 'airtel_money':
      return t('payments.airtelMoney');
    case 'ezy_pesa':
      return t('payments.ezyPesa');
    case 'halotel':
      return t('payments.halotel');
    case 'card':
      return t('payments.card');
    case 'cod':
      return t('payments.cod');
    case 'bank':
      return t('payments.bank');
    default:
      return method
        .split('_')
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(' ');
  }
}

export default function PaymentsScreen() {
  const [methods, setMethods] = useState<PaymentMethodRecord[] | null>(null);
  const [error, setError] = useState('');
  const [addSheet, setAddSheet] = useState(false);
  const [removeId, setRemoveId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);

  const load = useCallback(async () => {
    setError('');
    try {
      setMethods(await getPaymentsRepository().getPaymentMethods());
    } catch {
      setError(t('common.error'));
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const addMethod = async (method: string) => {
    if (busyId) return;
    setBusyId(method);
    setError('');
    try {
      await getPaymentsRepository().addPaymentMethod(method, idempotencyKey('customer', 'payments-add'));
      toast(t('payments.added'));
      setAddSheet(false);
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t('common.error'));
    } finally {
      setBusyId(null);
    }
  };

  const setDefault = async (m: PaymentMethodRecord) => {
    if (busyId) return;
    setBusyId(m.id);
    setError('');
    try {
      await getPaymentsRepository().setDefaultPaymentMethod(m.id, idempotencyKey('customer', 'payments-default'));
      toast(t('payments.defaultSet'));
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t('common.error'));
    } finally {
      setBusyId(null);
    }
  };

  const confirmRemove = async () => {
    if (!removeId || removing) return;
    setRemoving(true);
    setError('');
    try {
      await getPaymentsRepository().removePaymentMethod(removeId, idempotencyKey('customer', 'payments-remove'));
      toast(t('payments.removed'));
      setRemoveId(null);
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t('common.error'));
      setRemoveId(null);
    } finally {
      setRemoving(false);
    }
  };

  if (error) {
    return (
      <Screen>
        <ErrorState message={error} onRetry={load} />
      </Screen>
    );
  }

  const addedMethods = new Set(methods?.map((m) => m.method) ?? []);
  const addable = CONTRACT_METHODS.filter((m) => !addedMethods.has(m));
  const removingMethod = methods?.find((m) => m.id === removeId) ?? null;

  return (
    <Screen scroll>
      <Text style={styles.title}>{t('payments.title')}</Text>

      {methods === null ? (
        <View style={{ gap: Spacing.md, marginTop: Spacing.md }}>
          <SkeletonCard rows={3} />
        </View>
      ) : methods.length === 0 ? (
        // Read-only empty state — the repo returned nothing (live backend
        // that has not shipped the mutations); nothing to manage yet.
        <EmptyState icon="card-outline" title={t('payments.empty')} sub={t('payments.emptyHint')} />
      ) : (
        <Card flat style={{ padding: 0, marginTop: Spacing.md }}>
          {methods.map((m) => (
            <View key={m.id}>
              <ListRow
                title={m.label}
                sub={m.last4 ? `•••• ${m.last4}` : undefined}
                icon={methodIcon(m.method)}
                chevron={false}
                trailing={
                  <Row gap={Spacing.xs}>
                    {m.isDefault ? <Pill label={t('payments.default')} tone="info" /> : null}
                    <Pill
                      label={m.available === false ? t('payments.unavailable') : t('payments.available')}
                      tone={m.available === false ? 'danger' : 'success'}
                    />
                  </Row>
                }
              />
              <Row style={{ paddingHorizontal: Spacing.lg, paddingBottom: Spacing.md, gap: Spacing.sm }}>
                {!m.isDefault ? (
                  <Btn
                    label={t('payments.setDefault')}
                    icon="star-outline"
                    variant="subtle"
                    size="sm"
                    loading={busyId === m.id}
                    disabled={busyId !== null || m.available === false}
                    onPress={() => setDefault(m)}
                  />
                ) : null}
                <Btn
                  label={t('payments.remove')}
                  icon="trash-outline"
                  variant="subtle"
                  size="sm"
                  disabled={busyId !== null}
                  onPress={() => setRemoveId(m.id)}
                />
              </Row>
            </View>
          ))}
        </Card>
      )}

      {/* Add — mock-first until the contract ships POST /payments/methods
          (docs/CONTRACT-ADDITIONS.md #7). Hidden while the list is empty so
          the screen stays read-only when the repo returns nothing. */}
      {methods !== null && methods.length > 0 ? (
        <Card flat style={{ padding: 0, marginTop: Spacing.lg }}>
          <Pressable
            onPress={() => setAddSheet(true)}
            accessibilityRole="button"
            accessibilityLabel={t('payments.add')}
            accessibilityState={{ disabled: false }}>
            <View style={styles.row}>
              <View style={styles.rowIcon}>
                <Icon name="add-circle-outline" size={17} color={Colors.textSecondary} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.rowTitle}>{t('payments.add')}</Text>
              </View>
              <Icon name="chevron-forward" size={15} color={Colors.textFaint} />
            </View>
          </Pressable>
        </Card>
      ) : null}

      <SheetModal visible={addSheet} onClose={() => setAddSheet(false)} title={t('payments.add')}>
        {addable.length === 0 ? (
          <EmptyState icon="checkmark-circle-outline" title={t('payments.allAdded')} />
        ) : (
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.sm }}>
            {addable.map((m) => (
              <Chip
                key={m}
                label={methodLabel(m)}
                onPress={() => addMethod(m)}
                tone="neutral"
              />
            ))}
          </View>
        )}
      </SheetModal>

      <SheetModal visible={removeId !== null} onClose={() => setRemoveId(null)} title={t('payments.removeConfirm', { label: removingMethod?.label ?? '' })}>
        <Text style={styles.sheetSub}>{t('payments.removeConfirmSub')}</Text>
        <Btn label={t('payments.remove')} onPress={confirmRemove} loading={removing} variant="danger" />
      </SheetModal>
    </Screen>
  );
}

const styles = StyleSheet.create({
  title: { fontSize: FontSize.xxl, fontFamily: Fonts.displayBold, color: Colors.text, marginBottom: Spacing.md },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    paddingVertical: Spacing.lg,
    paddingHorizontal: Spacing.lg,
  },
  rowIcon: {
    width: 34,
    height: 34,
    borderRadius: 10,
    backgroundColor: Colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowTitle: { fontSize: FontSize.md, color: Colors.text, fontFamily: Fonts.sansMedium },
  sheetSub: { fontSize: FontSize.sm, color: Colors.textTertiary, fontFamily: Fonts.sans },
});
