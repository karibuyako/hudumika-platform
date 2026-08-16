import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { ApiError } from '@/api/client';
import { Btn, Card, Empty, Field, Icon, Pill, Row, Screen, SectionTitle, SheetModal, Spinner, ToggleRow } from '@/components/ui';
import { Colors, FontSize, NumberStyle, Radius, Spacing } from '@/constants/theme';
import { t } from '@/i18n';
import { dateISO } from '@/lib/format';
import { getDeliveryRepository, getSafetyRepository } from '@/repos';
import { useSessionStore } from '@/store/session';
import type { GetRiderSecurity200, Order, SosAlert, SosAlertType, TrustedContact } from '@hudumika/contract';

const SOS_TYPES: SosAlertType[] = ['safety', 'medical', 'mechanical', 'other'];
const CONTACT_MAX = 5;
const RECIPIENT_MAX = 5;

const SHAREABLE_STATUSES = ['rider_assigned', 'rider_arrived_pickup', 'picked_up', 'delivering', 'rider_arrived_dropoff'];

const SOS_STATUS_KEY: Record<SosAlert['status'], 'safety.sosStatusOpen' | 'safety.sosStatusAcknowledged' | 'safety.sosStatusResolved'> = {
  open: 'safety.sosStatusOpen',
  acknowledged: 'safety.sosStatusAcknowledged',
  resolved: 'safety.sosStatusResolved',
};

const SOS_STATUS_TONE: Record<SosAlert['status'], 'danger' | 'info' | 'success'> = {
  open: 'danger',
  acknowledged: 'info',
  resolved: 'success',
};

const SEVERITY_TONE: Record<string, 'neutral' | 'warning' | 'danger'> = { low: 'neutral', medium: 'warning', high: 'danger' };

