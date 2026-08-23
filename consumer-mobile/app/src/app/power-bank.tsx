/* Power-bank rental flow — Meituan power-bank style:
 * Map → Nearby stations → Scan QR → Unlock → Use → Return → Fee → History
 *
 * Placeholder screen: local station registry + mock rental lifecycle so the
 * route compiles and the QR payload `hudumika:powerbank:{id}` can be demoed
 * end-to-end via QrScanner (dine-in + power-bank dual support). When a live
 * backend ships the power-bank surface, replace the local state with a
 * PowerBankRepository (mirrors BikeRepository / DineInRepository house pattern).
 *
 * Sections: [1] Map with station pins, [2] Scan (camera + manual field),
 * [3] Unlock (RT: create rental), [4] Return (choose station), [5] Fee
 * breakdown (hourly + cap + deposit hint). Money is integer TZS.
 */
import { useRouter } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { MapView } from '@/components/MapView';
import { QrScanner } from '@/components/QrScanner';
import { Btn, Card, Divider, Field, Icon, MoneyText, Row, Screen } from '@/components/ui';
import { Colors, Fonts, FontSize, Radius, Spacing } from '@/constants/theme';
import { t } from '@/i18n';
import { formatTZS } from '@/lib/format';
import { fullDateISO } from '@/lib/dates';
import {
  POWER_BANK_DAILY_CAP_TZS,
  POWER_BANK_HOURLY_FEE_TZS,
  POWER_BANK_QR_EXAMPLE,
  parsePowerBankQr,
} from '@/lib/powerBank';
import { toast } from '@/store/ui';
import { useSessionStore } from '@/store/session';

// ---------------------------------------------------------------------------
// Local station registry — Dar es Salaam seed (mirrors bike SEED_BIKES offsets).
// The server is authority once live; the client hints proximity only.
// ---------------------------------------------------------------------------
interface Station {
  id: string;
  name: string;
  lat: number;
  lon: number;
  available: number;
  total: number;
}

const STATIONS: Station[] = [
  { id: 'pb_station_001', name: 'Mlimani City', lat: -6.765, lon: 39.21, available: 8, total: 12 },
  { id: 'pb_station_002', name: 'Masaki', lat: -6.785, lon: 39.205, available: 3, total: 10 },
  { id: 'pb_station_003', name: 'Kariakoo', lat: -6.795, lon: 39.215, available: 0, total: 10 },
  { id: 'pb_station_004', name: 'Ocean Road', lat: -6.792, lon: 39.198, available: 6, total: 8 },
  { id: 'pb_station_005', name: 'Sinza', lat: -6.8, lon: 39.208, available: 12, total: 16 },
];

const CENTER = { lat: -6.7924, lon: 39.2083 };

interface Rental {
  id: string;
  powerBankId: string;
  stationId: string;
  startAt: string;
  endAt?: string;
  returnStationId?: string;
  durationMinutes?: number;
  feeTZS?: number;
  capped?: boolean;
}

function feeFor(durationMinutes: number): { hourlyTZS: number; totalTZS: number; capped: boolean } {
  const hours = Math.max(1, Math.ceil(durationMinutes / 60));
  const raw = hours * POWER_BANK_HOURLY_FEE_TZS;
  const capped = raw > POWER_BANK_DAILY_CAP_TZS;
  return { hourlyTZS: raw, totalTZS: capped ? POWER_BANK_DAILY_CAP_TZS : raw, capped };
}

