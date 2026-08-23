/* Event detail + ticket purchase — GET /entertainment/events/{eventId}
 * (detail incl. tiers) + POST /entertainment/event-tickets (idempotent per
 * key; quantity 1–10; total = tier priceTZS × quantity). On success the
 * issued tickets land under My tickets (navigate there). */
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Btn, Card, ErrorState, Icon, MoneyText, Row, Screen, SheetModal, SkeletonCard } from '@/components/ui';
import { Colors, Fonts, FontSize, Spacing } from '@/constants/theme';
import { t } from '@/i18n';
import { toast } from '@/store/ui';
import { getEventsRepository } from '@/repos';
import { idempotencyKey } from '@/lib/idempotency';
import { fullDateISO } from '@/lib/dates';
import { formatTZS } from '@/lib/format';
import { ApiError } from '@/api/client';
import type { EventDetail, EventTier } from '@hudumika/contract';

const MAX_QUANTITY = 10;

export default function EventDetailScreen() {
  const router = useRouter();
  const { eventId } = useLocalSearchParams<{ eventId: string }>();
  const [detail, setDetail] = useState<EventDetail | null>(null);
  const [error, setError] = useState('');
  const [selectedTier, setSelectedTier] = useState<EventTier | null>(null);
  const [qty, setQty] = useState(1);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError('');
    try {
      setDetail(await getEventsRepository().get(eventId));
    } catch (e) {
      setError(e instanceof ApiError && (e.status === 404 || e.code === 'NOT_FOUND') ? t('events.notFound') : t('common.error'));
    }
  }, [eventId]);

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openTier = (tier: EventTier) => {
    setSelectedTier(tier);
    setQty(1);
  };

  const [selectedSeats, setSelectedSeats] = useState<string[]>([]);
  const toggleSeat = (seat: string) => {
    setSelectedSeats((prev) => (prev.includes(seat) ? prev.filter((s) => s !== seat) : [...prev, seat].slice(0, 6)));
  };

  const purchase = async () => {
    const isCinema = detail?.event.category === 'Cinema' || detail?.event.title.toLowerCase().includes('movie');
    const finalQty = isCinema && selectedSeats.length > 0 ? selectedSeats.length : qty;
    if (!detail || !selectedTier) return;
    setBusy(true);
    try {
      const issued = await getEventsRepository().purchase(
        { eventId: detail.event.id, tierId: selectedTier.id, quantity: finalQty },
        idempotencyKey('cus_1', 'event-tickets'),
      );
      setSelectedTier(null);
      setSelectedSeats([]);
      toast(t('events.purchased', { n: issued.length }));
      router.push('/events/tickets');
    } catch (e) {
      if (e instanceof ApiError) {
        if (e.status === 409 || e.code === 'CONFLICT') {
          // Sold out while choosing — refetch so tier cards reflect reality.
          toast(t('events.soldOut'), 'error');
          load();
        } else {
          toast(e.message, 'error');
        }
      } else {
        toast(t('common.error'), 'error');
      }
    } finally {
      setBusy(false);
    }
  };

  if (error) {
    return (
      <Screen>
        <ErrorState message={error} onRetry={load} />
      </Screen>
    );
  }

  if (!detail) {
    return (
      <Screen>
        <View style={{ gap: Spacing.md, padding: Spacing.lg }}>
          <SkeletonCard rows={3} />
          <SkeletonCard rows={2} />
        </View>
      </Screen>
    );
  }

  return (
    <Screen scroll>
      <Row style={{ justifyContent: 'space-between', marginBottom: Spacing.md }}>
        <Btn label={t('common.back')} onPress={() => router.back()} variant="subtle" size="sm" icon="arrow-back" />
        <Text style={styles.title}>{t('events.tickets')}</Text>
        <Btn label={t('events.myTickets')} onPress={() => router.push('/events/tickets')} variant="ghost" size="sm" />
      </Row>

      <Card style={{ gap: Spacing.md }}>
        <Text style={styles.name}>{detail.event.title}</Text>
        <Text style={styles.meta}>{detail.event.venue}</Text>
        <Text style={styles.meta}>{detail.event.cityName ?? detail.event.cityId}</Text>
        <Text style={styles.meta}>{t('events.startsAt')} · {fullDateISO(detail.event.startsAt)}</Text>
        {detail.description ? <Text style={styles.meta}>{detail.description}</Text> : null}
      </Card>

      {detail.tiers.length > 0 ? (
        <Text style={styles.sectionLabel}>{t('events.category')}</Text>
      ) : null}
      {detail.tiers.map((tier) => {
        const soldOut = !tier.available || (tier.remaining ?? 0) === 0;
        return (
          <Card key={tier.id} style={{ marginBottom: Spacing.md }}>
            <Row style={{ justifyContent: 'space-between' }}>
              <View style={{ flex: 1 }}>
                <Text style={styles.tierName}>{tier.name}</Text>
                <MoneyText amountTZS={tier.priceTZS} size={FontSize.lg} bold />
                {tier.remaining !== undefined ? (
                  <Text style={styles.meta}>
                    {soldOut ? t('events.soldOut') : t('events.remaining', { n: tier.remaining })}
                  </Text>
                ) : null}
              </View>
              <Btn
                label={soldOut ? t('events.soldOut') : t('events.select')}
                size="sm"
                variant={soldOut ? 'subtle' : 'primary'}
                disabled={soldOut}
                onPress={() => openTier(tier)}
              />
            </Row>
          </Card>
        );
      })}

      <SheetModal visible={selectedTier !== null} onClose={() => setSelectedTier(null)} title={selectedTier?.name}>
        {selectedTier ? (
          <>
            {(() => {
              const isCinema = detail?.event.category === 'Cinema' || detail?.event.title.toLowerCase().includes('movie');
              if (isCinema) {
                const rows = 6;
                const cols = 8;
                const occupied = new Set(['A2', 'B5', 'C3', 'D7', 'E1', 'F4', 'F8', 'G2', 'H6', 'H7']);
                return (
                  <>
                    <Text style={styles.sectionLabel}>Select seats (max 6)</Text>
                    <View style={styles.seatGrid}>
                      {Array.from({ length: rows }).map((_, r) => (
                        <View key={r} style={styles.seatRow}>
                          {Array.from({ length: cols }).map((_, c) => {
                            const seat = `${String.fromCharCode(65 + r)}${c + 1}`;
                            const isOcc = occupied.has(seat);
                            const isSel = selectedSeats.includes(seat);
                            return (
                              <Pressable
                                key={seat}
                                onPress={() => !isOcc && toggleSeat(seat)}
                                disabled={isOcc}
                                style={[styles.seat, isOcc && styles.seatOccupied, isSel && styles.seatSelected]}>
                                <Icon name={isOcc ? 'close' : isSel ? 'checkmark' : 'square-outline'} size={12} color={isOcc ? Colors.textFaint : isSel ? Colors.white : Colors.textSecondary} />
                              </Pressable>
                            );
                          })}
                        </View>
                      ))}
                    </View>
                    <Text style={styles.meta}>{selectedSeats.length > 0 ? `Selected: ${selectedSeats.join(', ')}` : 'Tap to select seats'}</Text>
                  </>
                );
              }
              return null;
            })()}
            <Row style={{ justifyContent: 'space-between' }}>
              <Text style={styles.sectionLabel}>{t('events.quantity')}</Text>
              <Row gap={Spacing.md}>
                <Pressable
                  onPress={() => setQty((q) => Math.max(1, q - 1))}
                  accessibilityRole="button"
                  accessibilityLabel={t('common.back')}
                  style={styles.qtyBtn}>
                  <Icon name="remove" size={18} color={Colors.text} />
                </Pressable>
                <Text style={styles.qty}>{qty}</Text>
                <Pressable
                  onPress={() => setQty((q) => Math.min(MAX_QUANTITY, q + 1))}
                  accessibilityRole="button"
                  style={styles.qtyBtn}>
                  <Icon name="add" size={18} color={Colors.text} />
                </Pressable>
              </Row>
            </Row>
            <Row style={{ justifyContent: 'space-between' }}>
              <Text style={styles.sectionLabel}>{t('events.total')}</Text>
              <Text style={styles.total}>{formatTZS(selectedTier.priceTZS * (detail?.event.category === 'Cinema' && selectedSeats.length > 0 ? selectedSeats.length : qty))}</Text>
            </Row>
            <Btn label={t('events.buy')} size="lg" onPress={purchase} loading={busy} />
          </>
        ) : null}
      </SheetModal>
    </Screen>
  );
}

