import { router, useFocusEffect } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';

import { ApiError } from '@/api/client';
import { CountdownPill } from '@/components/CountdownPill';
import { OfferCard } from '@/components/OfferCard';
import { Btn, Card, Empty, ErrorCard, Field, Icon, Row, Screen, Segmented, SheetModal } from '@/components/ui';
import { Colors, FontSize, NumberStyle, Radius, Spacing } from '@/constants/theme';
import { t } from '@/i18n';
import type { I18nKey } from '@/i18n';
import { STALE_OFFER_CODES } from '@/lib/booking';
import { DECLINE_REASONS } from '@/lib/format';
import { announce } from '@/lib/motion';
import { getBookingsRepository, getDispatchRepository } from '@/repos';
import { useJobsStore } from '@/store/jobs';
import type { ProviderJobOffer } from '@hudumika/contract';

type Kind = 'nearby' | 'recommended' | 'offers' | 'quote_requests';

const KINDS: Kind[] = ['nearby', 'recommended', 'offers', 'quote_requests'];

const KIND_KEYS: Record<Kind, I18nKey> = {
  nearby: 'jobs.marketplace.kind.nearby',
  recommended: 'jobs.marketplace.kind.recommended',
  offers: 'jobs.marketplace.kind.offers',
  quote_requests: 'jobs.marketplace.kind.quote_requests',
};

export default function MarketplaceScreen() {
  const marketplace = useJobsStore((s) => s.marketplace);
  const loading = useJobsStore((s) => s.loading);
  const error = useJobsStore((s) => s.error);
  const refreshMarketplace = useJobsStore((s) => s.refreshMarketplace);

  const [kind, setKind] = useState<Kind>('nearby');
  const [refreshing, setRefreshing] = useState(false);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [notice, setNotice] = useState('');
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [selected, setSelected] = useState<ProviderJobOffer | null>(null);
  const [acceptLoading, setAcceptLoading] = useState(false);
  const [acceptError, setAcceptError] = useState('');

  const [declineVisible, setDeclineVisible] = useState(false);
  const [declineReason, setDeclineReason] = useState('');
  const [declineLoading, setDeclineLoading] = useState(false);
  const [declineError, setDeclineError] = useState('');

  useFocusEffect(
    useCallback(() => {
      refreshMarketplace(kind);
    }, [refreshMarketplace, kind]),
  );

  const showNotice = useCallback((msg: string) => {
    setNotice(msg);
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(''), 4000);
  }, []);

  const switchKind = (k: Kind) => {
    setKind(k);
    setHidden(new Set());
    setSelected(null);
    setNotice('');
  };

  const hideOffer = useCallback((bookingId: string) => {
    setHidden((prev) => new Set(prev).add(bookingId));
  }, []);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await refreshMarketplace(kind);
    setRefreshing(false);
  }, [refreshMarketplace, kind]);

  // Hoisted renderItem (M6 perf) — no inline list render functions.
  const renderJob = useCallback(
    ({ item }: { item: ProviderJobOffer }) => (
      <OfferCard
        offer={item}
        onPress={() => {
          setSelected(item);
          setAcceptError('');
          setDeclineReason('');
          setDeclineError('');
        }}
        onExpire={
          kind === 'offers'
            ? () => {
                hideOffer(item.bookingId);
                announce(t('jobs.announceExpired'));
                showNotice(t('booking.offerExpired'));
              }
            : undefined
        }
      />
    ),
    [hideOffer, kind],
  );

  const onAccept = async () => {
    if (!selected) return;
    setAcceptLoading(true);
    setAcceptError('');
    try {
      await getDispatchRepository().acceptOffer(selected.bookingId);
      router.replace(`/jobs/${selected.bookingId}`);
    } catch (e) {
      const err = e instanceof ApiError ? e : null;
      if (err && (STALE_OFFER_CODES as readonly string[]).includes(err.code)) {
        hideOffer(selected.bookingId);
        setSelected(null);
        showNotice(t('booking.offerExpired'));
      } else {
        setAcceptError(err ? err.message : t('misc.error'));
      }
    } finally {
      setAcceptLoading(false);
    }
  };

  const onDecline = async () => {
    if (!selected) return;
    setDeclineLoading(true);
    setDeclineError('');
    try {
      await getBookingsRepository().decline(selected.bookingId, declineReason.trim() || undefined);
      hideOffer(selected.bookingId);
      setSelected(null);
      setDeclineVisible(false);
    } catch (e) {
      const err = e instanceof ApiError ? e : null;
      if (err?.status === 409) {
        hideOffer(selected.bookingId);
        setSelected(null);
        setDeclineVisible(false);
        showNotice(err.message);
      } else {
        setDeclineError(err ? err.message : t('misc.error'));
      }
    } finally {
      setDeclineLoading(false);
    }
  };

  const jobs = marketplace.filter((j) => !hidden.has(j.bookingId));

  return (
    <Screen>
      <View style={styles.segmentWrap}>
        <Segmented
          options={KINDS.map((k) => ({ key: k, label: t(KIND_KEYS[k]) }))}
          value={kind}
          onChange={switchKind}
        />
      </View>

      <FlatList
        data={jobs}
        keyExtractor={(j) => j.bookingId}
        contentContainerStyle={styles.list}
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={Colors.primary} />}
        ListHeaderComponent={
          <View style={{ gap: Spacing.sm, marginBottom: Spacing.sm }}>
            {notice ? (
              <View style={styles.noticeBox}>
                <Icon name="information-circle" size={14} color={Colors.warning} />
                <Text style={styles.noticeText}>{notice}</Text>
              </View>
            ) : null}
            <Card flat style={styles.hint}>
              <Icon name="location" size={16} color={Colors.primaryDeep} />
              <Text style={styles.hintText}>We find jobs near your service area</Text>
            </Card>
          </View>
        }
        ListEmptyComponent={
          loading && !refreshing ? (
            <View style={styles.center}>
              <ActivityIndicator color={Colors.primary} />
            </View>
          ) : error && jobs.length === 0 ? (
            <ErrorCard message={error} onRetry={() => refreshMarketplace(kind)} />
          ) : (
            <Empty icon="search-outline" title={t('jobs.marketplace.none')} sub={t('jobs.marketplace.noneSub')} />
          )
        }
        renderItem={renderJob}
      />

      {/* Accept sheet */}
      <SheetModal visible={!!selected} onClose={() => setSelected(null)} title={t('jobs.accept')}>
        {selected ? (
          <>
            <Text style={styles.sheetTitle}>{selected.trade ?? t('booking.trade')}</Text>
            {selected.summary ? <Text style={styles.sheetSummary}>{selected.summary}</Text> : null}
            <Row gap={Spacing.sm} style={{ flexWrap: 'wrap' }}>
              {selected.matchScore != null ? (
                <View style={styles.matchBox}>
                  <Text style={styles.matchLabel}>{t('jobs.match')}</Text>
                  <Text style={styles.matchValue}>{Math.round(selected.matchScore * 100)}%</Text>
                </View>
              ) : null}
              {selected.expiresAt ? (
                <CountdownPill
                  expiresAt={selected.expiresAt}
                  onExpire={() => {
                    hideOffer(selected.bookingId);
                    setSelected(null);
                    showNotice(t('booking.offerExpired'));
                  }}
                />
              ) : null}
            </Row>
            {acceptError ? <Text style={styles.error}>{acceptError}</Text> : null}
            <Btn label={t('jobs.accept')} icon="checkmark" onPress={onAccept} loading={acceptLoading} size="lg" />
            <Btn
              label={t('jobs.decline')}
              variant="ghost"
              onPress={() => {
                setDeclineVisible(true);
                setDeclineReason('');
                setDeclineError('');
              }}
              disabled={acceptLoading}
            />
          </>
        ) : null}
      </SheetModal>

      {/* Decline sheet */}
      <SheetModal visible={declineVisible} onClose={() => setDeclineVisible(false)} title={t('jobs.decline')}>
        <Text style={styles.sheetSub}>{t('jobs.declinedSub')}</Text>
        {DECLINE_REASONS.map((r) => (
          <Pressable
            key={r}
            onPress={() => setDeclineReason(r)}
            accessibilityRole="button"
            accessibilityLabel={r}
            style={({ pressed }) => [styles.reasonRow, declineReason === r && styles.reasonRowActive, pressed && { opacity: 0.7 }]}>
            <Text style={styles.reasonText}>{r}</Text>
            {declineReason === r ? <Icon name="checkmark-circle" size={16} color={Colors.primaryDeep} /> : null}
          </Pressable>
        ))}
        <Field
          label={`${t('booking.declineReason')} (${t('misc.optional')})`}
          value={declineReason}
          onChangeText={setDeclineReason}
          maxLength={500}
          hint={t('booking.declineReasonMax')}
        />
        {declineError ? <Text style={styles.error}>{declineError}</Text> : null}
        <Btn label={t('jobs.decline')} variant="danger" onPress={onDecline} loading={declineLoading} size="lg" />
        <Btn label={t('misc.cancel')} variant="ghost" onPress={() => setDeclineVisible(false)} disabled={declineLoading} />
      </SheetModal>
    </Screen>
  );
}

