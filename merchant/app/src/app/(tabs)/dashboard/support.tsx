import { Stack, router } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Btn, Card, Empty, Icon, Pill, Row, Screen, SheetModal } from '@/components/ui';
import { Colors, FontSize, Radius, Spacing } from '@/constants/theme';
import { timeAgo } from '@/lib/format';
import { t, onLocaleChange, type I18nKey } from '@/i18n';
import { useSessionStore } from '@/store/session';
import { useSupportStore } from '@/store/support';
import type { HelpArticle, SupportTicket, TicketPriority } from '@/api/types';

/* Full contract status set (EDUCATION-SUPPORT.md §Service center) — legacy
 * list rows map replied → in progress; contract rows pass through. */
const STATUS_LABEL = (status: string): string =>
  status === 'open' ? t('sup.open')
    : status === 'assigned' ? t('sup.assigned')
    : status === 'in_progress' || status === 'replied' ? t('sup.inProgress')
    : status === 'resolved' ? t('sup.resolved')
    : status === 'closed' ? t('sup.closed')
    : status;

const STATUS_TONE = (status: string): 'neutral' | 'danger' | 'success' | 'info' | 'warning' =>
  status === 'open' ? 'warning'
    : status === 'assigned' ? 'info'
    : status === 'in_progress' || status === 'replied' ? 'info'
    : status === 'resolved' ? 'success'
    : status === 'closed' ? 'neutral'
    : 'neutral';

const PRIORITY_TONE: Record<TicketPriority, 'neutral' | 'danger' | 'success' | 'info' | 'warning'> = {
  low: 'neutral',
  normal: 'info',
  high: 'warning',
  critical: 'danger',
};

const ROLE_LABEL = (role: string) =>
  role === 'agent' ? t('sup.agent') : role === 'merchant' ? t('sup.you') : role === 'customer' ? t('sup.customer') : role;

/* Ticket categories → prefilled subjects (EDUCATION-SUPPORT.md §Service
 * center). Selecting a chip prefills the subject field. */
const TICKET_CATEGORIES: { key: string; label: I18nKey; subject: I18nKey }[] = [
  { key: 'payment', label: 'sup.catPayout', subject: 'sup.subPayout' },
  { key: 'payment', label: 'sup.catWithdrawal', subject: 'sup.subWithdrawal' },
  { key: 'account', label: 'sup.catClosure', subject: 'sup.subClosure' },
  { key: 'other', label: 'sup.catPromoAppeal', subject: 'sup.subPromo' },
  { key: 'equipment', label: 'sup.catDevice', subject: 'sup.subDevice' },
];

/* FAQ areas (EDUCATION-SUPPORT.md §Help/FAQ — 8 areas) → i18n section labels. */
const CATEGORY_LABELS: Record<string, I18nKey> = {
  orders: 'sup.catOrders',
  operations: 'sup.catOperations',
  'dine-in': 'sup.catDineIn',
  'group-buy': 'sup.catGroupBuy',
  promotions: 'sup.catPromotions',
  loyalty: 'sup.catLoyalty',
  wallet: 'sup.catWallet',
  'staff-devices': 'sup.catStaffDevices',
  settings: 'sup.catSettings',
};

const categoryLabel = (cat: string): string => (CATEGORY_LABELS[cat] ? t(CATEGORY_LABELS[cat]) : cat);

const statusOf = (tk: SupportTicket): string => tk.statusOverride ?? tk.status;

