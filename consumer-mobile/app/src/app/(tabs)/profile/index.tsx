import { useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Clipboard, Platform, Pressable, Share, StyleSheet, Text, TextInput, View } from 'react-native';

import { Avatar, Btn, Card, ErrorState, Icon, ListRow, Pill, Row, Screen, SectionTitle, SheetModal, SkeletonCard, type IconName } from '@/components/ui';
import { Colors, Fonts, FontSize, Radius, Spacing } from '@/constants/theme';
import { t } from '@/i18n';
import { getAuthRepository, getMembershipsRepository, getOrdersRepository, getReviewsRepository, getRewardsRepository } from '@/repos';
import { useSessionStore } from '@/store/session';
import { ApiError } from '@/api/client';
import { computeBadges, type Badge } from '@/lib/badges';
import { formatTZS } from '@/lib/format';
import { dateISO } from '@/lib/dates';
import { idempotencyKey } from '@/lib/idempotency';
import { toast } from '@/store/ui';
import type { BirthdayReward, CustomerMembership, ReferralSummary, RoleSummary } from '@hudumika/contract';

const CODE_RE = /^\d{4,8}$/;

interface MenuItem {
  key: string;
  label: string;
  icon: IconName;
  href: string;
  danger?: boolean;
}

export default function ProfileScreen() {
  const router = useRouter();
  const user = useSessionStore((s) => s.user);

  const [roles, setRoles] = useState<RoleSummary[] | null>(null);
  const [rolesSheet, setRolesSheet] = useState(false);
  const [explainSheet, setExplainSheet] = useState(false);
  const [codeSheet, setCodeSheet] = useState(false);
  const [noticeSheet, setNoticeSheet] = useState(false);
  const [selected, setSelected] = useState<RoleSummary | null>(null);
  const [requestId, setRequestId] = useState('');
  const [debugCode, setDebugCode] = useState('');
  const [code, setCode] = useState('');
  const [switchError, setSwitchError] = useState('');
  const [requesting, setRequesting] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [membership, setMembership] = useState<CustomerMembership | null>(null);
  const [badges, setBadges] = useState<Badge[] | null>(null);
  // M16f — live referral + birthday cards (contract /referrals/*, /rewards/birthday).
  // Each loads independently; a failure renders an inline retry, never a blocked profile.
  const [referral, setReferral] = useState<ReferralSummary | null>(null);
  const [referralError, setReferralError] = useState(false);
  const [referralLoading, setReferralLoading] = useState(true);
  const [birthday, setBirthday] = useState<BirthdayReward | null>(null);
  const [birthdayError, setBirthdayError] = useState(false);
  const [birthdayLoading, setBirthdayLoading] = useState(true);
  const [claimingBirthday, setClaimingBirthday] = useState(false);

  const loadRoles = useCallback(async () => {
    try {
      setRoles(await getAuthRepository().listRoles());
    } catch {
      setRoles([]); // the row simply stays hidden
    }
  }, []);

  const loadReferral = useCallback(async () => {
    setReferralError(false);
    setReferralLoading(true);
    try {
      setReferral(await getRewardsRepository().getMyReferral());
    } catch {
      setReferralError(true);
    } finally {
      setReferralLoading(false);
    }
  }, []);

  const loadBirthday = useCallback(async () => {
    setBirthdayError(false);
    setBirthdayLoading(true);
    try {
      setBirthday(await getRewardsRepository().getBirthdayReward());
    } catch {
      setBirthdayError(true);
    } finally {
      setBirthdayLoading(false);
    }
  }, []);

  // Rewards + badges (MASTER-BLUEPRINT §35/§36) — derived ONLY from real
  // data (completed orders, membership points, published reviews). Never
  // blocks the profile: a failure just leaves the sections hidden.
  const loadRewards = useCallback(async () => {
    try {
      const [m, orders, mine] = await Promise.all([
        getMembershipsRepository().get(),
        getOrdersRepository().list({ status: 'completed' }),
        getReviewsRepository().listMine(),
      ]);
      setMembership(m);
      const completedOrders = orders.filter((o) => o.status === 'completed').length;
      const publishedReviews = mine.filter((r) => r.state === 'published').length;
      setBadges(computeBadges({ completedOrders, points: m.points, publishedReviews }));
    } catch {
      /* sections stay hidden — profile is never blocked by rewards */
    }
  }, []);

  useEffect(() => {
    loadRoles();
    loadRewards();
    loadReferral();
    loadBirthday();
  }, [loadRoles, loadRewards, loadReferral, loadBirthday]);

  const sections: MenuItem[][] = [
    [
      { key: 'orders', label: t('profile.orders'), icon: 'receipt-outline', href: '/orders' },
      { key: 'addresses', label: t('addresses.title'), icon: 'location-outline', href: '/addresses' },
      { key: 'wallet', label: t('wallet.title'), icon: 'wallet-outline', href: '/wallet' },
      { key: 'payments', label: t('payments.title'), icon: 'card-outline', href: '/payments' },
      { key: 'coupons', label: t('coupons.title'), icon: 'pricetag-outline', href: '/coupons' },
      { key: 'vouchers', label: t('vouchers.title'), icon: 'qr-code-outline', href: '/vouchers' },
      { key: 'groupBuy', label: t('groupBuy.title'), icon: 'megaphone-outline', href: '/group-buys' },
      { key: 'reservations', label: t('reservation.title'), icon: 'restaurant-outline', href: '/reservations' },
      { key: 'dineIn', label: t('dineIn.title'), icon: 'fast-food-outline', href: '/dine-in' },
      { key: 'favorites', label: t('favorites.title'), icon: 'heart-outline', href: '/favorites' },
      { key: 'reviews', label: t('reviews.myReviews'), icon: 'star-outline', href: '/reviews' },
      { key: 'membership', label: t('membership.title'), icon: 'ribbon-outline', href: '/membership' },
    ],
    [
      { key: 'notifications', label: t('notifications.title'), icon: 'notifications-outline', href: '/notifications' },
      { key: 'disputes', label: t('disputes.title'), icon: 'shield-outline', href: '/disputes' },
      { key: 'support', label: t('support.title'), icon: 'headset-outline', href: '/support' },
      { key: 'settings', label: t('profile.settings'), icon: 'settings-outline', href: '/settings' },
    ],
  ];

  const logout = async () => {
    await useSessionStore.getState().logout();
    router.replace('/login');
  };

  const copyReferralCode = async (code: string) => {
    try {
      if (Platform.OS === 'web' && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(code);
      } else {
        Clipboard.setString(code);
      }
      toast(t('referral.copied'));
    } catch {
      /* clipboard unavailable — the code text stays selectable */
    }
  };

  const shareReferralCode = async (code: string) => {
    // Web: the code is copyable/selectable (same pattern as red-packets).
    if (Platform.OS === 'web') return;
    const payload = `hudumika://referral/${code}`;
    try {
      await Share.share({ message: payload, url: payload });
    } catch {
      /* share dismissed or unsupported */
    }
  };

  const claimBirthday = async () => {
    if (claimingBirthday) return;
    setClaimingBirthday(true);
    try {
      const key = idempotencyKey(user?.id ?? 'customer', 'birthday-claim');
      const reward = await getRewardsRepository().claimBirthdayReward(key);
      setBirthday(reward);
      toast(t('birthday.claimed'));
    } catch {
      toast(t('common.error'), 'error');
    } finally {
      setClaimingBirthday(false);
    }
  };

  const roleLabel = (role: RoleSummary): string => t(`role.${role.role}`);

  const pickRole = (role: RoleSummary) => {
    setRolesSheet(false);
    if (role.role === 'customer') return; // already in the customer view
    setSelected(role);
    setSwitchError('');
    setExplainSheet(true);
  };

  const requestVerification = async () => {
    if (!selected) return;
    setSwitchError('');
    setRequesting(true);
    try {
      const res = await useSessionStore.getState().requestOtp(user?.phone ?? '', 'verify_role');
      setRequestId(res.requestId);
      setDebugCode(res.debugCode ?? '');
      setCode('');
      setExplainSheet(false);
      setCodeSheet(true);
    } catch (e) {
      setSwitchError(e instanceof ApiError && e.code === 'INTERNAL_ERROR' ? t('error.generic') : e instanceof ApiError ? e.message : t('common.error'));
    } finally {
      setRequesting(false);
    }
  };

  const verify = async () => {
    if (!CODE_RE.test(code.trim())) {
      setSwitchError(t('login.wrongCode'));
      return;
    }
    setSwitchError('');
    setVerifying(true);
    try {
      await useSessionStore.getState().verifyOtp(requestId, code.trim(), 'verify_role');
      setCodeSheet(false);
      setNoticeSheet(true);
    } catch (e) {
      if (e instanceof ApiError) {
        if (e.code === 'OTP_MAX_ATTEMPTS') setSwitchError(t('login.maxAttempts'));
        else if (e.code === 'OTP_INVALID') setSwitchError(t('login.wrongCode'));
        else if (e.code === 'OTP_EXPIRED') setSwitchError(t('login.expired'));
        else if (e.code === 'INTERNAL_ERROR') setSwitchError(t('error.generic'));
        else setSwitchError(t('common.error'));
      } else {
        setSwitchError(t('common.error'));
      }
    } finally {
      setVerifying(false);
    }
  };

  return (
    <Screen scroll>
      <Card style={styles.profileCard}>
        <Row gap={Spacing.lg}>
          <Avatar name={user?.fullName ?? user?.phone ?? 'H'} size={56} />
          <View style={{ flex: 1 }}>
            <Text style={styles.name}>{user?.fullName ?? t('profile.title')}</Text>
            <Text style={styles.phone}>{user?.phone ?? ''}</Text>
            <Row gap={4} style={{ marginTop: 4 }}>
              <Icon name="shield-checkmark" size={13} color={Colors.success} />
              <Text style={styles.verified}>{t('profile.verified')}</Text>
            </Row>
          </View>
        </Row>
      </Card>

      {sections.map((section, i) => (
        <View key={i}>
          <SectionTitle title={t('profile.title')} />
          <Card flat style={{ padding: 0 }}>
            {section.map((item) => (
              <ListRow
                key={item.key}
                title={item.label}
                icon={item.icon}
                onPress={() => router.push(item.href as never)}
              />
            ))}
          </Card>
        </View>
      ))}

      {/* Rewards & badges — referral (contract /referrals/me) + birthday
          (contract /rewards/birthday) are live cards with per-card
          loading/error/retry; the birthday card shows only when the
          membership benefits do not already list one (mockState seeds
          'Birthday reward'). */}
      <View>
        <SectionTitle title={t('profile.rewards')} icon="gift" />
        <Card flat style={{ padding: 0 }}>
          {referralLoading ? (
            <View style={{ padding: Spacing.lg }}>
              <SkeletonCard rows={1} />
            </View>
          ) : referralError ? (
            <ErrorState message={t('common.error')} onRetry={loadReferral} />
          ) : referral ? (
            <View style={styles.referralBox}>
              <Row style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <View style={{ gap: 2 }}>
                  <Text style={styles.referralCode}>{referral.code}</Text>
                  <Text style={styles.referralMeta}>{t('referral.invited', { n: referral.invitedCount })}</Text>
                </View>
                <Pill
                  label={referral.rewardStatus === 'paid' ? t('referral.paid') : t('referral.pending')}
                  tone={referral.rewardStatus === 'paid' ? 'success' : 'info'}
                />
              </Row>
              <Row style={{ justifyContent: 'space-between', marginTop: Spacing.xs }}>
                <Text style={styles.referralMeta}>{t('referral.earned')}</Text>
                <Text style={styles.referralEarned}>{formatTZS(referral.totalRewardTZS ?? 0)}</Text>
              </Row>
              <Row style={{ gap: Spacing.sm, marginTop: Spacing.md }}>
                <Btn label={t('referral.copy')} onPress={() => copyReferralCode(referral.code)} variant="outline" size="sm" style={{ flex: 1 }} />
                <Btn label={t('referral.share')} onPress={() => shareReferralCode(referral.code)} size="sm" style={{ flex: 1 }} />
              </Row>
            </View>
          ) : null}
          <ListRow title={t('referral.claim')} icon="gift-outline" onPress={() => router.push('/referrals')} />
          {!(membership?.benefits ?? []).some((b) => b.toLowerCase().includes('birthday')) ? (
            birthdayLoading ? (
              <View style={{ padding: Spacing.lg }}>
                <SkeletonCard rows={1} />
              </View>
            ) : birthdayError ? (
              <ErrorState message={t('common.error')} onRetry={loadBirthday} />
            ) : birthday ? (
              <View style={styles.birthdayBox}>
                <Text style={styles.referralMeta}>
                  {birthday.claimed
                    ? t('birthday.claimed')
                    : birthday.available
                      ? t('birthday.ready', { amount: formatTZS(birthday.rewardTZS ?? 0) })
                      : t('birthday.notAvailable')}
                </Text>
                {birthday.claimed && birthday.expiresAt ? (
                  <Text style={styles.referralMeta}>{t('birthday.expires', { t: dateISO(birthday.expiresAt) })}</Text>
                ) : null}
                {birthday.available && !birthday.claimed ? (
                  <Btn label={t('birthday.claim')} onPress={claimBirthday} loading={claimingBirthday} size="sm" style={{ alignSelf: 'flex-start', marginTop: Spacing.sm }} />
                ) : null}
              </View>
            ) : null
          ) : null}
        </Card>
      </View>

      {badges ? (
        <View>
          <SectionTitle title={t('profile.badges')} icon="medal" />
          <Card flat style={{ padding: Spacing.lg, gap: Spacing.sm }}>
            <Row gap={Spacing.sm} style={{ flexWrap: 'wrap' }}>
              {badges.map((b) => (
                <View key={b.id} style={[styles.badgeChip, b.earned && styles.badgeChipEarned]}>
                  <Text style={[styles.badgeName, b.earned && { color: Colors.success }]}>{t(`badges.${b.id}`)}</Text>
                  <Text style={[styles.badgeState, b.earned && { color: Colors.success }]}>
                    {b.earned ? t('badges.earned') : t('badges.locked')}
                  </Text>
                </View>
              ))}
            </Row>
          </Card>
        </View>
      ) : null}

      {(roles ?? []).length > 1 ? (
        <View>
          <SectionTitle title={t('profile.title')} />
          <Card flat style={{ padding: 0 }}>
            <ListRow
              title={t('profile.switchAccount')}
              icon="swap-horizontal"
              onPress={() => setRolesSheet(true)}
            />
          </Card>
        </View>
      ) : null}

      <View style={{ height: Spacing.lg }} />
      <Btn label={t('profile.logout')} onPress={logout} variant="outline" />
      <Text style={styles.version}>{t('common.version', { version: '0.1.0' })}</Text>

      <SheetModal visible={rolesSheet} onClose={() => setRolesSheet(false)} title={t('switch.title')}>
        <View style={{ gap: Spacing.xs }}>
          {(roles ?? []).map((role) => (
            <Pressable
              key={role.role}
              onPress={() => pickRole(role)}
              accessibilityRole="button"
              style={styles.option}>
              <Text style={styles.optionText}>{roleLabel(role)}</Text>
              <Icon name="chevron-forward" size={15} color={Colors.textFaint} />
            </Pressable>
          ))}
        </View>
      </SheetModal>

      <SheetModal visible={explainSheet} onClose={() => setExplainSheet(false)} title={t('switch.title')}>
        <Text style={styles.switchTitle}>{t('switch.verifyExplain')}</Text>
        <Text style={styles.switchSub}>
          {selected ? t('switch.verifyExplainSub', { role: roleLabel(selected) }) : ''}
        </Text>
        {switchError ? <Text style={styles.switchError}>{switchError}</Text> : null}
        <Btn label={t('switch.continue')} onPress={requestVerification} size="lg" loading={requesting} style={{ marginTop: Spacing.md }} />
      </SheetModal>

      <SheetModal visible={codeSheet} onClose={() => setCodeSheet(false)} title={t('switch.codeTitle')}>
        <TextInput
          value={code}
          onChangeText={setCode}
          keyboardType="number-pad"
          maxLength={8}
          placeholder="000000"
          placeholderTextColor={Colors.textFaint}
          accessibilityLabel={t('login.code')}
          style={styles.codeInput}
        />
        {debugCode ? (
          <View style={styles.demoBox}>
            <Text style={styles.demoLabel}>{t('login.demoCode')}</Text>
            <Text style={styles.demoCode}>{debugCode}</Text>
          </View>
        ) : null}
        {switchError ? <Text style={styles.switchError}>{switchError}</Text> : null}
        <Btn label={t('switch.verify')} onPress={verify} size="lg" loading={verifying} style={{ marginTop: Spacing.md }} />
      </SheetModal>

      <SheetModal visible={noticeSheet} onClose={() => setNoticeSheet(false)} title={t('switch.verified')}>
        <Text style={styles.switchTitle}>
          {selected ? t('switch.notice', { role: roleLabel(selected) }) : ''}
        </Text>
        <Text style={styles.switchSub}>
          {selected ? t('switch.noticeSub', { role: roleLabel(selected) }) : ''}
        </Text>
        <Btn label={t('switch.done')} onPress={() => setNoticeSheet(false)} size="lg" style={{ marginTop: Spacing.md }} />
      </SheetModal>
    </Screen>
  );
}