export default function PowerBankScreen() {
  const router = useRouter();
  const user = useSessionStore((s) => s.user);
  void user;
  const [selectedId, setSelectedId] = useState<string | null>(STATIONS[0]?.id ?? null);
  const [scannerOpen, setScannerOpen] = useState(false);
  const [qr, setQr] = useState('');
  const [qrError, setQrError] = useState('');
  const [unlocking, setUnlocking] = useState(false);
  const [activeRental, setActiveRental] = useState<Rental | null>(null);
  const [completed, setCompleted] = useState<Rental | null>(null);
  const [returning, setReturning] = useState(false);
  const [paying, setPaying] = useState(false);
  const [now, setNow] = useState(Date.now());
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const selectedStation = useMemo(() => STATIONS.find((s) => s.id === selectedId) ?? STATIONS[0] ?? null, [selectedId]);
  const stationPins = useMemo(() => STATIONS.map((s) => ({ lat: s.lat, lon: s.lon })), []);

  // Live timer while rented (mirrors bike ride timer)
  useEffect(() => {
    if (!activeRental) {
      if (timerRef.current) clearInterval(timerRef.current);
      return;
    }
    timerRef.current = setInterval(() => setNow(Date.now()), 10_000);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [activeRental]);

  const elapsedMinutes = useMemo(() => {
    if (!activeRental) return 0;
    return Math.max(0, Math.round((now - Date.parse(activeRental.startAt)) / 60000));
  }, [activeRental, now]);

  const elapsedFee = useMemo(() => feeFor(Math.max(1, elapsedMinutes || 1)), [elapsedMinutes]);

  const doUnlock = (raw: string, stationId: string) => {
    const parsed = parsePowerBankQr(raw);
    // Allow plain ids for dev entry (e.g. pb_001 / pb_station_001) via fallback:
    const powerBankId = parsed ? parsed.id : raw.trim();
    if (!parsed && !/^[a-zA-Z0-9_-]+$/.test(powerBankId)) {
      setQrError('That is not a power-bank QR payload');
      return;
    }
    if (!powerBankId) {
      setQrError('That is not a power-bank QR payload');
      return;
    }
    const st = STATIONS.find((s) => s.id === stationId);
    if (!st) {
      setQrError('Station not found');
      return;
    }
    if (st.available <= 0) {
      setQrError('No power banks available at this station');
      return;
    }
    setUnlocking(true);
    setQrError('');
    // Mock immediate unlock — a live backend would POST /power-bank/unlock
    setTimeout(() => {
      const rental: Rental = {
        id: `pb_rental_${Date.now()}`,
        powerBankId,
        stationId: st.id,
        startAt: new Date().toISOString(),
      };
      setActiveRental(rental);
      setCompleted(null);
      setUnlocking(false);
      toast(`Power bank ${powerBankId} unlocked — return to any station`);
    }, 450);
  };

  const onManualUnlock = () => {
    if (!qr.trim()) {
      setQrError('That is not a power-bank QR payload');
      return;
    }
    // Accept powerbank QR or plain id; reject foreign/dine-in QRs with honest error
    const asQr = parsePowerBankQr(qr);
    if (!asQr && !/^(pb_[a-z0-9_-]+|[a-zA-Z0-9_-]+)$/i.test(qr.trim())) {
      setQrError('That is not a power-bank QR payload');
      return;
    }
    // If payload is a powerbank QR, allow; if it's a dine-in payload, reject as foreign
    if (!asQr && qr.includes('hudumika:') && !qr.includes('hudumika:powerbank:')) {
      setQrError('That is not a power-bank QR payload');
      return;
    }
    const stationId = selectedStation?.id ?? STATIONS[0].id;
    doUnlock(qr.trim(), stationId);
  };

  const onScan = (payload: string) => {
    setScannerOpen(false);
    setQr(payload);
    const parsed = parsePowerBankQr(payload);
    if (!parsed) {
      setQrError('That is not a power-bank QR payload');
      return;
    }
    const stationId = selectedStation?.id ?? STATIONS[0].id;
    doUnlock(payload, stationId);
  };

  const doReturn = (stationId: string) => {
    if (!activeRental) return;
    const st = STATIONS.find((s) => s.id === stationId);
    if (!st) {
      toast('Station not found', 'error');
      return;
    }
    setReturning(true);
    const duration = Math.max(1, Math.round((Date.now() - Date.parse(activeRental.startAt)) / 60000));
    const { totalTZS, capped } = feeFor(duration);
    setTimeout(() => {
      const done: Rental = {
        ...activeRental,
        endAt: new Date().toISOString(),
        returnStationId: stationId,
        durationMinutes: duration,
        feeTZS: totalTZS,
        capped,
      };
      setActiveRental(null);
      setCompleted(done);
      setReturning(false);
      toast(`Returned to ${st.name} — fee ${formatTZS(totalTZS)}`);
    }, 500);
  };

  const payFee = () => {
    if (!completed?.feeTZS) return;
    setPaying(true);
    setTimeout(() => {
      setPaying(false);
      toast('Payment successful — asante!');
      setCompleted(null);
      setQr('');
    }, 600);
  };

  // Active rental view — map + timer + return picker (covers unlock → return)
  if (activeRental) {
    return (
      <Screen scroll>
        <View style={{ paddingHorizontal: Spacing.lg, paddingTop: Spacing.lg, gap: Spacing.md }}>
          <Row style={{ justifyContent: 'space-between' }}>
            <Btn label={t('common.back')} onPress={() => router.back()} variant="subtle" size="sm" icon="arrow-back" />
            <Text style={styles.title}>Power bank in use</Text>
            <View style={{ width: 40 }} />
          </Row>

          <MapView
            center={CENTER}
            marker={CENTER}
            merchantPins={stationPins}
            userLocation={CENTER}
            interactive
            height={180}
            label="Power-bank stations"
          />

          <Card style={{ gap: Spacing.md }}>
            <Row style={{ justifyContent: 'space-between' }}>
              <Row gap={Spacing.sm}>
                <View style={styles.badge}>
                  <Icon name="battery-charging-outline" size={18} color={Colors.primaryDeep} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.name}>{activeRental.powerBankId}</Text>
                  <Text style={styles.meta}>
                    From {STATIONS.find((s) => s.id === activeRental.stationId)?.name ?? activeRental.stationId} · Started{' '}
                    {fullDateISO(activeRental.startAt)}
                  </Text>
                </View>
              </Row>
              <View style={[styles.pill, { backgroundColor: Colors.successSoft }]}>
                <Text style={[styles.pillText, { color: Colors.success }]}>In use</Text>
              </View>
            </Row>

            <Row gap={Spacing.sm} style={{ flexWrap: 'wrap' }}>
              <Text style={styles.meta}>
                {elapsedMinutes} min elapsed · ~{formatTZS(elapsedFee.totalTZS)} so far
                {elapsedFee.capped ? ' (daily cap)' : ''}
              </Text>
            </Row>
            <Text style={styles.hint}>Return the power bank to any station slot to stop billing. Hourly billing, daily cap.</Text>
            <Divider />

            <Text style={styles.sectionLabel}>Return to station</Text>
            {STATIONS.map((s) => (
              <Card
                key={s.id}
                flat
                onPress={() => doReturn(s.id)}
                style={[styles.stationCard, selectedId === s.id && styles.stationCardSelected]}>
                <Row style={{ justifyContent: 'space-between' }}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.value}>{s.name}</Text>
                    <Text style={styles.meta}>
                      {s.available}/{s.total} slots free · {s.lat.toFixed(3)}, {s.lon.toFixed(3)}
                    </Text>
                  </View>
                  <Btn label="Return here" size="sm" onPress={() => doReturn(s.id)} loading={returning} icon="return-down-back-outline" />
                </Row>
              </Card>
            ))}

            <Text style={styles.hint}>Deposit hint: wallet hold not charged unless unreturned past cap window.</Text>
          </Card>
        </View>
      </Screen>
    );
  }

  // Completed fee view (covers fee)
  if (completed) {
    const capped = completed.capped;
    return (
      <Screen scroll>
        <View style={{ padding: Spacing.lg, gap: Spacing.md }}>
          <Row style={{ justifyContent: 'space-between' }}>
            <Btn label={t('common.back')} onPress={() => setCompleted(null)} variant="subtle" size="sm" icon="arrow-back" />
            <Text style={styles.title}>Return complete</Text>
            <View style={{ width: 40 }} />
          </Row>

          <Card style={{ gap: Spacing.md }}>
            <Row style={{ justifyContent: 'space-between' }}>
              <Text style={styles.name}>{completed.powerBankId}</Text>
              <View style={[styles.pill, { backgroundColor: Colors.successSoft }]}>
                <Text style={[styles.pillText, { color: Colors.success }]}>Returned</Text>
              </View>
            </Row>
            <Text style={styles.meta}>
              {fullDateISO(completed.startAt)} → {completed.endAt ? fullDateISO(completed.endAt) : '—'} ·{' '}
              {completed.durationMinutes ?? 0} min
            </Text>
            <Text style={styles.meta}>
              Borrowed from {STATIONS.find((s) => s.id === completed.stationId)?.name ?? completed.stationId} → returned to{' '}
              {STATIONS.find((s) => s.id === completed.returnStationId)?.name ?? completed.returnStationId ?? '—'}
            </Text>

            <Divider />
            <Text style={styles.sectionLabel}>Fee breakdown</Text>
            <Row style={{ justifyContent: 'space-between' }}>
              <Text style={styles.meta}>Hourly rate</Text>
              <Text style={styles.value}>{formatTZS(POWER_BANK_HOURLY_FEE_TZS)}/hr</Text>
            </Row>
            <Row style={{ justifyContent: 'space-between' }}>
              <Text style={styles.meta}>Duration</Text>
              <Text style={styles.value}>{completed.durationMinutes} min</Text>
            </Row>
            {capped ? (
              <Row style={{ justifyContent: 'space-between' }}>
                <Text style={[styles.meta, { color: Colors.warning }]}>Daily cap applied</Text>
                <Text style={[styles.value, { color: Colors.warning }]}>{formatTZS(POWER_BANK_DAILY_CAP_TZS)}</Text>
              </Row>
            ) : null}
            <Divider />
            <Row style={{ justifyContent: 'space-between' }}>
              <Text style={[styles.name, { fontFamily: Fonts.sansBold }]}>Total fee</Text>
              <MoneyText amountTZS={completed.feeTZS ?? 0} size={FontSize.lg} bold />
            </Row>

            {completed.feeTZS ? (
              <>
                <Text style={styles.hint}>Payment covers the rental fee. Deposit hold released on return.</Text>
                <Btn label={`Pay ${formatTZS(completed.feeTZS)}`} onPress={payFee} loading={paying} size="lg" />
              </>
            ) : null}
          </Card>

          <Btn label={t('common.done')} onPress={() => setCompleted(null)} variant="outline" />
        </View>
      </Screen>
    );
  }

  // Idle — map + station list + scan → unlock
  return (
    <Screen>
      <View style={{ paddingHorizontal: Spacing.lg, paddingTop: Spacing.lg, gap: Spacing.sm }}>
        <Row style={{ justifyContent: 'space-between', marginBottom: Spacing.sm }}>
          <Btn label={t('common.back')} onPress={() => router.back()} variant="subtle" size="sm" icon="arrow-back" />
          <Text style={styles.title}>Power bank</Text>
          <View style={{ width: 40 }} />
        </Row>
        <Text style={styles.sub}>Map nearby stations → scan the power-bank QR → unlock → return to any station</Text>

        <MapView
          center={CENTER}
          marker={CENTER}
          merchantPins={stationPins}
          userLocation={CENTER}
          interactive
          height={200}
          label="Power-bank stations"
        />
        <Text style={styles.meta}>
          {CENTER.lat.toFixed(5)}, {CENTER.lon.toFixed(5)} · {STATIONS.length} stations · {POWER_BANK_HOURLY_FEE_TZS
            ? `${formatTZS(POWER_BANK_HOURLY_FEE_TZS)}/hr`
            : ''}{' '}
          · cap {formatTZS(POWER_BANK_DAILY_CAP_TZS)}/day
        </Text>

        <Card style={{ gap: Spacing.md }}>
          <Text style={styles.sectionLabel}>Scan to unlock</Text>
          <Row gap={Spacing.sm} style={{ alignItems: 'flex-end' }}>
            <View style={{ flex: 1 }}>
              <Field
                label="Power-bank QR"
                value={qr}
                onChangeText={(v) => {
                  setQr(v);
                  setQrError('');
                }}
                placeholder={POWER_BANK_QR_EXAMPLE}
                autoCapitalize="none"
              />
              {qrError ? <Text style={styles.errorText}>{qrError}</Text> : null}
            </View>
            <Btn label="Scan QR" onPress={() => setScannerOpen(true)} icon="scan-outline" style={{ marginBottom: 2 }} />
          </Row>
          <Btn
            label="Unlock"
            onPress={onManualUnlock}
            loading={unlocking}
            icon="battery-charging-outline"
            disabled={!selectedStation || selectedStation.available <= 0}
          />
          <Text style={styles.hint}>
            Paste <Text style={{ fontFamily: Fonts.sansSemibold }}>{POWER_BANK_QR_EXAMPLE}</Text> or scan the QR on the power-bank / slot.
            Dine-in table QRs are ignored here.
          </Text>
        </Card>

        <QrScanner
          visible={scannerOpen}
          onClose={() => setScannerOpen(false)}
          onScan={onScan}
          filter={(payload) => !!parsePowerBankQr(payload)}
          title="Scan power-bank QR"
          hint="Point the camera at the QR on the power bank or station slot"
        />

        <Text style={styles.sectionLabel}>Nearby stations</Text>
      </View>

      <View style={{ flex: 1, paddingHorizontal: Spacing.lg, gap: Spacing.md, paddingBottom: 120 }}>
        {STATIONS.map((s) => {
          const isSelected = s.id === selectedId;
          const full = s.available <= 0;
          return (
            <Card key={s.id} style={[styles.stationCard, isSelected && styles.stationCardSelected]} onPress={() => setSelectedId(s.id)}>
              <Row style={{ justifyContent: 'space-between' }}>
                <View style={{ flex: 1 }}>
                  <Row gap={Spacing.sm}>
                    <View style={[styles.badge, isSelected && { backgroundColor: Colors.primarySoft, borderColor: Colors.primary, borderWidth: 1 }]}>
                      <Icon name="battery-charging" size={18} color={isSelected ? Colors.primaryDeep : Colors.textSecondary} />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={[styles.name, isSelected && { color: Colors.primaryDeep }]}>{s.name}</Text>
                      <Text style={styles.meta}>
                        {s.available}/{s.total} available{s.available === 0 ? ' — full' : ''} · {s.lat.toFixed(3)}, {s.lon.toFixed(3)}
                      </Text>
                    </View>
                  </Row>
                </View>
                {isSelected ? <Icon name="checkmark-circle" size={20} color={Colors.primary} /> : null}
              </Row>
              {isSelected ? (
                <View style={{ marginTop: Spacing.md }}>
                  <Text style={styles.meta}>
                    Fee: {formatTZS(POWER_BANK_HOURLY_FEE_TZS)}/hr · cap {formatTZS(POWER_BANK_DAILY_CAP_TZS)}/day · hold release on return
                  </Text>
                  <Btn
                    label={full ? 'Station full' : `Unlock at ${s.name}`}
                    onPress={() => {
                      if (!qr.trim()) {
                        setQrError('Enter or scan a power-bank QR first');
                        return;
                      }
                      doUnlock(qr.trim(), s.id);
                    }}
                    disabled={full}
                    size="sm"
                    icon="lock-open-outline"
                    style={{ marginTop: Spacing.sm, alignSelf: 'flex-start' }}
                  />
                </View>
              ) : null}
            </Card>
          );
        })}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  title: { fontSize: FontSize.xl, fontFamily: Fonts.displayBold, color: Colors.text, textAlign: 'center', flex: 1 },
  sub: { fontSize: FontSize.sm, color: Colors.textTertiary, fontFamily: Fonts.sans, textAlign: 'center', marginBottom: Spacing.xs },
  sectionLabel: {
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
    fontFamily: Fonts.sansSemibold,
    textTransform: 'uppercase',
    letterSpacing: 0.3,
  },
  name: { fontSize: FontSize.md, fontFamily: Fonts.sansSemibold, color: Colors.text },
  value: { fontSize: FontSize.sm, color: Colors.text, fontFamily: Fonts.sansSemibold, fontVariant: ['tabular-nums'] },
  meta: { fontSize: FontSize.xs, color: Colors.textSecondary, fontFamily: Fonts.sans, marginTop: 2 },
  hint: { fontSize: FontSize.xs, color: Colors.textTertiary, fontFamily: Fonts.sans, textAlign: 'center' },
  errorText: { color: Colors.danger, fontSize: FontSize.xs, fontFamily: Fonts.sansSemibold, marginTop: Spacing.xs },
  badge: {
    width: 44,
    height: 44,
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: Colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pill: { paddingHorizontal: Spacing.sm, paddingVertical: 4, borderRadius: Radius.pill },
  pillText: { fontSize: FontSize.xs, fontFamily: Fonts.sansBold, letterSpacing: 0.3 },
  stationCard: {
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: Colors.card,
  },
  stationCardSelected: {
    borderColor: Colors.primary,
    borderWidth: 1.5,
    backgroundColor: Colors.primarySoft,
  },
});
