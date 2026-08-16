/* My reviews — GET /reviews/me (own reviews incl. the pending moderation
 * state), with state chips, edit /review?reviewId=…, delete confirm sheet,
 * report sheet (presets + free text) and helpful thumbs on published reviews.
 * Loading / empty / error / retry states per REVIEWS.md per-screen contract. */
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import {
  Btn,
  Card,
  Chip,
  Divider,
  EmptyState,
  ErrorState,
  Field,
  Pill,
  Row,
  Screen,
  SheetModal,
  SkeletonCard,
  Stars,
} from '@/components/ui';
import { Colors, Fonts, FontSize, Radius, Spacing } from '@/constants/theme';
import { t, type Key } from '@/i18n';
import { dateISO } from '@/lib/dates';
import { idempotencyKey } from '@/lib/idempotency';
import { toast } from '@/store/ui';
import { getMerchantsRepository, getProvidersRepository, getReviewsRepository } from '@/repos';
import { useSessionStore } from '@/store/session';
import type { Review, ReviewReply, VoteReviewHelpful200 } from '@hudumika/contract';
import { ApiError } from '@/api/client';

const REPORT_PRESETS = ['spam', 'offensive', 'misleading', 'fake'] as const;

/** Mock-only display extensions on the Review DTO (repos/mock/reviews.ts).
 * The contract Review has no verified flag and no merchant reply — the live
 * wire never carries them (docs/CONTRACT-ADDITIONS.md #15/#18), so the badge
 * and reply render ONLY when the data exists. */
type ReviewWithSocial = Review & { verified?: boolean; reply?: ReviewReply };

const REPORT_PRESET_KEYS: Record<(typeof REPORT_PRESETS)[number], Key> = {
  spam: 'reviews.reportPreset.spam',
  offensive: 'reviews.reportPreset.offensive',
  misleading: 'reviews.reportPreset.misleading',
  fake: 'reviews.reportPreset.fake',
};