export default function SafetyScreen() {
  const rider = useSessionStore((s) => s.rider);

  /* ---- SOS ---- */
  const [sosVisible, setSosVisible] = useState(false);
  const [sosType, setSosType] = useState<SosAlertType>('safety');
  const [sosNote, setSosNote] = useState('');
  const [sending, setSending] = useState(false);
  const [sosError, setSosError] = useState('');
  const [rateLimitUntil, setRateLimitUntil] = useState(0);
  const [alert, setAlert] = useState<SosAlert | null>(null);

  /* ---- Trusted contacts ---- */
  const [contacts, setContacts] = useState<TrustedContact[] | null>(null);
  const [contactsError, setContactsError] = useState('');
  const [addVisible, setAddVisible] = useState(false);
  const [contactName, setContactName] = useState('');
  const [contactPhone, setContactPhone] = useState('');
  const [adding, setAdding] = useState(false);
  const [contactError, setContactError] = useState('');
  const [removeTarget, setRemoveTarget] = useState<TrustedContact | null>(null);
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState('');

  /* ---- Security score ---- */
  const [security, setSecurity] = useState<GetRiderSecurity200 | null>(null);
  const [securityError, setSecurityError] = useState('');

  /* ---- Trip share ---- */
  const [orders, setOrders] = useState<Order[] | null>(null);
  const [ordersError, setOrdersError] = useState('');
  const [recipients, setRecipients] = useState<Record<string, string[]>>({});
  const [recipientDrafts, setRecipientDrafts] = useState<Record<string, string>>({});
  const [includeRoute, setIncludeRoute] = useState(true);
  const [shares, setShares] = useState<Record<string, { shareToken: string; expiresAt: string }>>({});
  const [sharingOrder, setSharingOrder] = useState('');
  const [shareError, setShareError] = useState('');

  const loadContacts = useCallback(async () => {
    setContactsError('');
    try {
      setContacts(await getSafetyRepository().listTrustedContacts());
    } catch (e) {
      setContactsError(e instanceof ApiError ? e.message : t('safety.contactsLoadFailed'));
    }
  }, []);

  const loadSecurity = useCallback(async () => {
    setSecurityError('');
    try {
      setSecurity(await getSafetyRepository().getSecurityScore());
    } catch (e) {
      setSecurityError(e instanceof ApiError ? e.message : t('safety.securityLoadFailed'));
    }
  }, []);

  const loadOrders = useCallback(async () => {
    setOrdersError('');
    try {
      const all = await getDeliveryRepository().listMyOrders('active');
      setOrders(all.filter((o) => SHAREABLE_STATUSES.includes(o.status)));
    } catch (e) {
      setOrdersError(e instanceof ApiError ? e.message : t('orders.loadFailed'));
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      loadContacts();
      loadSecurity();
      loadOrders();
    }, [loadContacts, loadSecurity, loadOrders]),
  );

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const iv = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(iv);
  }, []);
  useEffect(() => {
    if (rateLimitUntil <= Date.now()) return;
    const iv = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(iv);
  }, [rateLimitUntil]);
  const retryInSeconds = Math.max(0, Math.ceil((rateLimitUntil - now) / 1000));

  const openSos = () => {
    if (retryInSeconds > 0) return;
    setSosType('safety');
    setSosNote('');
    setSosError('');
    setSosVisible(true);
  };

  const sendSos = async () => {
    setSending(true);
    setSosError('');
    const loc = rider?.lastLocation;
    try {
      const created = await getSafetyRepository().createSos({
        type: sosType,
        note: sosNote.trim() || undefined,
        lat: loc?.lat,
        lon: loc?.lon,
      });
      setAlert(created);
      setSosVisible(false);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'SOS_RATE_LIMITED') {
        const seconds = typeof e.details?.retryAfterSeconds === 'number' ? e.details.retryAfterSeconds : 60;
        setRateLimitUntil(Date.now() + seconds * 1000);
        setSosVisible(false);
      } else {
        setSosError(e instanceof ApiError ? e.message : t('safety.loadFailed'));
      }
    } finally {
      setSending(false);
    }
  };

  const submitContact = async () => {
    if (!contactName.trim() || !contactPhone.trim()) return;
    setAdding(true);
    setContactError('');
    try {
      await getSafetyRepository().addTrustedContact({ name: contactName.trim(), phone: contactPhone.trim() });
      setAddVisible(false);
      setContactName('');
      setContactPhone('');
      await loadContacts();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'CONTACT_LIMIT_REACHED') {
        setContactError(t('safety.contactsLimitReached'));
      } else {
        setContactError(e instanceof ApiError ? e.message : t('safety.contactAddFailed'));
      }
    } finally {
      setAdding(false);
    }
  };

  const confirmRemove = async () => {
    if (!removeTarget?.id) return;
    setRemoving(true);
    setRemoveError('');
    try {
      await getSafetyRepository().removeTrustedContact(removeTarget.id);
      setRemoveTarget(null);
      await loadContacts();
    } catch (e) {
      setRemoveError(e instanceof ApiError ? e.message : t('safety.contactRemoveFailed'));
    } finally {
      setRemoving(false);
    }
  };

  const addRecipient = (orderId: string) => {
    const draft = (recipientDrafts[orderId] ?? '').trim();
    if (!draft) return;
    const current = recipients[orderId] ?? [];
    if (current.length >= RECIPIENT_MAX) {
      setShareError(t('safety.contactsLimit', { max: RECIPIENT_MAX }));
      return;
    }
    setRecipients({ ...recipients, [orderId]: [...current, draft] });
    setRecipientDrafts({ ...recipientDrafts, [orderId]: '' });
    setShareError('');
  };

  const removeRecipient = (orderId: string, phone: string) => {
    setRecipients({ ...recipients, [orderId]: (recipients[orderId] ?? []).filter((r) => r !== phone) });
  };

  const createShare = async (orderId: string) => {
    const list = recipients[orderId] ?? [];
    if (list.length === 0) return;
    setSharingOrder(orderId);
    setShareError('');
    try {
      const share = await getSafetyRepository().shareTrip(orderId, list, includeRoute);
      setShares({ ...shares, [orderId]: share });
      setRecipients({ ...recipients, [orderId]: [] });
    } catch (e) {
      setShareError(e instanceof ApiError ? e.message : t('safety.shareFailed'));
    } finally {
      setSharingOrder('');
    }
  };

  const isShareExpired = (expiresAt: string, nowMs: number) => Date.parse(expiresAt) <= nowMs;

  return (
    <Screen scroll>
      {/* SOS */}
      <SectionTitle title={t('safety.sosTitle')} icon="alert-circle-outline" />
      <Card style={{ gap: Spacing.md, alignItems: 'center' }}>
        {alert ? (
          <View style={styles.alertCard}>
            <Row style={{ justifyContent: 'space-between', alignSelf: 'stretch' }}>
              <Pill label={t(SOS_STATUS_KEY[alert.status])} tone={SOS_STATUS_TONE[alert.status]} />
            </Row>
            <Text style={styles.alertTitle}>{t('safety.sosAlertSent')}</Text>
            <Text style={styles.alertSub}>{t('safety.sosDispatchNotified')}</Text>
            <Text style={styles.alertMeta}>{t('safety.sosAlertId', { id: alert.id })}</Text>
            <Text style={styles.alertMeta}>{t('safety.sosSentAt', { time: dateISO(alert.createdAt) })}</Text>
          </View>
        ) : null}
        {retryInSeconds > 0 ? (
          <Text style={styles.warningText}>{t('safety.sosRetryIn', { seconds: retryInSeconds })}</Text>
        ) : null}
        <Btn label={t('safety.sos')} icon="alert-circle" variant="danger" size="lg" onPress={openSos} style={{ alignSelf: 'stretch', minHeight: 56 }} />
        {sosError ? <Text style={styles.error}>{sosError}</Text> : null}
      </Card>

      {/* Trusted contacts */}
      <SectionTitle title={t('safety.contacts')} icon="people-outline" action={t('safety.contactsAdd')} onAction={() => { setContactError(''); setAddVisible(true); }} />
      {contactsError ? (
        <Card style={{ gap: Spacing.sm }}>
          <Text style={styles.error}>{contactsError}</Text>
          <Btn label={t('common.retry')} variant="ghost" size="sm" onPress={loadContacts} />
        </Card>
      ) : contacts === null ? (
        <View style={styles.loadingBox}>
          <Spinner color={Colors.primary} />
        </View>
      ) : contacts.length === 0 ? (
        <Empty icon="people-outline" title={t('safety.contactsEmpty')} />
      ) : (
        <Card flat style={{ paddingHorizontal: Spacing.lg }}>
          {contacts.map((c, i) => (
            <View key={c.id} style={i > 0 ? styles.rowBorder : undefined}>
              <Row style={{ justifyContent: 'space-between' }}>
                <View style={{ flex: 1, paddingRight: Spacing.md, gap: 2 }}>
                  <Text style={styles.contactName}>{c.name}</Text>
                  <Text style={styles.contactSub}>
                    {c.relationship ? `${c.relationship} · ` : ''}
                    {c.notifiedOnSos === false ? '' : `${t('safety.contactNotifySos')} · `}
                    {c.shareLocation === true ? t('safety.contactShareLocation') : ''}
                  </Text>
                </View>
                <Btn label={t('common.remove')} variant="ghost" size="sm" onPress={() => { setRemoveError(''); setRemoveTarget(c); }} />
              </Row>
            </View>
          ))}
        </Card>
      )}
      {contacts !== null && contacts.length >= CONTACT_MAX ? (
        <Text style={styles.limitText}>{t('safety.contactsLimit', { max: CONTACT_MAX })}</Text>
      ) : null}

      {/* Security score */}
      <SectionTitle title={t('safety.securityTitle')} icon="shield-checkmark-outline" />
      {securityError ? (
        <Card style={{ gap: Spacing.sm }}>
          <Text style={styles.error}>{securityError}</Text>
          <Btn label={t('common.retry')} variant="ghost" size="sm" onPress={loadSecurity} />
        </Card>
      ) : security === null ? (
        <View style={styles.loadingBox}>
          <Spinner color={Colors.primary} />
        </View>
      ) : (
        <Card style={{ gap: Spacing.md }}>
          <Row style={{ justifyContent: 'space-between', alignItems: 'center' }}>
            <Text style={styles.cardTitle}>{t('safety.securitySub')}</Text>
            {security.securityScore != null ? (
              <Text style={styles.scoreValue}>{security.securityScore}</Text>
            ) : (
              <Text style={styles.warningText}>{t('safety.securityScoreUnavailable')}</Text>
            )}
          </Row>
          <Text style={styles.cardTitle}>{t('safety.securityAlerts')}</Text>
          {security.alerts.length === 0 ? (
            <Text style={styles.contactSub}>{t('safety.securityNone')}</Text>
          ) : (
            security.alerts.map((a, i) => (
              <Row key={`${a.type}-${i}`} style={{ justifyContent: 'space-between' }}>
                <View style={{ flex: 1, paddingRight: Spacing.md }}>
                  <Text style={styles.contactName}>{a.type}</Text>
                  <Text style={styles.contactSub}>{dateISO(a.at)}</Text>
                </View>
                <Pill label={t(`safety.severity.${a.severity}`)} tone={SEVERITY_TONE[a.severity]} />
              </Row>
            ))
          )}
        </Card>
      )}

      {/* Trip sharing */}
      <SectionTitle title={t('safety.shareTitle')} icon="navigate-outline" />
      {ordersError ? (
        <Card style={{ gap: Spacing.sm }}>
          <Text style={styles.error}>{ordersError}</Text>
          <Btn label={t('common.retry')} variant="ghost" size="sm" onPress={loadOrders} />
        </Card>
      ) : orders === null ? (
        <View style={styles.loadingBox}>
          <Spinner color={Colors.primary} />
        </View>
      ) : orders.length === 0 ? (
        <Empty icon="navigate-outline" title={t('safety.shareNoActive')} sub={t('safety.shareSub')} />
      ) : (
        <View style={{ gap: Spacing.md }}>
          {orders.map((o) => {
            const share = shares[o.id];
            const expired = share ? isShareExpired(share.expiresAt, now) : false;
            return (
              <Card key={o.id} style={{ gap: Spacing.md }}>
                <Text style={styles.cardTitle}>{t('safety.shareOrder', { no: o.no ?? o.id })}</Text>
                {share && !expired ? (
                  <View style={{ gap: Spacing.xs }}>
                    <Text style={styles.tokenText}>{t('safety.shareToken', { token: share.shareToken })}</Text>
                    <Text style={styles.contactSub}>{t('safety.shareExpires', { time: dateISO(share.expiresAt) })}</Text>
                    <Btn label={t('safety.shareCreateAnother')} variant="outline" size="sm" onPress={() => createShare(o.id)} loading={sharingOrder === o.id} disabled={(recipients[o.id] ?? []).length === 0} />
                  </View>
                ) : (
                  <View style={{ gap: Spacing.md }}>
                    {expired ? <Text style={styles.warningText}>{t('safety.shareExpired')}</Text> : null}
                    <Text style={styles.contactSub}>{t('safety.shareRecipients')}</Text>
                    <View style={styles.recipientChips}>
                      {(recipients[o.id] ?? []).map((r) => (
                        <Pressable
                          key={r}
                          onPress={() => removeRecipient(o.id, r)}
                          accessibilityRole="button"
                          accessibilityLabel={t('common.remove')}
                          hitSlop={8}
                          style={({ pressed }) => [styles.filterChip, pressed && { opacity: 0.7 }]}>
                          <Text style={styles.filterChipText}>{r}</Text>
                          <Icon name="close-circle" size={13} color={Colors.textTertiary} />
                        </Pressable>
                      ))}
                    </View>
                    <View style={styles.filterInputRow}>
                      <TextInput
                        value={recipientDrafts[o.id] ?? ''}
                        onChangeText={(v) => setRecipientDrafts({ ...recipientDrafts, [o.id]: v })}
                        placeholder={t('safety.shareRecipientPlaceholder')}
                        placeholderTextColor={Colors.textTertiary}
                        keyboardType="phone-pad"
                        onSubmitEditing={() => addRecipient(o.id)}
                        returnKeyType="done"
                        accessibilityLabel={t('safety.shareRecipients')}
                        style={styles.filterInput}
                      />
                      <Btn label={t('safety.shareAddRecipient')} variant="ghost" size="sm" onPress={() => addRecipient(o.id)} />
                    </View>
                    <ToggleRow label={t('safety.shareIncludeRoute')} sub={t('safety.shareIncludeRouteSub')} value={includeRoute} onChange={setIncludeRoute} />
                    <Btn label={t('safety.shareCreate')} icon="share-social-outline" onPress={() => createShare(o.id)} loading={sharingOrder === o.id} disabled={(recipients[o.id] ?? []).length === 0} />
                  </View>
                )}
              </Card>
            );
          })}
        </View>
      )}
      {shareError ? <Text style={styles.error}>{shareError}</Text> : null}

      {/* SOS confirm sheet */}
      <SheetModal visible={sosVisible} onClose={() => setSosVisible(false)} title={t('safety.sosTitle')}>
        <View style={{ gap: Spacing.md }}>
          <Text style={styles.contactSub}>{t('safety.sosSub')}</Text>
          <Text style={styles.fieldLabel}>{t('safety.sosType')}</Text>
          <Row gap={Spacing.sm} style={{ flexWrap: 'wrap' }}>
            {SOS_TYPES.map((ty) => (
              <Pressable
                key={ty}
                onPress={() => setSosType(ty)}
                accessibilityRole="button"
                accessibilityLabel={t(`safety.type.${ty}`)}
                accessibilityState={{ selected: sosType === ty }}
                style={({ pressed }) => [styles.typeChip, sosType === ty && styles.typeChipActive, pressed && { opacity: 0.7 }]}>
                <Text style={[styles.typeChipText, sosType === ty && { color: Colors.white }]}>{t(`safety.type.${ty}`)}</Text>
              </Pressable>
            ))}
          </Row>
          <Field label={t('safety.sosNote')} value={sosNote} onChangeText={setSosNote} placeholder={t('safety.sosNotePlaceholder')} multiline maxLength={500} />
          <Row gap={Spacing.sm}>
            <Icon name={rider?.lastLocation ? 'location' : 'location-outline'} size={15} color={rider?.lastLocation ? Colors.success : Colors.textTertiary} />
            <Text style={styles.contactSub}>{rider?.lastLocation ? t('safety.sosLocationAttached') : t('safety.sosLocationNone')}</Text>
          </Row>
          {sosError ? <Text style={styles.error}>{sosError}</Text> : null}
          <Btn label={t('safety.sosSend')} icon="alert-circle" variant="danger" size="lg" onPress={sendSos} loading={sending} />
        </View>
      </SheetModal>

      {/* Add contact sheet */}
      <SheetModal visible={addVisible} onClose={() => setAddVisible(false)} title={t('safety.contactsAdd')}>
        <View style={{ gap: Spacing.md }}>
          <Field label={t('safety.contactName')} value={contactName} onChangeText={setContactName} placeholder={t('safety.contactNamePlaceholder')} maxLength={120} />
          <Field label={t('safety.contactPhone')} value={contactPhone} onChangeText={setContactPhone} placeholder={t('safety.contactPhonePlaceholder')} keyboardType="phone-pad" />
          {contactError ? <Text style={styles.error}>{contactError}</Text> : null}
          <Btn label={t('safety.contactsAdd')} icon="person-add-outline" onPress={submitContact} loading={adding} disabled={!contactName.trim() || !contactPhone.trim()} size="lg" />
        </View>
      </SheetModal>

      {/* Remove contact confirm */}
      <SheetModal visible={!!removeTarget} onClose={() => setRemoveTarget(null)} title={t('safety.contactRemoveTitle')}>
        <View style={{ gap: Spacing.md }}>
          <Text style={styles.contactSub}>{t('safety.contactRemoveSub')}</Text>
          {removeError ? <Text style={styles.error}>{removeError}</Text> : null}
          <Row gap={Spacing.md}>
            <Btn label={t('common.cancel')} variant="outline" onPress={() => setRemoveTarget(null)} style={{ flex: 1 }} disabled={removing} />
            <Btn label={t('common.confirm')} variant="danger" onPress={confirmRemove} loading={removing} style={{ flex: 1 }} />
          </Row>
        </View>
      </SheetModal>
    </Screen>
  );
}