const styles = StyleSheet.create({
  segmentWrap: { padding: Spacing.md, paddingBottom: Spacing.sm, backgroundColor: Colors.bg },
  list: { padding: Spacing.lg, paddingTop: Spacing.sm, paddingBottom: 120, gap: Spacing.md },
  center: { alignItems: 'center', paddingVertical: 80 },
  error: { color: Colors.danger, fontSize: FontSize.sm },
  noticeBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    backgroundColor: Colors.warningSoft,
    borderRadius: Radius.sm,
    padding: Spacing.sm,
  },
  noticeText: { flex: 1, color: Colors.warning, fontSize: FontSize.xs, fontWeight: '700' },
  hint: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    backgroundColor: Colors.primarySoft,
    borderWidth: 0,
  },
  hintText: { flex: 1, color: Colors.primaryDeep, fontSize: FontSize.sm, fontWeight: '600' },
  sheetTitle: { fontSize: FontSize.lg, fontWeight: '800', color: Colors.text },
  sheetSummary: { fontSize: FontSize.sm, color: Colors.textSecondary, lineHeight: 18 },
  sheetSub: { color: Colors.textSecondary, fontSize: FontSize.sm, textAlign: 'center', lineHeight: 19 },
  matchBox: { alignItems: 'center', backgroundColor: Colors.primarySoft, borderRadius: 12, paddingHorizontal: Spacing.md, paddingVertical: Spacing.sm },
  matchLabel: { fontSize: FontSize.xs, color: Colors.primaryDeep, fontWeight: '700' },
  matchValue: { fontSize: FontSize.lg, color: Colors.primaryDeep, fontWeight: '800', fontVariant: NumberStyle.fontVariant },
  reasonRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: Colors.surface,
    borderRadius: Radius.sm,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.md,
    borderWidth: 1,
    borderColor: 'transparent',
  },
  reasonRowActive: { borderColor: Colors.primary, backgroundColor: Colors.primarySoft },
  reasonText: { color: Colors.text, fontSize: FontSize.sm, fontWeight: '500' },
});
