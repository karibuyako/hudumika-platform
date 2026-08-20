/* Onboarding flow (MASTER-BLUEPRINT §3) — stepped, skippable:
 *  1. Carousel (order anything / track everything / safety) — skippable,
 *     skip flag persisted locally so returning users land on the city picker.
 *  2. Profile setup — name + language (PATCH /users/me), notification note.
 *  3. Address setup — first delivery address (local store, contract has no
 *     saved-address surface).
 *  4. Payment setup — GET /payments/methods with a device-local "default"
 *     preference (no contract mutation endpoint — client preference only).
 *  5. City picker — the persisted-city gate for the authed status (session.ts
 *     restoredStatusFor), then completeOnboarding + /home.
 *
 * Reduced-motion aware (store/ui.ts): the carousel has no auto/infinite
 * animation; programmatic slide jumps use animated: !reducedMotion.
 */
import { useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  FlatList,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Avatar, Btn, Card, Chip, EmptyState, ErrorState, Field, Icon, Pill, Row, Screen, SkeletonCard, type IconName } from '@/components/ui';
import { LocationPermissionSheet } from '@/components/LocationPermissionSheet';
import { NotificationPermissionSheet } from '@/components/NotificationPermissionSheet';
import { Colors, Fonts, FontSize, Radius, Spacing } from '@/constants/theme';
import { getLocale, setLocale, t, type Locale } from '@/i18n';
import { GeoError, reverseGeocode, type GeoPosition } from '@/lib/geolocation';
import { getAuthRepository, getHomeRepository, getPaymentsRepository, type PaymentMethodRecord } from '@/repos';
import { useAddressesStore } from '@/store/addresses';
import { useLocationStore } from '@/store/location';
import { isOnboardingDone, useOnboardingStore } from '@/store/onboarding';
import { useSessionStore } from '@/store/session';
import { toast, useUiStore } from '@/store/ui';
import type { City } from '@hudumika/contract';

const TOTAL_STEPS = 5;

const SLIDES: { key: string; icon: IconName; titleKey: 'onboard.slide1.title' | 'onboard.slide2.title' | 'onboard.slide3.title'; copyKey: 'onboard.slide1.copy' | 'onboard.slide2.copy' | 'onboard.slide3.copy' }[] = [
  { key: 'order', icon: 'bag-handle-outline', titleKey: 'onboard.slide1.title', copyKey: 'onboard.slide1.copy' },
  { key: 'track', icon: 'navigate-outline', titleKey: 'onboard.slide2.title', copyKey: 'onboard.slide2.copy' },
  { key: 'safety', icon: 'shield-checkmark-outline', titleKey: 'onboard.slide3.title', copyKey: 'onboard.slide3.copy' },
];

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

/** Push prompt gate (once only): the explanatory sheet fires after the city
 * picker Continue on the user's first session; "Not now" can re-prompt from
 * Settings. Web is exempt — push is native-only. */
const PUSH_PROMPT_FLAG = 'consumer.pushPrompted';

function shouldPromptPush(): boolean {
  if (Platform.OS === 'web') return false;
  try {
    return localStorage.getItem(PUSH_PROMPT_FLAG) !== '1';
  } catch {
    return false;
  }
}

function markPushPrompted(): void {
  try {
    localStorage.setItem(PUSH_PROMPT_FLAG, '1');
  } catch {
    /* storage unavailable */
  }
}