export default function SupportScreen() {
  useSyncExternalStore(onLocaleChange, () => 0);
  const perms = useSessionStore((s) => s.perms);
  const canSupport = perms.includes('*') || perms.includes('support');
  const tickets = useSupportStore((s) => s.tickets);
  const articles = useSupportStore((s) => s.articles);
  const detail = useSupportStore((s) => s.detail);
  const loading = useSupportStore((s) => s.loading);
  const error = useSupportStore((s) => s.error);
  const hydrate = useSupportStore((s) => s.hydrate);
  const openTicket = useSupportStore((s) => s.openTicket);
  const create = useSupportStore((s) => s.create);
  const reply = useSupportStore((s) => s.reply);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const [detailOpen, setDetailOpen] = useState(false);
  const [replyText, setReplyText] = useState('');
  const [article, setArticle] = useState<HelpArticle | null>(null);
  const [faqQuery, setFaqQuery] = useState('');

  useEffect(() => {
    hydrate();
  }, [hydrate]);

  const createTicket = async () => {
    if (!subject.trim() || !body.trim()) return;
    setBusy(true);
    setErrorMsg('');
    try {
      await create(subject.trim(), body.trim());
      setSubject('');
      setBody('');
      setShowForm(false);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : t('sup.err'));
    } finally {
      setBusy(false);
    }
  };

  const openDetail = async (id: string) => {
    setDetailOpen(true);
    setReplyText('');
    await openTicket(id);
  };

  const sendReply = async () => {
    if (!detail || !replyText.trim()) return;
    setBusy(true);
    setErrorMsg('');
    try {
      await reply(detail.id, replyText.trim());
      setReplyText('');
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : t('sup.err'));
    } finally {
      setBusy(false);
    }
  };

  const openArticle = (a: HelpArticle) => {
    /* FAQ deep links point into the relevant screen (API-provided values). */
    if (a.deepLink) {
      router.push(a.deepLink as never);
      return;
    }
    setArticle(a);
  };

  const escalateArticle = (a: HelpArticle) => {
    setArticle(null);
    setShowForm(true);
    setSubject(`[${a.title}]`);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  };

  /* FAQ: client-side search over the bundle (EDUCATION-SUPPORT.md §Help/FAQ). */
  const q = faqQuery.trim().toLowerCase();
  const visibleArticles = q
    ? articles.filter((a) => a.title.toLowerCase().includes(q) || a.body.toLowerCase().includes(q))
    : articles;
  const grouped = visibleArticles.reduce<Record<string, HelpArticle[]>>((acc, a) => {
    (acc[a.category] ??= []).push(a);
    return acc;
  }, {});

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: Colors.bg }} edges={['top']}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.topBar}>
        <Pressable onPress={() => router.back()} hitSlop={12}>
          <Icon name="chevron-back" size={26} color={Colors.text} />
        </Pressable>
        <Text style={styles.topTitle}>{t('sup.title')}</Text>
        <View style={{ width: 26 }} />
      </View>

      <Screen scroll>
        {!canSupport ? (
          <Card style={styles.noAccess}>
            <Icon name="lock-closed-outline" size={20} color={Colors.warning} />
            <Text style={{ flex: 1, fontSize: FontSize.sm, color: Colors.textSecondary }}>
              {t('sup.noPermission')}
            </Text>
          </Card>
        ) : (
          <>
            <Card style={{ gap: Spacing.sm }}>
              <Row gap={10}>
                <View style={styles.agentIcon}>
                  <Icon name="headset-outline" size={18} color={Colors.info} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: FontSize.sm, fontWeight: '800', color: Colors.text }}>{t('sup.helpCenter')}</Text>
                  <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary }}>{t('sup.sla')}</Text>
                </View>
              </Row>
              {showForm ? (
                <View style={{ gap: Spacing.sm }}>
                  <View style={{ gap: 6 }}>
                    <Text style={styles.fieldLabel}>{t('sup.category')}</Text>
                    <Row gap={8} style={{ flexWrap: 'wrap' }}>
                      {TICKET_CATEGORIES.map((c) => (
                        <Pressable
                          key={c.subject}
                          onPress={() => setSubject(t(c.subject))}
                          accessibilityRole="button"
                          style={[styles.categoryChip, subject === t(c.subject) && styles.categoryChipActive]}>
                          <Text style={[styles.categoryChipText, subject === t(c.subject) && { color: Colors.white, fontWeight: '700' }]}>
                            {t(c.label)}
                          </Text>
                        </Pressable>
                      ))}
                    </Row>
                  </View>
                  <TextInput value={subject} onChangeText={setSubject} placeholder={t('sup.subject')} placeholderTextColor={Colors.textTertiary} style={styles.input} maxLength={160} />
                  <TextInput
                    value={body}
                    onChangeText={setBody}
                    placeholder={t('sup.describe')}
                    placeholderTextColor={Colors.textTertiary}
                    style={[styles.input, styles.multiline]}
                    multiline
                    maxLength={4000}
                  />
                  {errorMsg ? <Text style={{ color: Colors.danger, fontSize: FontSize.xs }}>{errorMsg}</Text> : null}
                  <Row gap={10}>
                    <Btn label={t('sup.cancel')} variant="outline" size="sm" style={{ flex: 1 }} onPress={() => setShowForm(false)} />
                    <Btn label={t('sup.submit')} size="sm" style={{ flex: 2 }} loading={busy} disabled={!subject.trim() || !body.trim()} onPress={createTicket} />
                  </Row>
                </View>
              ) : (
                <Btn label={t('sup.newTicket')} icon="add" size="sm" onPress={() => setShowForm(true)} />
              )}
            </Card>

            <View style={{ gap: Spacing.md, marginTop: Spacing.md }}>
              {loading && tickets.length === 0 ? (
                <View style={{ gap: Spacing.md }}>
                  {[1, 2].map((i) => (
                    <Card key={i} style={{ gap: Spacing.md }}>
                      <View style={[styles.skeletonLine, { width: '55%' }]} />
                      <View style={[styles.skeletonLine, { width: '85%' }]} />
                      <View style={[styles.skeletonLine, { width: '35%' }]} />
                    </Card>
                  ))}
                </View>
              ) : null}

              {error && tickets.length === 0 ? (
                <Card style={{ gap: Spacing.sm, alignItems: 'center' }}>
                  <Icon name="cloud-offline-outline" size={22} color={Colors.danger} />
                  <Text style={{ fontSize: FontSize.sm, color: Colors.textSecondary, textAlign: 'center' }}>{t('sup.errLoad')}</Text>
                  <Btn label={t('common.retry')} size="sm" variant="outline" onPress={() => hydrate()} />
                </Card>
              ) : null}

              {!loading && !error && tickets.length === 0 ? <Empty icon="headset-outline" title={t('sup.empty')} /> : null}
              {tickets.map((tk) => (
                <Pressable key={tk.id} onPress={() => openDetail(tk.id)} style={({ pressed }) => [{ opacity: pressed ? 0.7 : 1 }]}>
                  <Card style={{ gap: Spacing.sm }}>
                    <Row style={{ justifyContent: 'space-between' }}>
                      <Text style={{ fontSize: FontSize.md, fontWeight: '700', color: Colors.text, flex: 1 }} numberOfLines={1}>{tk.subject}</Text>
                      <Pill label={STATUS_LABEL(statusOf(tk))} tone={STATUS_TONE(statusOf(tk))} />
                    </Row>
                    <Text style={{ fontSize: FontSize.sm, color: Colors.textSecondary, lineHeight: 19 }} numberOfLines={2}>{tk.body}</Text>
                    <Row style={{ justifyContent: 'space-between' }}>
                      <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary }}>{t('sup.opened', { time: timeAgo(tk.createdAt) })}</Text>
                      <Text style={{ fontSize: FontSize.xs, color: Colors.info, fontWeight: '700' }}>{t('sup.viewThread', { n: tk.replies.length })}</Text>
                    </Row>
                  </Card>
                </Pressable>
              ))}
            </View>

            <View style={{ marginTop: Spacing.lg }}>
              <Row style={{ justifyContent: 'space-between', marginBottom: Spacing.sm }}>
                <Text style={styles.sectionTitle}>{t('sup.articles')}</Text>
                <Icon name="book-outline" size={16} color={Colors.textTertiary} />
              </Row>
              <TextInput
                value={faqQuery}
                onChangeText={setFaqQuery}
                placeholder={t('sup.search')}
                placeholderTextColor={Colors.textTertiary}
                style={styles.input}
                accessibilityLabel={t('sup.search')}
              />
              {articles.length === 0 ? (
                <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary, marginTop: Spacing.sm }}>{t('sup.articlesEmpty')}</Text>
              ) : visibleArticles.length === 0 ? (
                <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary, marginTop: Spacing.sm }}>{t('sup.noResults')}</Text>
              ) : (
                <View style={{ gap: Spacing.lg, marginTop: Spacing.sm }}>
                  {Object.entries(grouped).map(([cat, rows]) => (
                    <View key={cat} style={{ gap: Spacing.sm }}>
                      <Text style={styles.categoryHeader}>{categoryLabel(cat)}</Text>
                      {rows.map((a) => (
                        <Pressable key={a.id} onPress={() => openArticle(a)} style={({ pressed }) => [{ opacity: pressed ? 0.7 : 1 }]}>
                          <Card style={styles.articleCard}>
                            <View style={{ flex: 1, gap: 2 }}>
                              <Text style={{ fontSize: FontSize.sm, fontWeight: '700', color: Colors.text }} numberOfLines={1}>{a.title}</Text>
                              <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary }} numberOfLines={2}>{a.body}</Text>
                            </View>
                            <Pill label={categoryLabel(cat)} tone="neutral" />
                          </Card>
                        </Pressable>
                      ))}
                    </View>
                  ))}
                </View>
              )}
            </View>
          </>
        )}
      </Screen>

      <SheetModal visible={detailOpen} onClose={() => setDetailOpen(false)} title={detail?.subject ?? ''}>
        {detail ? (
          <View style={{ gap: Spacing.md }}>
            <Row style={{ justifyContent: 'space-between' }}>
              <Row gap={8}>
                <Pill label={STATUS_LABEL(detail.status)} tone={STATUS_TONE(detail.status)} />
                <Pill label={`${t('sup.priority')} · ${detail.priority}`} tone={PRIORITY_TONE[detail.priority]} />
              </Row>
              <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary }}>{t('sup.opened', { time: timeAgo(detail.createdAt) })}</Text>
            </Row>
            <View style={{ gap: Spacing.sm }}>
              {detail.messages.length === 0 ? <Empty icon="chatbubble-ellipses-outline" title={t('sup.noMessages')} /> : null}
              {detail.messages.map((m) => (
                <View key={m.id} style={[styles.reply, m.authorRole === 'merchant' ? styles.replyMine : styles.replyAgent]}>
                  <Text style={{ fontSize: FontSize.xs, fontWeight: '700', color: m.authorRole === 'merchant' ? Colors.white : Colors.textSecondary, marginBottom: 2 }}>
                    {ROLE_LABEL(m.authorRole)}
                  </Text>
                  <Text style={{ fontSize: FontSize.xs, color: m.authorRole === 'merchant' ? Colors.white : Colors.textSecondary, lineHeight: 16 }}>{m.body}</Text>
                  <Text style={{ fontSize: 10, color: m.authorRole === 'merchant' ? 'rgba(255,255,255,0.7)' : Colors.textTertiary, marginTop: 2 }}>{timeAgo(m.createdAt)}</Text>
                </View>
              ))}
            </View>
            <View style={{ gap: Spacing.sm }}>
              <TextInput
                value={replyText}
                onChangeText={setReplyText}
                placeholder={t('sup.replyPh')}
                placeholderTextColor={Colors.textTertiary}
                style={[styles.input, styles.multiline]}
                multiline
                maxLength={4000}
              />
              {errorMsg ? <Text style={{ color: Colors.danger, fontSize: FontSize.xs }}>{errorMsg}</Text> : null}
              <Btn label={t('sup.sendReply')} size="sm" loading={busy} disabled={!replyText.trim()} onPress={sendReply} />
            </View>
          </View>
        ) : null}
      </SheetModal>

      <SheetModal visible={!!article} onClose={() => setArticle(null)} title={article?.title ?? ''}>
        {article ? (
          <View style={{ gap: Spacing.md }}>
            <Pill label={categoryLabel(article.category)} tone="info" />
            <Text style={{ fontSize: FontSize.sm, color: Colors.textSecondary, lineHeight: 21 }}>{article.body}</Text>
            {article.escalateToTicket ? (
              <Btn label={t('sup.escalate')} variant="outline" onPress={() => escalateArticle(article)} />
            ) : null}
          </View>
        ) : null}
      </SheetModal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.md,
    backgroundColor: Colors.card,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Colors.border,
  },
  topTitle: { fontSize: FontSize.lg, fontWeight: '800', color: Colors.text },
  noAccess: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  agentIcon: {
    width: 38,
    height: 38,
    borderRadius: 12,
    backgroundColor: Colors.infoSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sectionTitle: { fontSize: FontSize.sm, fontWeight: '800', color: Colors.text },
  articleCard: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 12 },
  input: {
    borderWidth: 1,
    borderColor: Colors.borderStrong,
    borderRadius: Radius.md,
    paddingHorizontal: Spacing.md,
    paddingVertical: 10,
    fontSize: FontSize.sm,
    color: Colors.text,
    backgroundColor: Colors.card,
  },
  multiline: { minHeight: 90, textAlignVertical: 'top' },
  reply: { borderRadius: Radius.md, padding: 10 },
  replyAgent: { backgroundColor: Colors.surface, alignSelf: 'flex-start' },
  replyMine: { backgroundColor: Colors.primary, alignSelf: 'flex-end' },
  fieldLabel: { fontSize: FontSize.sm, color: Colors.textSecondary, fontWeight: '600' },
  categoryChip: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: Radius.pill,
    borderWidth: 1,
    borderColor: Colors.borderStrong,
    backgroundColor: Colors.card,
  },
  categoryChipActive: { backgroundColor: Colors.primary, borderColor: Colors.primaryDark },
  categoryChipText: { fontSize: FontSize.xs, color: Colors.textSecondary },
  categoryHeader: { fontSize: FontSize.xs, fontWeight: '800', color: Colors.textTertiary, textTransform: 'uppercase', letterSpacing: 0.6 },
  skeletonLine: { height: 12, borderRadius: 6, backgroundColor: Colors.surface },
});
