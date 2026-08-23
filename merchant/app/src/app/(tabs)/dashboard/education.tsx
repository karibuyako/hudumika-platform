import { useSyncExternalStore } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { Card, Empty, Icon, Row, Screen, SectionTitle } from '@/components/ui';
import { Colors, FontSize, Radius, Spacing } from '@/constants/theme';
import { t, onLocaleChange } from '@/i18n';

export default function EducationScreen() {
  useSyncExternalStore(onLocaleChange, () => 0);
  return (
    <Screen scroll>
      <Text style={styles.title}>{t('edu.title')}</Text>
      <Text style={styles.sub}>{t('edu.sub')}</Text>

      <SectionTitle title={t('edu.academy')} icon="school" />
      <Card style={styles.card}>
        <Row gap={12}>
          <View style={[styles.iconBox, { backgroundColor: Colors.infoSoft }]}>
            <Icon name="school-outline" size={20} color={Colors.info} />
          </View>
          <View style={{ flex: 1, gap: 4 }}>
            <Text style={styles.cardTitle}>{t('edu.academy')}</Text>
            <Text style={styles.cardSub}>{t('edu.academySub')}</Text>
          </View>
        </Row>
        <View style={styles.lessonList}>
          <LessonRow title="Menu photography that sells" sub="3 lessons · 15 min" />
          <LessonRow title="Pricing psychology" sub="2 lessons · 10 min" />
          <LessonRow title="Campaign builder mastery" sub="4 lessons · 20 min" />
        </View>
      </Card>

      <SectionTitle title={t('edu.tips')} icon="bulb" />
      <Card style={styles.card}>
        <Row gap={12}>
          <View style={[styles.iconBox, { backgroundColor: Colors.warningSoft }]}>
            <Icon name="bulb-outline" size={20} color={Colors.warning} />
          </View>
          <View style={{ flex: 1, gap: 4 }}>
            <Text style={styles.cardTitle}>{t('edu.tips')}</Text>
            <Text style={styles.cardSub}>{t('edu.tipsSub')}</Text>
          </View>
        </Row>
        <View style={styles.lessonList}>
          <TipRow text="Top stores reply to rush orders within 90s — set a 5-min preset" />
          <TipRow text="Keep low-stock alerts under 10% to avoid hidden items" />
          <TipRow text="Use featured slots (≤6) for your best margin dishes" />
        </View>
      </Card>

      <SectionTitle title={t('edu.enterprise')} icon="business" />
      <Card style={[styles.card, styles.enterpriseCard]}>
        <Row gap={12}>
          <View style={[styles.iconBox, { backgroundColor: Colors.primarySoft }]}>
            <Icon name="business-outline" size={20} color={Colors.primary} />
          </View>
          <View style={{ flex: 1, gap: 4 }}>
            <Text style={styles.cardTitle}>{t('edu.enterprise')}</Text>
            <Text style={styles.cardSub}>{t('edu.enterpriseSub')}</Text>
          </View>
        </Row>
        <View style={styles.soonBox}>
          <Icon name="hourglass-outline" size={16} color={Colors.textSecondary} />
          <View style={{ flex: 1, gap: 2 }}>
            <Text style={styles.soonTitle}>{t('edu.enterpriseSoon')}</Text>
            <Text style={styles.soonSub}>{t('edu.enterpriseSoonSub')}</Text>
          </View>
        </View>
        <View style={styles.lessonList}>
          <Empty icon="business-outline" title={t('edu.enterpriseSoon')} sub={t('edu.enterpriseSoonSub')} />
        </View>
      </Card>
    </Screen>
  );
}

function LessonRow({ title, sub }: { title: string; sub: string }) {
  return (
    <Row gap={10} style={styles.row}>
      <Icon name="play-circle-outline" size={18} color={Colors.primary} />
      <View style={{ flex: 1 }}>
        <Text style={styles.rowTitle}>{title}</Text>
        <Text style={styles.rowSub}>{sub}</Text>
      </View>
      <Icon name="chevron-forward" size={14} color={Colors.textTertiary} />
    </Row>
  );
}

function TipRow({ text }: { text: string }) {
  return (
    <Row gap={10} style={styles.row}>
      <View style={styles.bullet} />
      <Text style={styles.rowTitle}>{text}</Text>
    </Row>
  );
}

const styles = StyleSheet.create({
  title: { fontSize: FontSize.xxl, fontWeight: '800', color: Colors.text, marginTop: Spacing.md },
  sub: { fontSize: FontSize.sm, color: Colors.textSecondary, marginTop: 4, lineHeight: 18 },
  card: { gap: Spacing.md, marginTop: Spacing.sm },
  enterpriseCard: { borderWidth: 1, borderColor: Colors.borderStrong, backgroundColor: Colors.card },
  iconBox: { width: 40, height: 40, borderRadius: Radius.md, alignItems: 'center', justifyContent: 'center' },
  cardTitle: { fontSize: FontSize.md, fontWeight: '800', color: Colors.text },
  cardSub: { fontSize: FontSize.xs, color: Colors.textTertiary, lineHeight: 16 },
  lessonList: { gap: 8, marginTop: Spacing.sm },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10, paddingHorizontal: 12, backgroundColor: Colors.surface, borderRadius: Radius.md, borderWidth: 1, borderColor: Colors.border },
  rowTitle: { fontSize: FontSize.sm, fontWeight: '600', color: Colors.text, flex: 1 },
  rowSub: { fontSize: FontSize.xs, color: Colors.textTertiary, marginTop: 2 },
  bullet: { width: 6, height: 6, borderRadius: 3, backgroundColor: Colors.primary },
  soonBox: { flexDirection: 'row', gap: 10, backgroundColor: Colors.warningSoft, borderRadius: Radius.md, padding: 12, borderWidth: 1, borderColor: `${Colors.warning}40`, marginTop: Spacing.sm },
  soonTitle: { fontSize: FontSize.sm, fontWeight: '800', color: Colors.text },
  soonSub: { fontSize: FontSize.xs, color: Colors.textSecondary, lineHeight: 16 },
});