export default function OnboardingScreen() {
  const router = useRouter();
  const [pushSheetVisible, setPushSheetVisible] = useState(false);
  const [step, setStep] = useState<number>(() => {
    const user = useSessionStore.getState().user;
    // Returning users (skip flag set or a name already saved) go straight to
    // the city picker — the persisted-city gate for the authed status.
    return isOnboardingDone() || Boolean(user?.fullName) ? TOTAL_STEPS : 1;
  });

  const goTo = (next: number) => setStep(next);

  // ---- Step 5: city picker (behavior unchanged) ----------------------------
  const [cities, setCities] = useState<City[] | null>(null);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setError('');
    try {
      const list = await getHomeRepository().listCities();
      setCities(list.length ? list : []);
    } catch {
      setError(t('common.error'));
    }
  }, []);

  useEffect(() => {
    if (step !== TOTAL_STEPS) return;
    load();
  }, [step, load]);

  const choose = (city: City) => {
    setSelected(city.id);
    useLocationStore.getState().setCity({ id: city.id, name: city.name, serviceAreas: city.serviceAreas });
  };

  const continueOn = async () => {
    if (!selected) return;
    setSaving(true);
    try {
      const user = useSessionStore.getState().user;
      if (user) useSessionStore.getState().completeOnboarding(user);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      if (shouldPromptPush()) {
        // Explanatory copy BEFORE the OS permission prompt (SECURITY.md) —
        // Allow/Not now both navigate home afterwards; the flag makes this
        // first-session prompt a one-time thing (Settings can re-open it).
        markPushPrompted();
        setPushSheetVisible(true);
      } else {
        router.replace('/home');
      }
    } finally {
      setSaving(false);
    }
  };

  const closePushSheet = () => {
    setPushSheetVisible(false);
    router.replace('/home');
  };

  return (
    <View style={{ flex: 1, backgroundColor: Colors.bg }}>
      <StepIndicator step={step} onBack={step > 1 ? () => goTo(step - 1) : undefined} />

      {step === 1 ? <CarouselStep onDone={() => goTo(2)} /> : null}
      {step === 2 ? <ProfileStep onDone={() => goTo(3)} /> : null}
      {step === 3 ? <AddressStep onDone={() => goTo(4)} /> : null}
      {step === 4 ? <PaymentStep onDone={() => goTo(TOTAL_STEPS)} /> : null}
      {step === TOTAL_STEPS ? <CityStep cities={cities} error={error} selected={selected} saving={saving} onChoose={choose} onRetry={load} onContinue={continueOn} /> : null}

      <NotificationPermissionSheet visible={pushSheetVisible} onClose={closePushSheet} onRegistered={closePushSheet} />
    </View>
  );
}

function StepIndicator({ step, onBack }: { step: number; onBack?: () => void }) {
  return (
    <SafeAreaView edges={['top']} style={styles.headerSafe}>
      <View style={styles.header}>
        {onBack ? (
          <Pressable onPress={onBack} hitSlop={12} accessibilityRole="button" accessibilityLabel={t('common.back')} style={styles.headerBackBtn}>
            <Icon name="chevron-back" size={22} color={Colors.textSecondary} />
          </Pressable>
        ) : (
          <View style={styles.headerSpacer} />
        )}
      <View
        style={styles.dots}
        accessibilityRole="progressbar"
        accessibilityLabel={t('onboard.stepA11y', { step, total: TOTAL_STEPS })}
        accessibilityValue={{ min: 1, max: TOTAL_STEPS, now: step }}>
        {Array.from({ length: TOTAL_STEPS }, (_, i) => (
          <View key={i} style={[styles.dot, i + 1 <= step && styles.dotActive]} />
        ))}
      </View>
      <View style={styles.headerSpacer} />
      </View>
    </SafeAreaView>
  );
}

function CarouselStep({ onDone }: { onDone: () => void }) {
  const reducedMotion = useUiStore((s) => s.reducedMotion);
  const markOnboardingDone = useOnboardingStore((s) => s.markOnboardingDone);
  const [slide, setSlide] = useState(0);
  const [width, setWidth] = useState(0);
  const listRef = useRef<FlatList<(typeof SLIDES)[number]>>(null);

  const onMomentumScrollEnd = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const next = Math.round(e.nativeEvent.contentOffset.x / Math.max(width, 1));
    setSlide(Math.min(Math.max(next, 0), SLIDES.length - 1));
  };

  const go = (index: number) => {
    listRef.current?.scrollToIndex({ index, animated: !reducedMotion });
    setSlide(index);
  };

  const finish = () => {
    // Completing (or skipping) the carousel is the onboarding-done flag —
    // returning users start at the city picker.
    markOnboardingDone();
    onDone();
  };

  const last = slide === SLIDES.length - 1;

  return (
    <View style={{ flex: 1 }}>
      <View style={{ flex: 1 }} onLayout={(e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width)}>
        <FlatList
          ref={listRef}
          data={SLIDES}
          horizontal
          pagingEnabled
          showsHorizontalScrollIndicator={false}
          onMomentumScrollEnd={onMomentumScrollEnd}
          getItemLayout={(_, index) => ({ length: width || 320, offset: (width || 320) * index, index })}
          keyExtractor={(s) => s.key}
          renderItem={({ item }) => (
            <View style={[styles.slide, width > 0 && { width }]}>
              <View style={styles.slideIcon}>
                <Icon name={item.icon} size={44} color={Colors.primaryDeep} />
              </View>
              <Text style={styles.slideTitle}>{t(item.titleKey)}</Text>
              <Text style={styles.slideCopy}>{t(item.copyKey)}</Text>
            </View>
          )}
        />
      </View>

      <SafeAreaView edges={['bottom']} style={styles.footer}>
        <View style={styles.dots} accessibilityLabel={t('onboard.slideA11y', { n: slide + 1, total: SLIDES.length })}>
          {SLIDES.map((s, i) => (
            <View key={s.key} style={[styles.dot, i === slide && styles.dotActive]} />
          ))}
        </View>
        <Row gap={Spacing.md}>
          <Btn label={t('onboard.skip')} onPress={finish} variant="subtle" size="lg" style={{ minHeight: 44, paddingHorizontal: Spacing.lg }} />
          <Btn label={t('onboard.next')} onPress={last ? finish : () => go(slide + 1)} size="lg" style={{ flex: 1, minHeight: 44 }} />
        </Row>
      </SafeAreaView>
    </View>
  );
}