const styles = StyleSheet.create({
  title: { fontSize: FontSize.lg, fontFamily: Fonts.sansBold, color: Colors.text, flex: 1, textAlign: 'center' },
  name: { fontSize: FontSize.xl, fontFamily: Fonts.sansExtraBold, color: Colors.text },
  tierName: { fontSize: FontSize.md, fontFamily: Fonts.sansSemibold, color: Colors.text, marginBottom: 2 },
  meta: { fontSize: FontSize.xs, color: Colors.textTertiary, fontFamily: Fonts.sans, marginTop: 2 },
  sectionLabel: { fontSize: FontSize.sm, color: Colors.textTertiary, fontFamily: Fonts.sansSemibold, marginBottom: Spacing.sm },
  qtyBtn: { width: 40, height: 40, borderRadius: 20, borderWidth: 1, borderColor: Colors.borderStrong, alignItems: 'center', justifyContent: 'center' },
  qty: { fontSize: FontSize.xl, fontFamily: Fonts.sansBold, color: Colors.text, minWidth: 32, textAlign: 'center' },
  total: { fontSize: FontSize.xl, fontFamily: Fonts.displayBold, color: Colors.text, fontVariant: ['tabular-nums'] },
  seatGrid: { gap: 6, marginVertical: Spacing.md, alignItems: 'center' },
  seatRow: { flexDirection: 'row', gap: 6 },
  seat: { width: 28, height: 28, borderRadius: 6, borderWidth: 1, borderColor: Colors.borderStrong, backgroundColor: Colors.card, alignItems: 'center', justifyContent: 'center' },
  seatOccupied: { backgroundColor: Colors.surface, borderColor: Colors.border, opacity: 0.6 },
  seatSelected: { backgroundColor: Colors.primary, borderColor: Colors.primary },
});
