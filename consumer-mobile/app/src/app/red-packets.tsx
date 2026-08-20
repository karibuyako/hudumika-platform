/* Red packets (P6c) — received claimable packets + promotional share flow.
 * Mock-only until the contract ships the red-packet resource
 * (docs/CONTRACT-ADDITIONS.md #12): packets are promotional (platform-funded,
 * never wallet-funded); claiming credits the wallet balance like a top-up;
 * share links are hudumika://red-packet/{shareCode} (deep-link allow-list,
 * maps to /red-packets — the screen refetches on mount, no id param read). */
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Platform, Pressable, Share, StyleSheet, Text, View } from 'react-native';

import { Btn, Card, EmptyState, ErrorState, Field, Icon, Pill, Row, Screen, SheetModal, SkeletonCard } from '@/components/ui';
import { Colors, Fonts, FontSize, Radius, Spacing } from '@/constants/theme';
import { t } from '@/i18n';
import { ApiError } from '@/api/client';
import { getRedPacketRepository } from '@/repos';
import type { RedPacket } from '@/repos';
import { toast } from '@/store/ui';
import { useSessionStore } from '@/store/session';
import { dateISO } from '@/lib/dates';
import { formatTZS } from '@/lib/format';
import { idempotencyKey } from '@/lib/idempotency';

const AMOUNT_PRESETS = [2000, 5000, 10000];
const COUNT_PRESETS = [1, 2, 3, 4, 5];
const EXPIRY_PRESETS = [
  { label: '24h', hours: 24 },
  { label: '48h', hours: 48 },
  { label: '7d', hours: 168 },
];