function ProfileStep({ onDone }: { onDone: () => void }) {
  const applyUser = useSessionStore((s) => s.applyUser);
  const [name, setName] = useState(useSessionStore.getState().user?.fullName ?? '');
  const [locale, setLocaleState] = useState<Locale>(getLocale());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const changeLocale = (next: Locale) => {
    setLocaleState(next);
    // Applies locally immediately; persisted via PATCH /users/me on Save.
    setLocale(next);
  };

  const save = async () => {
    if (name.trim().length < 2) {
      setError(t('onboard.profile.nameError'));
      return;
    }
    setError('');
    setSaving(true);
    try {
      const user = await getAuthRepository().updateProfile({ fullName: name.trim(), locale });
      applyUser(user);
      toast(t('onboard.profile.saved'));
      onDone();
    } catch {
      setError(t('common.error'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Screen scroll contentStyle={{ flexGrow: 1 }}>
      <View style={{ alignItems: 'center', marginBottom: Spacing.xl }}>
        <Avatar name={name || '?'} size={72} />
      </View>
      <Text style={styles.title}>{t('onboard.profile.title')}</Text>
      <Text style={styles.sub}>{t('onboard.profile.sub')}</Text>

      <Field label={t('onboard.profile.name')} value={name} onChangeText={setName} placeholder={t('onboard.profile.namePlaceholder')} maxLength={120} />

      <View style={{ gap: Spacing.xs, marginTop: Spacing.lg }}>
        <Text style={styles.fieldLabel}>{t('onboard.profile.language')}</Text>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.sm }}>
          {(['en', 'sw', 'ar'] as Locale[]).map((l) => (
            <Chip key={l} label={l === 'en' ? 'English' : l === 'sw' ? 'Kiswahili' : 'العربية'} selected={locale === l} onPress={() => changeLocale(l)} />
          ))}
        </View>
      </View>

      <Card flat style={{ marginTop: Spacing.xl }}>
        <Row gap={Spacing.md}>
          <Icon name="notifications-outline" size={18} color={Colors.textSecondary} />
          <View style={{ flex: 1 }}>
            <Text style={styles.noteTitle}>{t('onboard.profile.notifications')}</Text>
            <Text style={styles.note}>{t('onboard.profile.notificationsNote')}</Text>
          </View>
        </Row>
      </Card>

      {error ? <Text style={styles.error} accessibilityRole="alert" accessibilityLiveRegion="polite">{error}</Text> : null}
      <Btn label={t('onboard.profile.save')} onPress={save} size="lg" loading={saving} style={{ marginTop: Spacing.xl, minHeight: 44 }} />
    </Screen>
  );
}

function AddressStep({ onDone }: { onDone: () => void }) {
  const addAddress = useAddressesStore((s) => s.addAddress);
  const [label, setLabel] = useState('');
  const [lines, setLines] = useState('');
  const [landmark, setLandmark] = useState('');
  const [instructions, setInstructions] = useState('');
  const [phone, setPhone] = useState('');
  const [lat, setLat] = useState<number | undefined>(undefined);
  const [lon, setLon] = useState<number | undefined>(undefined);
  const [sheetVisible, setSheetVisible] = useState(false);
  const [locationSet, setLocationSet] = useState(false);
  const [geoError, setGeoError] = useState('');
  const [error, setError] = useState('');

  // GPS fill — only a real fix from the Web Geolocation API is stored.
  const onGpsFix = (position: GeoPosition) => {
    setSheetVisible(false);
    setLat(position.lat);
    setLon(position.lon);
    setGeoError('');
    setLocationSet(true);
  };

  const onGpsError = (e: GeoError) => {
    setSheetVisible(false);
    setGeoError(e.code === 'PERMISSION_DENIED' ? t('location.permissionDenied') : t('address.locationError'));
  };

  const save = () => {
    if (!label.trim() || !lines.trim() || !phone.trim()) {
      setError(t('common.error'));
      return;
    }
    addAddress({
      label: label.trim(),
      lines: lines.trim(),
      landmark: landmark.trim() || undefined,
      deliveryInstructions: instructions.trim() || undefined,
      contactPhone: phone.trim(),
      // Coordinates come only from a real GPS fix — never fabricated.
      ...(lat !== undefined && lon !== undefined ? { lat, lon } : {}),
    });
    onDone();
  };

  return (
    <Screen scroll contentStyle={{ flexGrow: 1 }}>
      <Text style={styles.title}>{t('onboard.address.title')}</Text>
      <Text style={styles.sub}>{t('onboard.address.sub')}</Text>

      <View style={{ gap: Spacing.md }}>
        <Field label={t('addresses.label')} value={label} onChangeText={setLabel} placeholder="Home" maxLength={60} />
        <Field label={t('addresses.lines')} value={lines} onChangeText={setLines} multiline maxLength={500} />
        <Field label={t('addresses.landmark')} value={landmark} onChangeText={setLandmark} maxLength={200} />
        <Field
          label={t('address.instructions')}
          value={instructions}
          onChangeText={setInstructions}
          multiline
          maxLength={500}
          placeholder={t('address.instructionsPlaceholder')}
        />
        <Field label={t('addresses.phone')} value={phone} onChangeText={setPhone} keyboardType="phone-pad" />

        <Btn label={t('address.useCurrentLocation')} onPress={() => setSheetVisible(true)} variant="outline" icon="locate" />
        {locationSet ? <Text style={styles.hint}>{t('address.locationSet')}</Text> : null}
        {geoError ? <Text style={styles.error}>{geoError}</Text> : null}
        {error ? <Text style={styles.error}>{error}</Text> : null}
      </View>

      <Btn label={t('addresses.save')} onPress={save} size="lg" style={{ marginTop: Spacing.xl }} />
      <LocationPermissionSheet visible={sheetVisible} onClose={() => setSheetVisible(false)} onDetected={onGpsFix} onError={onGpsError} />
    </Screen>
  );
}

function PaymentStep({ onDone }: { onDone: () => void }) {
  const defaultMethodId = useOnboardingStore((s) => s.defaultMethodId);
  const setDefaultMethod = useOnboardingStore((s) => s.setDefaultMethod);
  const [methods, setMethods] = useState<PaymentMethodRecord[] | null>(null);
  const [loadError, setLoadError] = useState('');
  const [picked, setPicked] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoadError('');
    try {
      setMethods(await getPaymentsRepository().getPaymentMethods());
    } catch {
      setLoadError(t('common.error'));
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const available = (methods ?? []).filter((m) => m.available !== false);
  const effectiveDefault =
    picked ?? (defaultMethodId && methods?.some((m) => m.id === defaultMethodId && m.available !== false) ? defaultMethodId : null);

  const choose = (m: PaymentMethodRecord) => {
    setPicked(m.id);
    setDefaultMethod(m.id);
  };

  return (
    <Screen scroll contentStyle={{ flexGrow: 1 }}>
      <Text style={styles.title}>{t('onboard.payment.title')}</Text>
      <Text style={styles.sub}>{t('onboard.payment.sub')}</Text>

      {loadError ? (
        <ErrorState message={loadError} onRetry={load} />
      ) : methods === null ? (
        <SkeletonCard rows={4} />
      ) : methods.length === 0 ? (
        <EmptyState icon="card-outline" title={t('onboard.payment.empty')} />
      ) : (
        <View style={{ gap: Spacing.md }}>
          {methods.map((m) => {
            const disabled = m.available === false;
            const active = effectiveDefault === m.id;
            return (
              <Pressable
                key={m.id}
                onPress={disabled ? undefined : () => choose(m)}
                disabled={disabled}
                accessibilityRole="button"
                accessibilityLabel={t('onboard.payment.setDefaultA11y', { method: m.label })}
                accessibilityState={{ disabled, selected: active }}
                style={({ pressed }) => [styles.methodRow, active && styles.methodRowActive, disabled && styles.methodRowDisabled, pressed && { opacity: 0.85 }]}>
                <Icon name={active ? 'radio-button-on' : 'radio-button-off'} size={18} color={active ? Colors.primary : Colors.borderStrong} />
                <View style={styles.methodIcon}>
                  <Icon name={methodIcon(m.method)} size={17} color={Colors.textSecondary} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.methodLabel}>{m.label}</Text>
                  {m.last4 ? <Text style={styles.methodSub}>•••• {m.last4}</Text> : null}
                </View>
                {disabled ? <Pill label={t('payments.unavailable')} tone="danger" /> : active ? <Pill label={t('onboard.payment.default')} tone="info" /> : null}
              </Pressable>
            );
          })}
          <Text style={styles.note}>{t('onboard.payment.note')}</Text>
        </View>
      )}

      <Btn label={t('onboard.continue')} onPress={onDone} size="lg" disabled={methods !== null && available.length > 0 && !effectiveDefault} style={{ marginTop: Spacing.xl }} />
      <Btn label={t('onboard.payment.skip')} onPress={onDone} variant="ghost" size="lg" style={{ marginTop: Spacing.md }} />
    </Screen>
  );
}

function CityStep({
  cities,
  error,
  selected,
  saving,
  onChoose,
  onRetry,
  onContinue,
}: {
  cities: City[] | null;
  error: string;
  selected: string | null;
  saving: boolean;
  onChoose: (city: City) => void;
  onRetry: () => void;
  onContinue: () => void;
}) {
  const [sheetVisible, setSheetVisible] = useState(false);
  const [detectError, setDetectError] = useState('');
  const [detectedArea, setDetectedArea] = useState<{ cityId: string; area: string } | null>(null);

  // GPS detect: permission sheet → Web Geolocation API → nearest seeded city.
  const onDetected = async (position: GeoPosition) => {
    setSheetVisible(false);
    setDetectError('');
    if (!cities?.length) {
      setDetectError(t('location.notFound'));
      return;
    }
    try {
      const result = await reverseGeocode(position.lat, position.lon, cities);
      const city = result.cityId ? cities.find((c) => c.id === result.cityId) : undefined;
      if (!city) {
        setDetectError(t('location.notFound'));
        return;
      }
      onChoose(city);
      useLocationStore.getState().setCity({
        id: city.id,
        name: city.name,
        serviceArea: result.serviceArea,
        serviceAreas: city.serviceAreas,
      });
      setDetectedArea(result.serviceArea ? { cityId: city.id, area: result.serviceArea } : null);
    } catch {
      setDetectError(t('location.unavailable'));
    }
  };

  const onGeoError = (e: GeoError) => {
    setSheetVisible(false);
    setDetectError(e.code === 'PERMISSION_DENIED' ? t('location.permissionDenied') : t('location.unavailable'));
  };

  if (error) {
    return (
      <Screen scroll contentStyle={{ justifyContent: 'center', flexGrow: 1 }}>
        <ErrorState message={error} onRetry={onRetry} />
      </Screen>
    );
  }

  if (!cities) {
    return (
      <Screen>
        <SkeletonCard rows={4} />
      </Screen>
    );
  }

  if (cities.length === 0) {
    return (
      <Screen scroll contentStyle={{ justifyContent: 'center', flexGrow: 1 }}>
        <EmptyState icon="location-outline" title={t('onboard.none')} />
      </Screen>
    );
  }

  return (
    <Screen scroll contentStyle={{ justifyContent: 'center', flexGrow: 1 }}>
      <Text style={styles.title}>{t('onboard.title')}</Text>
      <Text style={styles.sub}>{t('onboard.sub')}</Text>
      <Btn label={t('location.useMyLocation')} onPress={() => setSheetVisible(true)} variant="ghost" icon="locate" style={{ marginBottom: Spacing.md }} />
      {detectError ? <Text style={styles.error}>{detectError}</Text> : null}
      <View style={{ gap: Spacing.md }}>
        {cities.map((city) => {
          const active = selected === city.id;
          const detected = detectedArea?.cityId === city.id ? detectedArea.area : null;
          return (
            <Card key={city.id} onPress={() => onChoose(city)} style={[styles.cityCard, active && styles.cityCardActive]}>
              <View style={[styles.cityIcon, active && { backgroundColor: Colors.primary }]}>
                <Icon name="location" size={18} color={active ? Colors.white : Colors.textSecondary} />
              </View>
              <View style={{ flex: 1 }}>
                <Row gap={Spacing.sm}>
                  <Text style={styles.cityName}>{city.name}</Text>
                  {active && detected ? <Pill label={t('location.detectedArea', { area: detected })} tone="success" /> : null}
                </Row>
                <Text style={styles.cityAreas}>{(city.serviceAreas ?? []).map((a) => a.name).join(' · ') || city.country}</Text>
              </View>
              {active ? <Icon name="checkmark-circle" size={22} color={Colors.primary} /> : null}
            </Card>
          );
        })}
      </View>
      <Btn label={t('onboard.continue')} onPress={onContinue} size="lg" disabled={!selected} loading={saving} style={{ marginTop: Spacing.xl }} />

      <LocationPermissionSheet visible={sheetVisible} onClose={() => setSheetVisible(false)} onDetected={onDetected} onError={onGeoError} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  headerSafe: { backgroundColor: Colors.bg },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: Spacing.lg, paddingTop: Spacing.md, paddingBottom: Spacing.xs, minHeight: 44 },
  headerBackBtn: { minHeight: 44, minWidth: 44, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 6 },
  headerSpacer: { width: 44 },
  dots: { flexDirection: 'row', gap: Spacing.xs, alignItems: 'center' },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: Colors.borderStrong },
  dotActive: { backgroundColor: Colors.primary, width: 20, borderRadius: Radius.pill },
  slide: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: Spacing.xxl, gap: Spacing.lg },
  slideIcon: {
    width: 96,
    height: 96,
    borderRadius: 48,
    backgroundColor: Colors.primarySoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  slideTitle: { fontSize: FontSize.xxl, fontFamily: Fonts.displayBold, color: Colors.text, textAlign: 'center' },
  slideCopy: { fontSize: FontSize.md, color: Colors.textSecondary, fontFamily: Fonts.sans, textAlign: 'center', lineHeight: 22 },
  footer: { padding: Spacing.lg, gap: Spacing.lg, alignItems: 'center' },
  title: { fontSize: FontSize.xxl, fontFamily: Fonts.displayBold, color: Colors.text, marginBottom: Spacing.xs },
  sub: { fontSize: FontSize.sm, color: Colors.textTertiary, fontFamily: Fonts.sans, marginBottom: Spacing.xl, lineHeight: 19 },
  fieldLabel: { fontSize: FontSize.sm, color: Colors.textSecondary, fontFamily: Fonts.sansSemibold },
  noteTitle: { fontSize: FontSize.md, color: Colors.text, fontFamily: Fonts.sansSemibold },
  note: { fontSize: FontSize.sm, color: Colors.textTertiary, fontFamily: Fonts.sans, marginTop: 2, lineHeight: 18 },
  error: { color: Colors.danger, fontSize: FontSize.sm, fontFamily: Fonts.sansSemibold, marginTop: Spacing.md, backgroundColor: Colors.dangerSoft, paddingHorizontal: Spacing.md, paddingVertical: Spacing.sm, borderRadius: Radius.md, overflow: 'hidden' },
  hint: { color: Colors.success, fontSize: FontSize.xs, fontFamily: Fonts.sansSemibold, backgroundColor: Colors.successSoft, paddingHorizontal: Spacing.sm, paddingVertical: 4, borderRadius: Radius.sm, overflow: 'hidden', alignSelf: 'flex-start' },
  methodRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md, paddingVertical: Spacing.lg, paddingHorizontal: Spacing.lg, borderWidth: 1, borderColor: Colors.border, borderRadius: Radius.lg, backgroundColor: Colors.card },
  methodRowActive: { borderColor: Colors.primary, borderWidth: 1.5 },
  methodRowDisabled: { opacity: 0.5 },
  methodIcon: {
    width: 34,
    height: 34,
    borderRadius: 10,
    backgroundColor: Colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  methodLabel: { fontSize: FontSize.md, color: Colors.text, fontFamily: Fonts.sansMedium },
  methodSub: { fontSize: FontSize.xs, color: Colors.textTertiary, fontFamily: Fonts.sans, marginTop: 2 },
  cityCard: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md, paddingVertical: Spacing.lg, minHeight: 56 },
  cityCardActive: { borderColor: Colors.primary, borderWidth: 1.5 },
  cityIcon: {
    width: 36,
    height: 36,
    borderRadius: Radius.md,
    backgroundColor: Colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cityName: { fontSize: FontSize.md, fontFamily: Fonts.sansSemibold, color: Colors.text },
  cityAreas: { fontSize: FontSize.xs, color: Colors.textTertiary, fontFamily: Fonts.sans, marginTop: 2 },
});