export default function ReviewsScreen() {
  const router = useRouter();
  const user = useSessionStore((s) => s.user);
  const [reviews, setReviews] = useState<Review[] | null>(null);
  const [error, setError] = useState('');
  const [targetNames, setTargetNames] = useState<Record<string, string>>({});
  const [votes, setVotes] = useState<Record<string, VoteReviewHelpful200>>({});
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [reportId, setReportId] = useState<string | null>(null);
  const [reportPreset, setReportPreset] = useState('');
  const [reportText, setReportText] = useState('');
  const [reportError, setReportError] = useState('');
  const [reporting, setReporting] = useState(false);
  const [notReportable, setNotReportable] = useState<Record<string, boolean>>({});

  const load = useCallback(async () => {
    setError('');
    try {
      const list = (await getReviewsRepository().listMine()) as ReviewWithSocial[];
      setReviews(list);
      const names: Record<string, string> = {};
      await Promise.all(
        list.map(async (r) => {
          try {
            if (r.targetType === 'merchant') names[r.targetId] = (await getMerchantsRepository().get(r.targetId)).businessName;
            else if (r.targetType === 'provider') names[r.targetId] = (await getProvidersRepository().get(r.targetId)).name;
          } catch {
            /* best-effort — the list falls back to the raw targetId */
          }
        }),
      );
      setTargetNames(names);
    } catch {
      setError(t('common.error'));
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const voteHelpful = async (reviewId: string, helpful: boolean) => {
    try {
      const next = await getReviewsRepository().helpful(reviewId, helpful, idempotencyKey(user?.id ?? 'customer', 'review.helpful'));
      setVotes((v) => ({ ...v, [reviewId]: next }));
    } catch {
      toast(t('common.error'), 'error');
    }
  };

  const confirmDelete = async () => {
    if (!deleteId) return;
    setDeleting(true);
    try {
      await getReviewsRepository().remove(deleteId, idempotencyKey(user?.id ?? 'customer', 'review.delete'));
      toast(t('reviews.deletedToast'));
      setDeleteId(null);
      load();
    } catch {
      toast(t('common.error'), 'error');
    } finally {
      setDeleting(false);
    }
  };

  const openReport = (reviewId: string) => {
    setReportId(reviewId);
    setReportPreset('');
    setReportText('');
    setReportError('');
  };

  const submitReport = async () => {
    if (!reportId) return;
    const reason = [reportPreset ? t(REPORT_PRESET_KEYS[reportPreset as (typeof REPORT_PRESETS)[number]]) : '', reportText.trim()].filter(Boolean).join(' — ').slice(0, 300);
    if (!reason) {
      setReportError(t('reviews.reportRequired'));
      return;
    }
    setReporting(true);
    try {
      await getReviewsRepository().report(reportId, reason, idempotencyKey(user?.id ?? 'customer', 'review.report'));
      toast(t('reviews.reported'));
      setReportId(null);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'REVIEW_NOT_REPORTABLE') {
        setNotReportable((m) => ({ ...m, [reportId]: true }));
        setReportId(null);
        toast(t('reviews.notReportable'), 'error');
      } else {
        setReportError(t('common.error'));
      }
    } finally {
      setReporting(false);
    }
  };

  if (error) {
    return (
      <Screen>
        <ErrorState message={error} onRetry={load} />
      </Screen>
    );
  }

  if (!reviews) {
    return (
      <Screen>
        <SkeletonCard rows={4} />
      </Screen>
    );
  }

  if (reviews.length === 0) {
    return (
      <Screen>
        <EmptyState icon="star-outline" title={t('reviews.empty')} />
      </Screen>
    );
  }

  const stateChip = (state: Review['state']) => {
    switch (state) {
      case 'pending':
        return <Pill label={t('reviews.pending')} tone="warning" />;
      case 'published':
        return <Pill label={t('reviews.published')} tone="success" />;
      case 'hidden':
        return <Pill label={t('reviews.hidden')} tone="danger" />;
      case 'deleted':
        return <Pill label={t('reviews.deleted')} tone="neutral" />;
    }
  };

  return (
    <Screen scroll>
      {reviews.map((r) => {
        const social = r as ReviewWithSocial;
        const name = targetNames[r.targetId] ?? r.targetId;
        const vote = votes[r.id];
        const own = r.authorName === user?.fullName;
        const editable = own && (r.state === 'published' || r.state === 'pending');
        return (
          <Card key={r.id} style={{ gap: Spacing.sm, marginBottom: Spacing.md }}>
            <Row style={{ justifyContent: 'space-between' }}>
              <Text style={styles.name} numberOfLines={1}>{name}</Text>
              <Row gap={Spacing.sm}>
                {r.state === 'published' && social.verified === true ? <Pill label={t('reviews.verifiedPurchase')} tone="success" /> : null}
                {stateChip(r.state)}
              </Row>
            </Row>
            <Row style={{ justifyContent: 'space-between' }}>
              <Stars rating={r.rating} size={14} />
              <Text style={styles.date}>{dateISO(r.createdAt)}</Text>
            </Row>
            {r.body ? <Text style={styles.body}>{r.body}</Text> : null}
            {social.reply && r.state === 'published' ? (
              <View style={styles.replyBox}>
                <Text style={styles.replyLabel}>{t('reviews.merchantReply')}</Text>
                <Text style={styles.replyBody}>{social.reply.body}</Text>
              </View>
            ) : null}
            <Divider />
            <Row style={{ justifyContent: 'space-between' }}>
              <Row gap={Spacing.sm}>
                {editable ? (
                  <>
                    <Btn
                      label={t('reviews.edit')}
                      icon="create-outline"
                      variant="subtle"
                      size="sm"
                      onPress={() => router.push({ pathname: '/review', params: { reviewId: r.id } })}
                    />
                    <Btn label={t('reviews.delete')} icon="trash-outline" variant="subtle" size="sm" onPress={() => setDeleteId(r.id)} />
                  </>
                ) : null}
              </Row>
              {r.state === 'published' ? (
                <Row gap={Spacing.sm}>
                  <Btn
                    label={String(vote?.helpfulCount ?? 0)}
                    icon={vote?.myVote === true ? 'thumbs-up' : 'thumbs-up-outline'}
                    variant={vote?.myVote === true ? 'ghost' : 'subtle'}
                    size="sm"
                    onPress={() => voteHelpful(r.id, true)}
                  />
                  <Btn
                    label={String(vote?.notHelpfulCount ?? 0)}
                    icon={vote?.myVote === false ? 'thumbs-down' : 'thumbs-down-outline'}
                    variant={vote?.myVote === false ? 'ghost' : 'subtle'}
                    size="sm"
                    onPress={() => voteHelpful(r.id, false)}
                  />
                  {notReportable[r.id] ? null : (
                    <Btn label={t('reviews.report')} icon="flag-outline" variant="subtle" size="sm" onPress={() => openReport(r.id)} />
                  )}
                </Row>
              ) : null}
            </Row>
          </Card>
        );
      })}

      <SheetModal visible={deleteId !== null} onClose={() => setDeleteId(null)} title={t('reviews.deleteConfirm')}>
        <Text style={styles.sheetSub}>{t('reviews.deleteConfirmSub')}</Text>
        <Btn label={t('reviews.delete')} onPress={confirmDelete} loading={deleting} variant="danger" />
      </SheetModal>

      <SheetModal visible={reportId !== null} onClose={() => setReportId(null)} title={t('reviews.reportTitle')}>
        <Text style={styles.sheetSub}>{t('reviews.reportReason')}</Text>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.sm }}>
          {REPORT_PRESETS.map((p) => (
            <Chip key={p} label={t(REPORT_PRESET_KEYS[p])} selected={reportPreset === p} onPress={() => setReportPreset(reportPreset === p ? '' : p)} />
          ))}
        </View>
        <Field label={t('reviews.reportPlaceholder')} value={reportText} onChangeText={setReportText} multiline maxLength={300} />
        {reportError ? <Text style={styles.errorText}>{reportError}</Text> : null}
        <Btn label={t('reviews.reportSubmit')} onPress={submitReport} loading={reporting} />
      </SheetModal>
    </Screen>
  );
}

const styles = StyleSheet.create({
  name: { fontSize: FontSize.md, fontFamily: Fonts.sansBold, color: Colors.text, flex: 1, marginRight: Spacing.sm },
  date: { fontSize: FontSize.xs, color: Colors.textFaint, fontFamily: Fonts.sans },
  body: { fontSize: FontSize.sm, color: Colors.textSecondary, fontFamily: Fonts.sans, lineHeight: 18 },
  replyBox: {
    backgroundColor: Colors.primarySoft,
    borderRadius: Radius.sm,
    padding: Spacing.sm,
    gap: 2,
  },
  replyLabel: { fontSize: FontSize.xs, color: Colors.primaryDeep, fontFamily: Fonts.sansBold, textTransform: 'uppercase' },
  replyBody: { fontSize: FontSize.sm, color: Colors.textSecondary, fontFamily: Fonts.sans, lineHeight: 18 },
  sheetSub: { fontSize: FontSize.sm, color: Colors.textTertiary, fontFamily: Fonts.sans },
  errorText: { fontSize: FontSize.sm, color: Colors.danger, fontFamily: Fonts.sansMedium },
});