const styles = StyleSheet.create({
  loadingBox: { paddingVertical: Spacing.xl, alignItems: 'center' },
  error: { color: Colors.danger, fontSize: FontSize.sm },
  warningText: { color: Colors.warning, fontSize: FontSize.sm, fontWeight: '600' },
  limitText: { color: Colors.textTertiary, fontSize: FontSize.xs, marginTop: Spacing.sm },
  alertCard: { alignItems: 'center', gap: Spacing.xs, alignSelf: 'stretch' },
  alertTitle: { fontSize: FontSize.lg, fontWeight: '800', color: Colors.text },
  alertSub: { fontSize: FontSize.sm, color: Colors.textSecondary, textAlign: 'center' },
  alertMeta: { fontSize: FontSize.xs, color: Colors.textTertiary, fontVariant: NumberStyle.fontVariant },
  cardTitle: { fontSize: FontSize.md, fontWeight: '700', color: Colors.text },
  fieldLabel: { fontSize: FontSize.sm, color: Colors.textSecondary, fontWeight: '700' },
  contactName: { fontSize: FontSize.md, color: Colors.text, fontWeight: '600' },
  contactSub: { fontSize: FontSize.xs, color: Colors.textTertiary, lineHeight: 17 },
  rowBorder: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: Colors.border },
  scoreValue: { fontSize: FontSize.xxl, fontWeight: '900', color: Colors.primaryDeep, fontVariant: NumberStyle.fontVariant },
  typeChip: {
    paddingHorizontal: Spacing.md,
    paddingVertical: 8,
    borderRadius: Radius.pill,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.borderStrong,
  },
  typeChipActive: { backgroundColor: Colors.ink, borderColor: Colors.ink },
  typeChipText: { color: Colors.textSecondary, fontSize: FontSize.sm, fontWeight: '600' },
  filterChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: Colors.surface,
    borderRadius: Radius.pill,
    paddingHorizontal: Spacing.md,
    paddingVertical: 6,
    borderWidth: 1,
    borderColor: Colors.borderStrong,
  },
  filterChipText: { color: Colors.textSecondary, fontSize: FontSize.sm, fontWeight: '600' },
  recipientChips: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.sm },
  filterInputRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm },
  filterInput: {
    flex: 1,
    borderWidth: 1,
    borderColor: Colors.borderStrong,
    borderRadius: Radius.md,
    paddingHorizontal: Spacing.md,
    paddingVertical: 8,
    fontSize: FontSize.sm,
    color: Colors.text,
    backgroundColor: Colors.card,
  },
  tokenText: { fontSize: FontSize.sm, color: Colors.primaryDeep, fontWeight: '700', fontVariant: NumberStyle.fontVariant },
});