export default function RedPacketsScreen() {
  const router = useRouter();
  const [packets, setPackets] = useState<RedPacket[] | null>(null);
  const [error, setError] = useState('');
  const [claimingId, setClaimingId] = useState<string | null>(null);

  // Create-packet sheet
  const [createOpen, setCreateOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [amountTZS, setAmountTZS] = useState(5000);
  const [count, setCount] = useState(3);
  const [expiresInHours, setExpiresInHours] = useState(48);
  const [creating, setCreating] = useState(false);
  const [formError, setFormError] = useState('');

  // Share sheet (post-create)
  const [shared, setShared] = useState<RedPacket | null>(null);

  const load = useCallback(async () => {
    setError('');
    try {
      setPackets(await getRedPacketRepository().listReceived());
    } catch {
      setError(t('common.error'));
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const claim = async (packet: RedPacket) => {
    if (claimingId) return;
    setClaimingId(packet.id);
    try {
      const user = useSessionStore.getState().user;
      const key = idempotencyKey(user?.id ?? 'customer', 'red-packet-claim');
      const result = await getRedPacketRepository().claim(packet.id, key);
      toast(t('redPackets.credited', { amount: formatTZS(result.creditedTZS) }));
    } catch (e) {
      // COUPON-style per-code handling: known codes get specific copy.
      if (e instanceof ApiError && e.code === 'CONFLICT') {
        toast(t('redPackets.claimed'), 'info');
      } else if (e instanceof ApiError && e.code === 'VALIDATION_FAILED') {
        toast(t('redPackets.expired'), 'error');
      } else {
        toast(t('common.error'), 'error');
      }
    } finally {
      setClaimingId(null);
      load();
    }
  };

  const createSharePacket = async () => {
    if (!Number.isInteger(amountTZS) || amountTZS < 1) {
      setFormError(t('redPackets.needAmount'));
      return;
    }
    setCreating(true);
    setFormError('');
    try {
      const user = useSessionStore.getState().user;
      const key = idempotencyKey(user?.id ?? 'customer', 'red-packet-share');
      const packet = await getRedPacketRepository().createSharePacket(
        { title: title.trim() || undefined, amountTZS, count, expiresInHours },
        key,
      );
      setCreateOpen(false);
      setTitle('');
      setAmountTZS(5000);
      setCount(3);
      setExpiresInHours(48);
      setShared(packet);
      toast(t('redPackets.created'));
      load();
    } catch (e) {
      setFormError(e instanceof ApiError ? e.message : t('common.error'));
    } finally {
      setCreating(false);
    }
  };

  const shareLink = shared?.shareCode ? `hudumika://red-packet/${shared.shareCode}` : '';

  const shareNow = async () => {
    if (!shareLink || Platform.OS === 'web') return;
    try {
      await Share.share({ message: shareLink, url: shareLink });
    } catch {
      // Share dismissed or unsupported — the link stays selectable in the sheet.
    }
  };

  const copyLink = async () => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(shareLink);
        toast(t('redPackets.copied'));
      }
    } catch {
      /* clipboard unavailable — the link text is selectable */
    }
  };

  const now = Date.now();
  const isClaimable = (p: RedPacket) => !p.claimed && new Date(p.expiresAt).getTime() > now;

  return (
    <Screen scroll>
      <View style={{ paddingHorizontal: Spacing.lg, paddingTop: Spacing.lg }}>
        <Row style={{ justifyContent: 'space-between', marginBottom: Spacing.md }}>
          <Btn label={t('common.back')} onPress={() => router.back()} variant="subtle" size="sm" icon="arrow-back" />
          <Text style={styles.title}>{t('redPackets.title')}</Text>
          <Btn label={t('redPackets.share')} onPress={() => setCreateOpen(true)} variant="ghost" size="sm" icon="paper-plane" />
        </Row>
      </View>
      {error ? (
        <ErrorState message={error} onRetry={load} />
      ) : !packets ? (
        <View style={{ gap: Spacing.md, padding: Spacing.lg }}>
          <SkeletonCard rows={2} />
          <SkeletonCard rows={2} />
        </View>
      ) : packets.length === 0 ? (
        <EmptyState icon="gift-outline" title={t('redPackets.empty')} sub={t('redPackets.emptySub')} />
      ) : (
        <View style={{ padding: Spacing.lg, gap: Spacing.md }}>
          {packets.map((p) => {
            const claimable = isClaimable(p);
            const expired = new Date(p.expiresAt).getTime() <= now;
            return (
              <Card key={p.id} style={[styles.packetCard, { opacity: p.claimed || expired ? 0.55 : 1 }]} flat>
                <Row gap={Spacing.md}>
                  <View style={styles.packetIcon}>
                    <Icon name="gift" size={18} color={Colors.gold} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.packetTitle} numberOfLines={1}>{p.title}</Text>
                    <Text style={styles.packetMeta}>{formatTZS(p.totalTZS)}</Text>
                    <Text style={styles.packetMeta}>{t('coupons.validUntil', { t: dateISO(p.expiresAt) })}</Text>
                    <Row gap={Spacing.sm} style={{ marginTop: Spacing.sm }}>
                      {p.claimed ? (
                        <Pill label={t('redPackets.claimed')} tone="success" />
                      ) : expired ? (
                        <Pill label={t('redPackets.expired')} tone="neutral" />
                      ) : (
                        <Pill label={t('redPackets.claimsLeft', { n: p.count - p.claimedCount })} tone="info" />
                      )}
                    </Row>
                  </View>
                  {claimable ? (
                    <Btn label={t('redPackets.claim')} onPress={() => claim(p)} size="sm" loading={claimingId === p.id} />
                  ) : null}
                </Row>
              </Card>
            );
          })}
        </View>
      )}

      <SheetModal visible={createOpen} onClose={() => setCreateOpen(false)} title={t('redPackets.shareTitle')}>
        <View style={{ gap: Spacing.md }}>
          <Field label={t('redPackets.shareTitleLabel')} value={title} onChangeText={setTitle} maxLength={60} />
          <Text style={styles.sheetLabel}>{t('redPackets.shareAmount')}</Text>
          <View style={styles.chipWrap}>
            {AMOUNT_PRESETS.map((a) => (
              <Pressable
                key={a}
                onPress={() => setAmountTZS(a)}
                accessibilityRole="button"
                accessibilityState={{ selected: amountTZS === a }}
                style={[styles.choiceChip, amountTZS === a && styles.choiceSelected]}>
                <Text style={[styles.choiceText, amountTZS === a && styles.choiceSelectedText]}>{formatTZS(a)}</Text>
              </Pressable>
            ))}
          </View>
          <Text style={styles.sheetLabel}>{t('redPackets.shareCount')}</Text>
          <View style={styles.chipWrap}>
            {COUNT_PRESETS.map((c) => (
              <Pressable
                key={c}
                onPress={() => setCount(c)}
                accessibilityRole="button"
                accessibilityState={{ selected: count === c }}
                style={[styles.choiceChip, count === c && styles.choiceSelected]}>
                <Text style={[styles.choiceText, count === c && styles.choiceSelectedText]}>{c}</Text>
              </Pressable>
            ))}
          </View>
          <Text style={styles.sheetLabel}>{t('redPackets.shareExpiry')}</Text>
          <View style={styles.chipWrap}>
            {EXPIRY_PRESETS.map((e) => (
              <Pressable
                key={e.hours}
                onPress={() => setExpiresInHours(e.hours)}
                accessibilityRole="button"
                accessibilityState={{ selected: expiresInHours === e.hours }}
                style={[styles.choiceChip, expiresInHours === e.hours && styles.choiceSelected]}>
                <Text style={[styles.choiceText, expiresInHours === e.hours && styles.choiceSelectedText]}>{e.label}</Text>
              </Pressable>
            ))}
          </View>
          {formError ? <Text style={styles.error}>{formError}</Text> : null}
          <Btn label={t('redPackets.create')} onPress={createSharePacket} loading={creating} size="lg" />
        </View>
      </SheetModal>

      <SheetModal visible={!!shared} onClose={() => setShared(null)} title={t('redPackets.shareLinkLabel')}>
        {shared ? (
          <View style={{ gap: Spacing.md }}>
            <Text style={styles.packetTitle}>{shared.title}</Text>
            <Text style={styles.packetMeta}>
              {formatTZS(shared.totalTZS)} · {t('redPackets.claimsLeft', { n: shared.count - shared.claimedCount })}
            </Text>
            <View style={styles.linkBox}>
              <Text selectable style={styles.linkText}>{shareLink}</Text>
            </View>
            <Text style={styles.packetMeta}>{t('redPackets.shareLinkHint')}</Text>
            <Row style={{ gap: Spacing.md }}>
              {Platform.OS === 'web' ? (
                <Btn label={t('redPackets.copyLink')} onPress={copyLink} variant="outline" style={{ flex: 1 }} />
              ) : (
                <>
                  <Btn label={t('redPackets.shareNow')} onPress={shareNow} variant="outline" style={{ flex: 1 }} />
                  <Btn label={t('common.done')} onPress={() => setShared(null)} style={{ flex: 1 }} />
                </>
              )}
            </Row>
          </View>
        ) : null}
      </SheetModal>
    </Screen>
  );
}

