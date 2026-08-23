import { useEffect, useState, useSyncExternalStore } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import { Btn, Card, Empty, Icon, Row, Screen, SectionTitle } from '@/components/ui';
import { Colors, FontSize, Radius, Spacing } from '@/constants/theme';
import { t, onLocaleChange } from '@/i18n';
import { api, ApiError } from '@/api/client';

type DiagItem = { severity: 'high' | 'medium' | 'low' | 'info'; title: string; sub: string };

export default function DiagnosticsScreen() {
  useSyncExternalStore(onLocaleChange, () => 0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [items, setItems] = useState<DiagItem[] | null>(null);
  const [isComingSoon, setIsComingSoon] = useState(false);

  const load = async () => {
    setLoading(true);
    setError('');
    setIsComingSoon(false);
    try {
      const res = await api.get<{ diagnostics: DiagItem[] } | DiagItem[]>('/analytics/diagnostics', { retries: 1 });
      const list = Array.isArray(res) ? res : (res as { diagnostics: DiagItem[] }).diagnostics;
      if (!list || list.length === 0) {
        setItems([]);
      } else {
        setItems(list);
      }
    } catch (e) {
      const err = e as ApiError;
      // Mock returns 501 with code NOT_IMPLEMENTED or diagnostics empty — treat as coming soon
      if (err?.status === 501 || err?.code === 'NOT_IMPLEMENTED' || err?.code === 'DIAGNOSTICS_NOT_READY') {
        setIsComingSoon(true);
        setItems([]);
      } else {
        setError(err?.message || 'Failed to load diagnostics');
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  return (
    <Screen scroll>
      <SectionTitle title={t('diag.title')} icon="pulse" action={t('diag.refresh')} onAction={load} />
      <Text style={styles.sub}>{t('diag.sub')}</Text>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={Colors.primary} />
          <Text style={styles.loading}>{t('common.loading')}</Text>
        </View>
      ) : error ? (
        <Card style={styles.errorCard}>
          <Icon name="cloud-offline-outline" size={24} color={Colors.danger} />
          <Text style={styles.error}>{error}</Text>
          <Btn label={t('common.retry')} variant="outline" size="sm" onPress={load} />
        </Card>
      ) : isComingSoon ? (
        <Card style={styles.soonCard}>
          <Icon name="hourglass-outline" size={20} color={Colors.warning} />
          <Text style={styles.soonTitle}>{t('diag.comingSoon')}</Text>
          <Text style={styles.soonSub}>{t('diag.comingSoonSub')}</Text>
        </Card>
      ) : items && items.length === 0 ? (
        <Empty icon="pulse-outline" title={t('diag.empty')} sub={t('diag.emptySub')} />
      ) : (
        <View style={{ gap: Spacing.md, marginTop: Spacing.md }}>
          {items?.map((it, i) => (
            <Card key={i} style={styles.itemCard}>
              <Row gap={10}>
                <View style={[styles.sev, it.severity === 'high' ? { backgroundColor: Colors.dangerSoft } : it.severity === 'medium' ? { backgroundColor: Colors.warningSoft } : { backgroundColor: Colors.infoSoft }]}>
                  <Text style={[styles.sevText, { color: it.severity === 'high' ? Colors.danger : it.severity === 'medium' ? Colors.warning : Colors.info }]}>{it.severity.toUpperCase()}</Text>
                </View>
                <View style={{ flex: 1, gap: 2 }}>
                  <Text style={styles.itemTitle}>{it.title}</Text>
                  <Text style={styles.itemSub}>{it.sub}</Text>
                </View>
              </Row>
            </Card>
          ))}
        </View>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  sub: { fontSize: FontSize.sm, color: Colors.textSecondary, lineHeight: 18, marginTop: 4 },
  center: { alignItems: 'center', paddingVertical: 40, gap: 12 },
  loading: { fontSize: FontSize.sm, color: Colors.textTertiary },
  errorCard: { alignItems: 'center', gap: 12, paddingVertical: 24 },
  error: { fontSize: FontSize.sm, color: Colors.danger, textAlign: 'center' },
  soonCard: { alignItems: 'center', gap: 10, paddingVertical: 24, backgroundColor: Colors.warningSoft, borderWidth: 1, borderColor: `${Colors.warning}40`, marginTop: Spacing.md },
  soonTitle: { fontSize: FontSize.md, fontWeight: '800', color: Colors.text, textAlign: 'center' },
  soonSub: { fontSize: FontSize.sm, color: Colors.textSecondary, textAlign: 'center', lineHeight: 18, paddingHorizontal: Spacing.md },
  itemCard: { gap: Spacing.sm },
  sev: { paddingHorizontal: 8, paddingVertical: 4, borderRadius: Radius.pill, minWidth: 50, alignItems: 'center' },
  sevText: { fontSize: FontSize.xs, fontWeight: '800' },
  itemTitle: { fontSize: FontSize.sm, fontWeight: '700', color: Colors.text },
  itemSub: { fontSize: FontSize.xs, color: Colors.textTertiary, lineHeight: 16 },
});
