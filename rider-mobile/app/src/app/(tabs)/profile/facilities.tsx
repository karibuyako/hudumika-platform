import { useCallback, useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { ApiError } from '@/api/client';
import { Btn, Card, Empty, Pill, Screen, Spinner } from '@/components/ui';
import { Colors, FontSize, Radius, Spacing } from '@/constants/theme';
import { t } from '@/i18n';
import { dateISO } from '@/lib/format';
import { MockLogisticsRepository } from '@/repos/mock/logistics';
import { MockSupportRepository } from '@/repos/mock/support';

const logistics = new MockLogisticsRepository();
const support = new MockSupportRepository();

export default function FacilitiesScreen() {
  const [entries, setEntries] = useState<import('@/lib/logistics').FacilityWhitelistEntry[] | null>(null);
  const [scans, setScans] = useState<import('@/lib/logistics').FacilityScan[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [scanError, setScanError] = useState<{ message: string; requestId?: string; facilityName?: string } | null>(null);
  const [ticketSent, setTicketSent] = useState(false);
  const [ticketLoading, setTicketLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await logistics.getFacilityStatus();
      setEntries(res.entries);
      setScans(res.lastScanOutcomes);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t('logistics.facilityLoadFailed'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const onScan = async (facilityId: string) => {
    setScanError(null);
    setTicketSent(false);
    try {
      await logistics.scanAtFacility(facilityId);
      await load();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'NOT_WHITELISTED') {
        const name = entries?.find((en) => en.facilityId === facilityId)?.facilityName ?? facilityId;
        setScanError({ message: e.message, requestId: e.requestId, facilityName: name });
      } else {
        setScanError({ message: e instanceof ApiError ? e.message : t('logistics.facilityScanFailed') });
      }
      await load();
    }
  };

  const onRequestAccess = async () => {
    if (!scanError?.requestId || !scanError?.facilityName) return;
    setTicketLoading(true);
    try {
      await support.createTicket(
        `Request facility access — ${scanError.facilityName}`,
        `Requesting whitelist access for ${scanError.facilityName}. RequestId: ${scanError.requestId}. Please grant entry for deliveries.`,
        'other',
      );
      setTicketSent(true);
      setScanError(null);
    } catch {
      // keep error visible
    } finally {
      setTicketLoading(false);
    }
  };

  if (loading) {
    return (
      <Screen>
        <View style={styles.center}>
          <Spinner color={Colors.primary} />
        </View>
      </Screen>
    );
  }

  if (error) {
    return (
      <Screen>
        <View style={styles.center}>
          <Text style={styles.error}>{error}</Text>
          <Btn label={t('common.retry')} variant="ghost" onPress={load} />
        </View>
      </Screen>
    );
  }

  if (!entries || entries.length === 0) {
    return (
      <Screen>
        <Empty icon="business-outline" title={t('logistics.facilityEmpty')} sub={t('logistics.facilitiesSub')} />
      </Screen>
    );
  }

  return (
    <Screen scroll>
      {scanError ? (
        <Card style={styles.blockCard}>
          <Text style={styles.blockTitle}>{t('logistics.facilityNotWhitelisted')}</Text>
          <Text style={styles.blockMessage}>{scanError.message}</Text>
          {scanError.requestId ? <Text style={styles.blockRequestId}>RequestId: {scanError.requestId}</Text> : null}
          <Btn label={t('logistics.facilityRequestAccess')} onPress={onRequestAccess} loading={ticketLoading} style={{ marginTop: Spacing.sm }} />
          {ticketSent ? <Text style={styles.success}>{t('logistics.facilityRequestSent')}</Text> : null}
        </Card>
      ) : null}

      {entries.map((e) => (
        <Card key={e.facilityId} style={styles.entryCard}>
          <View style={styles.entryHeader}>
            <Text style={styles.entryName}>{e.facilityName}</Text>
            <Pill label={t(e.status === 'granted' ? 'logistics.facilityGranted' : 'logistics.facilityRevoked')} tone={e.status === 'granted' ? 'success' : 'danger'} />
          </View>
          <View style={styles.entryMeta}>
            <Pill
              label={t(`logistics.facilityPolicy.${e.policy}` as never)}
              tone="neutral"
            />
            {e.grantedAt ? <Text style={styles.metaText}>Granted {dateISO(e.grantedAt)}</Text> : null}
            {e.revokedAt ? <Text style={styles.metaText}>Revoked {dateISO(e.revokedAt)}</Text> : null}
          </View>
          {e.lastScanOutcome ? (
            <View style={styles.scanBox}>
              <Text style={styles.scanLabel}>{t('logistics.facilityLastScan')}</Text>
              <View style={styles.scanRow}>
                <Pill label={e.lastScanOutcome.result === 'granted' ? t('logistics.facilityScanGranted') : t('logistics.facilityScanBlocked')} tone={e.lastScanOutcome.result === 'granted' ? 'success' : 'danger'} />
                <Text style={styles.metaText}>{dateISO(e.lastScanOutcome.at)}</Text>
              </View>
              {e.lastScanOutcome.requestId ? <Text style={styles.requestId}>RequestId: {e.lastScanOutcome.requestId}</Text> : null}
              {e.lastScanOutcome.code ? <Text style={styles.codeText}>{e.lastScanOutcome.code}</Text> : null}
            </View>
          ) : null}
          {e.status === 'revoked' ? (
            <Btn label={t('logistics.facilityRequestAccess')} variant="ghost" size="sm" onPress={() => onScan(e.facilityId)} style={{ marginTop: Spacing.sm }} />
          ) : (
            <Btn label="Simulate entry scan" variant="ghost" size="sm" onPress={() => onScan(e.facilityId)} style={{ marginTop: Spacing.sm }} />
          )}
        </Card>
      ))}

      <Card style={styles.scansCard}>
        <Text style={styles.scansTitle}>{t('logistics.facilityLastScan')}</Text>
        {scans?.map((s) => (
          <View key={`${s.facilityId}-${s.at}`} style={styles.scanLine}>
            <Text style={styles.scanFacility}>{s.facilityName}</Text>
            <Pill label={s.result === 'granted' ? t('logistics.facilityScanGranted') : t('logistics.facilityScanBlocked')} tone={s.result === 'granted' ? 'success' : 'danger'} />
            <Text style={styles.metaText}>{dateISO(s.at)}</Text>
          </View>
        ))}
      </Card>
    </Screen>
  );
}

const styles = StyleSheet.create({
  center: { alignItems: 'center', gap: Spacing.md, paddingTop: 80 },
  error: { color: Colors.danger, fontSize: FontSize.sm },
  success: { color: Colors.success, fontSize: FontSize.sm, marginTop: Spacing.sm, fontWeight: '700' },
  entryCard: { gap: Spacing.sm },
  entryHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  entryName: { fontSize: FontSize.md, fontWeight: '700', color: Colors.text },
  entryMeta: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.sm, alignItems: 'center' },
  metaText: { fontSize: FontSize.xs, color: Colors.textTertiary },
  scanBox: { backgroundColor: Colors.surface, borderRadius: Radius.sm, padding: Spacing.sm, gap: Spacing.xs },
  scanLabel: { fontSize: FontSize.xs, color: Colors.textSecondary, fontWeight: '700' },
  scanRow: { flexDirection: 'row', gap: Spacing.sm, alignItems: 'center' },
  requestId: { fontSize: FontSize.xs, color: Colors.textTertiary },
  codeText: { fontSize: FontSize.xs, color: Colors.danger, fontWeight: '700' },
  scansCard: { gap: Spacing.sm },
  scansTitle: { fontSize: FontSize.md, fontWeight: '700', color: Colors.text },
  scanLine: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm, paddingVertical: Spacing.xs },
  scanFacility: { flex: 1, fontSize: FontSize.sm, color: Colors.text },
  blockCard: { backgroundColor: Colors.dangerSoft, borderWidth: 1, borderColor: Colors.danger, gap: Spacing.sm },
  blockTitle: { fontSize: FontSize.md, fontWeight: '800', color: Colors.danger },
  blockMessage: { fontSize: FontSize.sm, color: Colors.text },
  blockRequestId: { fontSize: FontSize.xs, color: Colors.textTertiary },
});
