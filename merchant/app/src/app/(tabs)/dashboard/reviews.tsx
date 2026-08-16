import { useEffect, useState, useSyncExternalStore } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { t, onLocaleChange, type I18nKey } from '@/i18n';
import { api } from '@/api/client';
import type { ReviewAnalytics, ReviewDto } from '@/api/types';
import { Avatar, Btn, Card, Chip, Divider, Empty, Icon, Row, Screen, Segmented, SheetModal, Stars } from '@/components/ui';
import { Colors, FontSize, NumberStyle, Radius, Spacing } from '@/constants/theme';
import { timeAgo } from '@/lib/format';
import { useReviewStore } from '@/store/reviews';
import type { Review } from '@/types';

type Filter = 'all' | 'positive' | 'toReply';
type PlatformFilter = 'all' | 'meituan' | 'dianping';

const PLATFORM_KEYS: Exclude<PlatformFilter, 'all'>[] = ['meituan', 'dianping'];

const PLATFORM_LABEL: Record<PlatformFilter, I18nKey> = {
  all: 'rev.all',
  meituan: 'rev.meituan',
  dianping: 'rev.dianping',
};

const platformOf = (r: Review): Exclude<PlatformFilter, 'all'> => (r as ReviewDto).platform ?? 'meituan';

export default function ReviewsScreen() {
  useSyncExternalStore(onLocaleChange, () => 0);
  const reviews = useReviewStore((s) => s.reviews);
  const reported = useReviewStore((s) => s.reported);
  const reply = useReviewStore((s) => s.reply);
  const editReply = useReviewStore((s) => s.editReply);
  const removeReply = useReviewStore((s) => s.removeReply);
  const updateReview = useReviewStore((s) => s.updateReview);
  const report = useReviewStore((s) => s.report);
  const hydrate = useReviewStore((s) => s.hydrate);

  useEffect(() => {
    hydrate();
  }, [hydrate]);

  const [filter, setFilter] = useState<Filter>('all');
  const [platform, setPlatform] = useState<PlatformFilter>('all');
  const [analytics, setAnalytics] = useState<ReviewAnalytics | null>(null);
  const [target, setTarget] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [showReply, setShowReply] = useState(false);
  const [showReport, setShowReport] = useState(false);
  const [reportReason, setReportReason] = useState('');
  const [reportBusy, setReportBusy] = useState(false);
  const [reportError, setReportError] = useState('');
  const [reportDone, setReportDone] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const a = await api.get<ReviewAnalytics>('/analytics/reviews');
        if (alive) setAnalytics(a);
      } catch {
        if (alive) setAnalytics(null);
      }
    };
    load();
    return () => {
      alive = false;
    };
  }, []);

  const filtered = reviews.filter((r) => {
    if (platform !== 'all' && platformOf(r) !== platform) return false;
    if (filter === 'positive') return r.rating >= 4;
    if (filter === 'toReply') return r.rating <= 2 && !r.reply;
    return true;
  });

  const openReply = (id: string) => {
    setTarget(id);
    const review = reviews.find((r) => r.id === id);
    setText(review?.reply ?? '');
    setShowReply(true);
  };

  const isEditing = target ? !!reviews.find((r) => r.id === target)?.reply : false;

  const submit = () => {
    if (!target || !text.trim()) return;
    const action = isEditing ? editReply : reply;
    action(target, text.trim());
    setShowReply(false);
    setTarget(null);
    setText('');
  };

  const remove = () => {
    if (!target) return;
    removeReply(target);
    setShowReply(false);
    setTarget(null);
    setText('');
  };

  /* P6: contract PATCH /reviews/{reviewId} — visibility toggle (state hidden|published). */
  const toggleVisibility = (id: string) => {
    const review = reviews.find((r) => r.id === id);
    const state = (review as ReviewDto).state ?? 'published';
    updateReview(id, { state: state === 'hidden' ? 'published' : 'hidden' });
  };

  /* MESSAGES.md §Reviews — report abusive reviews (POST /reviews/{id}/report). */
  const openReport = (id: string) => {
    setTarget(id);
    setReportReason('');
    setReportError('');
    setReportDone(false);
    setShowReport(true);
  };

  const submitReport = async () => {
    if (!target || !reportReason.trim()) return;
    setReportBusy(true);
    setReportError('');
    try {
      await report(target, reportReason.trim());
      setReportDone(true);
    } catch (e) {
      setReportError(e instanceof Error ? e.message : t('rev.reportError'));
    } finally {
      setReportBusy(false);
    }
  };

  const distribution = analytics ? [...analytics.distribution].reverse() : [];

  return (
    <Screen scroll>
      {analytics ? (
        <Card style={{ gap: Spacing.md, marginBottom: Spacing.lg }}>
          <Row style={{ justifyContent: 'space-between', alignItems: 'flex-end' }}>
            <View>
              <Text style={styles.analyticsLabel}>{t('rev.avg')}</Text>
              <Row gap={6} style={{ alignItems: 'baseline' }}>
                <Text style={styles.analyticsValue}>{analytics.avgRating.toFixed(1)}</Text>
                <Text style={styles.analyticsSub}>{t('rev.total', { total: analytics.total })}</Text>
              </Row>
            </View>
            <Row gap={Spacing.xl}>
              <View style={{ alignItems: 'center' }}>
                <Text style={styles.analyticsStat}>{analytics.praiseRate.toFixed(1)}%</Text>
                <Text style={styles.analyticsStatLabel}>{t('rev.praise')}</Text>
              </View>
              <View style={{ alignItems: 'center' }}>
                <Text style={styles.analyticsStat}>{analytics.replyRate.toFixed(1)}%</Text>
                <Text style={styles.analyticsStatLabel}>{t('rev.replied')}</Text>
              </View>
            </Row>
          </Row>
          <Divider />
          <View style={{ gap: Spacing.sm }}>
            {distribution.map((d) => (
              <Row key={d.rating} gap={Spacing.sm}>
                <Text style={styles.barLabel}>{d.rating}</Text>
                <View style={styles.barTrack}>
                  <View
                    style={[
                      styles.barFill,
                      { width: `${Math.round((analytics.total ? d.count / analytics.total : 0) * 100)}%` },
                    ]}
                  />
                </View>
                <Text style={styles.barCount}>{d.count}</Text>
              </Row>
            ))}
          </View>
          <Text style={styles.analyticsPlatforms}>
            {PLATFORM_KEYS.map((key) => {
              const s = analytics.byPlatform[key];
              return `${t(PLATFORM_LABEL[key])} ${s.total} · ${t('rev.avg')} ${s.avgRating.toFixed(1)} · ${t('rev.praise')} ${s.praiseRate.toFixed(1)}%`;
            }).join('   |   ')}
          </Text>
        </Card>
      ) : null}

      <Segmented
        value={filter}
        onChange={setFilter}
        options={[
          { key: 'all', label: t('rev.all'), count: reviews.length },
          { key: 'positive', label: t('rev.positive'), count: reviews.filter((r) => r.rating >= 4).length },
          { key: 'toReply', label: t('rev.toReply'), count: reviews.filter((r) => r.rating <= 2 && !r.reply).length },
        ]}
      />

      <Row style={{ gap: Spacing.sm, marginTop: Spacing.md }}>
        {(['all', 'meituan', 'dianping'] as PlatformFilter[]).map((p) => (
          <Chip
            key={p}
            label={PLATFORM_LABEL[p]}
            selected={platform === p}
            onPress={() => setPlatform(p)}
            count={p === 'all' ? reviews.length : reviews.filter((r) => platformOf(r) === p).length}
          />
        ))}
      </Row>

      <View style={{ marginTop: Spacing.lg, gap: Spacing.md }}>
        {filtered.length === 0 ? <Empty icon="chatbubble-ellipses-outline" title={t('rev.empty')} /> : null}
        {filtered.map((r) => (
          <Card key={r.id} style={{ gap: Spacing.md }}>
            <Row style={{ justifyContent: 'space-between' }}>
              <Row gap={10}>
                <Avatar name={r.customer} size={36} />
                <View>
                  <Text style={{ fontSize: FontSize.sm, fontWeight: '700', color: Colors.text }} numberOfLines={1}>
                    {r.customer}
                  </Text>
                  <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary }}>
                    {r.orderNo} · {timeAgo(r.ts)} · {PLATFORM_LABEL[platformOf(r)]}
                  </Text>
                </View>
              </Row>
              <Stars rating={r.rating} />
            </Row>
            <Text style={{ fontSize: FontSize.md, color: Colors.text, lineHeight: 22 }}>{r.content}</Text>
            {r.reply ? (
              <Pressable onPress={() => openReply(r.id)}>
                <View style={styles.replyBox}>
                  <Text style={{ fontSize: FontSize.xs, color: Colors.success, fontWeight: '700' }}>{t('rev.storeReply')}</Text>
                  <Text style={{ fontSize: FontSize.sm, color: Colors.textSecondary, marginTop: 3 }}>{r.reply}</Text>
                </View>
              </Pressable>
            ) : (
              <Row style={{ justifyContent: 'flex-end' }}>
                <Btn
                  label={r.rating <= 2 ? t('rev.replyNow') : t('rev.reply')}
                  variant={r.rating <= 2 ? 'danger' : 'ghost'}
                  size="sm"
                  onPress={() => openReply(r.id)}
                  style={{ paddingHorizontal: 18 }}
                />
              </Row>
            )}
            <Row style={{ justifyContent: 'space-between', alignItems: 'center' }}>
              <Pressable
                onPress={() => toggleVisibility(r.id)}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel={t((r as ReviewDto).state === 'hidden' ? 'rev.show' : 'rev.hide')}>
                <Text style={{ fontSize: FontSize.xs, color: (r as ReviewDto).state === 'hidden' ? Colors.info : Colors.textTertiary, fontWeight: '700' }}>
                  {(r as ReviewDto).state === 'hidden' ? t('rev.show') : t('rev.hide')}
                </Text>
              </Pressable>
              <Row gap={12}>
                {reported[r.id] ? (
                  <Text style={{ fontSize: FontSize.xs, color: Colors.success, fontWeight: '700' }}>{t('rev.reported')}</Text>
                ) : (
                  <Pressable
                    onPress={() => openReport(r.id)}
                    hitSlop={8}
                    accessibilityRole="button"
                    accessibilityLabel={t('rev.report')}>
                    <Text style={{ fontSize: FontSize.xs, color: Colors.danger, fontWeight: '700' }}>{t('rev.report')}</Text>
                  </Pressable>
                )}
                <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary }}>{t('rev.visibility')}</Text>
              </Row>
            </Row>
          </Card>
        ))}
      </View>

      <SheetModal visible={showReply} onClose={() => setShowReply(false)} title={isEditing ? t('rev.editReply') : t('rev.replyTitle')}>
        <View style={styles.replyInput}>
          <TextInput
            placeholder={t('rev.replyPh')}
            placeholderTextColor={Colors.textTertiary}
            value={text}
            onChangeText={setText}
            multiline
            maxLength={200}
            style={{ fontSize: FontSize.md, color: Colors.text, minHeight: 90 }}
          />
        </View>
        <Btn label={isEditing ? t('rev.saveReply') : t('rev.submitReply')} onPress={submit} disabled={!text.trim()} />
        {isEditing ? (
          <Pressable onPress={remove} hitSlop={8}>
            <Text style={styles.removeBtn}>{t('rev.removeReply')}</Text>
          </Pressable>
        ) : null}
        <Divider />
        <Text style={styles.formTip}>{t('rev.hint')}</Text>
      </SheetModal>

      <SheetModal visible={showReport} onClose={() => setShowReport(false)} title={t('rev.report')}>
        <View style={{ gap: Spacing.md }}>
          {reportDone ? (
            <View style={{ gap: Spacing.sm, alignItems: 'center', paddingVertical: Spacing.lg }}>
              <Icon name="checkmark-circle-outline" size={26} color={Colors.success} />
              <Text style={{ fontSize: FontSize.sm, color: Colors.textSecondary, textAlign: 'center' }}>{t('rev.reportSent')}</Text>
              <Btn label={t('common.close')} variant="outline" size="sm" onPress={() => setShowReport(false)} />
            </View>
          ) : (
            <>
              <View style={styles.replyInput}>
                <TextInput
                  placeholder={t('rev.reportPh')}
                  placeholderTextColor={Colors.textTertiary}
                  value={reportReason}
                  onChangeText={setReportReason}
                  multiline
                  maxLength={300}
                  style={{ fontSize: FontSize.md, color: Colors.text, minHeight: 90 }}
                />
              </View>
              {reportError ? <Text style={{ color: Colors.danger, fontSize: FontSize.xs }}>{reportError}</Text> : null}
              <Btn label={t('rev.report')} variant="danger" onPress={submitReport} loading={reportBusy} disabled={!reportReason.trim()} />
            </>
          )}
        </View>
      </SheetModal>
    </Screen>
  );
}

