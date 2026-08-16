import { router } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { ApiError } from '@/api/client';
import { Card, ErrorCard, Icon, ListRow, Pill, Row, Screen, SectionTitle } from '@/components/ui';
import { Colors, FontSize, NumberStyle, Spacing } from '@/constants/theme';
import { t } from '@/i18n';
import { capitalize } from '@/lib/format';
import { getTrustRepository } from '@/repos';
import type { TrustProfile, TrustProfileTier } from '@hudumika/contract';

const TIER_TONE: Record<TrustProfileTier, 'neutral' | 'info' | 'success' | 'warning'> = {
  bronze: 'neutral',
  silver: 'info',
  gold: 'success',
  platinum: 'warning',
};

export default function TrustScreen() {
  const [trust, setTrust] = useState<TrustProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      setTrust(await getTrustRepository().get());
      setError('');
    } catch (e) {
      if (e instanceof ApiError && e.code === 'TRUST_PROFILE_UNAVAILABLE') {
        setError(t('misc.error'));
      } else {
        setError(e instanceof ApiError ? e.message : t('misc.error'));
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (loading && !trust) {
    return (
      <Screen>
        <View style={styles.center}>
          <ActivityIndicator color={Colors.primary} />
        </View>
      </Screen>
    );
  }

  if (error && !trust) {
    return (
      <Screen>
        <ErrorCard message={error} onRetry={load} />
      </Screen>
    );
  }

  if (!trust) return null;

  const flags = trust.flags ?? [];

  return (
    <Screen scroll>
      {error ? <ErrorCard message={error} onRetry={load} /> : null}

      <Card style={styles.scoreCard}>
        <Text style={styles.scoreLabel}>{t('trust.score')}</Text>
        <Text style={styles.scoreValue}>{trust.trustScore}</Text>
        <Row style={{ justifyContent: 'space-between', marginTop: Spacing.md }}>
          <View>
            <Text style={styles.metaLabel}>{t('trust.risk')}</Text>
            <Text style={styles.metaValue}>{trust.riskScore}</Text>
          </View>
          <View style={{ alignItems: 'flex-end' }}>
            <Text style={styles.metaLabel}>{t('trust.tier')}</Text>
            {trust.tier ? <Pill label={capitalize(trust.tier)} tone={TIER_TONE[trust.tier]} /> : <Text style={styles.metaValue}>—</Text>}
          </View>
        </Row>
        {trust.verifiedBadge ? <Pill label={t('trust.badge')} tone="success" /> : null}
      </Card>

      <SectionTitle title={t('trust.flags')} icon="flag-outline" />
      {flags.length === 0 ? (
        <Card>
          <Row gap={Spacing.sm}>
            <Icon name="shield-checkmark" size={18} color={Colors.success} />
            <Text style={styles.flagText}>{t('trust.noFlags')}</Text>
          </Row>
        </Card>
      ) : (
        <Card style={{ gap: Spacing.sm }}>
          {flags.map((flag) => (
            <Row key={flag} gap={Spacing.sm}>
              <Icon name="warning" size={16} color={Colors.warning} />
              <Text style={styles.flagText}>{t(`trust.flag.${flag}`)}</Text>
            </Row>
          ))}
        </Card>
      )}

      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t('trust.appeal')}
        onPress={() => router.push('/profile/support' as never)}
        style={({ pressed }) => [{ marginTop: Spacing.md }, pressed && { opacity: 0.7 }]}>
        <ListRow title={t('trust.appeal')} icon="chatbubble-ellipses-outline" />
      </Pressable>
    </Screen>
  );
}

const styles = StyleSheet.create({
  center: { alignItems: 'center', paddingVertical: 80 },
  scoreCard: { gap: Spacing.xs, alignItems: 'center' },
  scoreLabel: { fontSize: FontSize.sm, color: Colors.textTertiary, fontFamily: 'PlusJakartaSans_600SemiBold' },
  scoreValue: { fontSize: 56, fontFamily: 'SpaceGrotesk_700Bold', color: Colors.text, fontVariant: NumberStyle.fontVariant },
  metaLabel: { fontSize: FontSize.xs, color: Colors.textTertiary, fontFamily: 'PlusJakartaSans_600SemiBold' },
  metaValue: { fontSize: FontSize.xl, fontFamily: 'SpaceGrotesk_700Bold', color: Colors.text, fontVariant: NumberStyle.fontVariant },
  flagText: { flex: 1, fontSize: FontSize.sm, color: Colors.text, lineHeight: 19 },
});