const styles = StyleSheet.create({
  title: { fontSize: FontSize.lg, fontFamily: Fonts.sansBold, color: Colors.text, flex: 1, textAlign: 'center' },
  packetCard: {
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: Colors.primary,
  },
  packetIcon: {
    width: 36,
    height: 36,
    borderRadius: 12,
    backgroundColor: Colors.goldSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  packetTitle: { fontSize: FontSize.md, fontFamily: Fonts.sansSemibold, color: Colors.text },
  packetMeta: { fontSize: FontSize.xs, color: Colors.textTertiary, fontFamily: Fonts.sans, marginTop: 2 },
  sheetLabel: {
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
    fontFamily: Fonts.sansSemibold,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  chipWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.sm },
  choiceChip: {
    paddingHorizontal: Spacing.md,
    paddingVertical: 9,
    borderRadius: Radius.pill,
    borderWidth: 1,
    borderColor: Colors.borderStrong,
    backgroundColor: Colors.card,
  },
  choiceSelected: { borderColor: Colors.primary, backgroundColor: Colors.primarySoft },
  choiceText: { fontSize: FontSize.sm, color: Colors.textSecondary, fontFamily: Fonts.sansMedium },
  choiceSelectedText: { color: Colors.primaryDeep, fontFamily: Fonts.sansBold },
  error: { color: Colors.danger, fontSize: FontSize.sm, fontFamily: Fonts.sansSemibold },
  linkBox: {
    padding: Spacing.md,
    borderRadius: Radius.md,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.borderStrong,
  },
  linkText: { fontSize: FontSize.sm, color: Colors.primaryDeep, fontFamily: Fonts.sansSemibold },
});