const styles = StyleSheet.create({
  profileCard: { marginTop: Spacing.lg },
  name: { fontSize: FontSize.lg, fontFamily: Fonts.sansBold, color: Colors.text },
  phone: { fontSize: FontSize.sm, color: Colors.textTertiary, fontFamily: Fonts.sans, marginTop: 2 },
  verified: { fontSize: FontSize.xs, color: Colors.success, fontFamily: Fonts.sansMedium },
  badgeChip: {
    borderWidth: 1,
    borderColor: Colors.borderStrong,
    borderRadius: Radius.md,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    alignItems: 'center',
    gap: 2,
  },
  badgeChipEarned: { borderColor: Colors.success, backgroundColor: Colors.successSoft },
  badgeName: { fontSize: FontSize.sm, color: Colors.textSecondary, fontFamily: Fonts.sansSemibold },
  badgeState: { fontSize: FontSize.xs, color: Colors.textTertiary, fontFamily: Fonts.sans },
  referralBox: { padding: Spacing.lg, gap: Spacing.xs },
  referralCode: { fontSize: FontSize.xl, fontFamily: Fonts.sansExtraBold, color: Colors.primaryDeep, letterSpacing: 1 },
  referralMeta: { fontSize: FontSize.sm, color: Colors.textTertiary, fontFamily: Fonts.sans },
  referralEarned: { fontSize: FontSize.md, fontFamily: Fonts.sansBold, color: Colors.text, fontVariant: ['tabular-nums'] },
  birthdayBox: { padding: Spacing.lg, gap: Spacing.xs, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: Colors.border },
  version: { textAlign: 'center', color: Colors.textFaint, fontSize: FontSize.xs, fontFamily: Fonts.sans, marginTop: Spacing.xl },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderWidth: 1,
    borderColor: Colors.borderStrong,
    borderRadius: Radius.md,
    paddingHorizontal: Spacing.md,
    paddingVertical: 12,
  },
  optionText: { fontSize: FontSize.md, color: Colors.text, fontFamily: Fonts.sansMedium },
  switchTitle: { fontSize: FontSize.lg, fontFamily: Fonts.sansBold, color: Colors.text },
  switchSub: { fontSize: FontSize.sm, color: Colors.textTertiary, fontFamily: Fonts.sans, marginTop: Spacing.xs },
  switchError: { color: Colors.danger, fontSize: FontSize.sm, fontFamily: Fonts.sansSemibold, marginTop: Spacing.sm },
  codeInput: {
    borderWidth: 1,
    borderColor: Colors.borderStrong,
    borderRadius: Radius.md,
    paddingHorizontal: Spacing.md,
    paddingVertical: 12,
    fontSize: FontSize.xl,
    color: Colors.text,
    fontFamily: Fonts.sans,
    backgroundColor: Colors.card,
    letterSpacing: 6,
    textAlign: 'center',
  },
  demoBox: {
    backgroundColor: Colors.primarySoft,
    borderRadius: Radius.md,
    padding: Spacing.md,
    alignItems: 'center',
    gap: 4,
    borderWidth: 1,
    borderColor: Colors.primary,
    marginTop: Spacing.md,
  },
  demoLabel: { color: Colors.primaryDeep, fontSize: FontSize.xs, fontFamily: Fonts.sansSemibold },
  demoCode: { fontSize: 24, fontWeight: '900', color: Colors.text, letterSpacing: 6 },
});