const styles = StyleSheet.create({
  analyticsLabel: { fontSize: FontSize.xs, color: Colors.textTertiary, fontWeight: '600' },
  analyticsValue: { fontSize: FontSize.xxl, fontWeight: '800', color: Colors.text, fontVariant: NumberStyle.fontVariant },
  analyticsSub: { fontSize: FontSize.sm, color: Colors.textTertiary, fontWeight: '500' },
  analyticsStat: { fontSize: FontSize.lg, fontWeight: '800', color: Colors.text, fontVariant: NumberStyle.fontVariant },
  analyticsStatLabel: { fontSize: FontSize.xs, color: Colors.textTertiary, marginTop: 2 },
  analyticsPlatforms: { fontSize: FontSize.xs, color: Colors.textSecondary, textAlign: 'center', lineHeight: 16 },
  barLabel: { width: 14, fontSize: FontSize.xs, color: Colors.textSecondary, fontWeight: '600', textAlign: 'center' },
  barTrack: { flex: 1, height: 8, borderRadius: 4, backgroundColor: Colors.surface, overflow: 'hidden' },
  barFill: { height: '100%', borderRadius: 4, backgroundColor: Colors.primary },
  barCount: { width: 22, fontSize: FontSize.xs, color: Colors.textTertiary, fontVariant: NumberStyle.fontVariant },
  replyBox: {
    backgroundColor: Colors.successSoft,
    borderRadius: Radius.sm,
    padding: Spacing.md,
    gap: 4,
  },
  replyInput: {
    minHeight: 110,
    borderRadius: Radius.md,
    backgroundColor: Colors.surface,
    padding: Spacing.md,
  },
  removeBtn: { color: Colors.danger, fontSize: FontSize.sm, fontWeight: '600', textAlign: 'center', paddingVertical: Spacing.xs },
  formTip: { fontSize: FontSize.xs, color: Colors.textTertiary, textAlign: 'center', lineHeight: 16 },
});
