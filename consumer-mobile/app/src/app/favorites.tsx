import { useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';

import {
  Btn,
  Card,
  Chip,
  EmptyState,
  ErrorState,
  Field,
  Icon,
  Pill,
  Rating,
  Row,
  Screen,
  SheetModal,
  SkeletonCard,
} from '@/components/ui';
import { Colors, Fonts, FontSize, Radius, Spacing } from '@/constants/theme';
import { t } from '@/i18n';
import { getFavoritesRepository } from '@/repos';
import type { FavoriteList } from '@/repos';
import { useSavedSearchesStore } from '@/store/savedSearches';
import { toast } from '@/store/ui';
import type { MerchantPublic } from '@hudumika/contract';

type Segment = 'merchants' | 'providers' | 'dishes' | 'saved' | 'lists';

const SEGMENTS: { key: Segment; label: string }[] = [
  { key: 'merchants', label: t('favorites.merchants') },
  { key: 'providers', label: t('favorites.providers') },
  { key: 'dishes', label: t('favorites.dishes') },
  { key: 'saved', label: t('favorites.savedSearches') },
  { key: 'lists', label: t('favorites.lists') },
];

/* "Add to list" picker target — either pick a list for a merchant card
 * (list-for-merchant) or pick a favorite merchant for a list detail
 * (merchant-to-list); both resolve to FavoritesRepository.addToList. */
type PickSheet =
  | { kind: 'list-for-merchant'; merchant: MerchantPublic }
  | { kind: 'merchant-to-list'; list: FavoriteList }
  | null;

/* The contract favorites surface is merchant-only (GET /favorites,
 * POST/DELETE /favorites{/merchantId}) — provider/dish segments are honest
 * coming-soon markers, never invented endpoints. The Lists segment rides the
 * mock-only-until-adopted favorites-lists paths (GET/POST/DELETE
 * /favorites/lists…, docs/CONTRACT-ADDITIONS.md #14, OPERATIONS-COVERAGE
 * #120): a live backend that has not shipped them errors the segment into its
 * retry state. */
export default function FavoritesScreen() {
  const router = useRouter();
  const [segment, setSegment] = useState<Segment>('merchants');
  const [favorites, setFavorites] = useState<MerchantPublic[] | null>(null);
  const [error, setError] = useState('');
  const saved = useSavedSearchesStore((s) => s.saved);
  const removeSavedSearch = useSavedSearchesStore((s) => s.removeSavedSearch);

  const [lists, setLists] = useState<FavoriteList[] | null>(null);
  const [listsError, setListsError] = useState('');
  const [selectedListId, setSelectedListId] = useState<string | null>(null);
  const [createVisible, setCreateVisible] = useState(false);
  const [createName, setCreateName] = useState('');
  const [creating, setCreating] = useState(false);
  const [pickSheet, setPickSheet] = useState<PickSheet>(null);
  const [deleteTarget, setDeleteTarget] = useState<FavoriteList | null>(null);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    setError('');
    try {
      setFavorites(await getFavoritesRepository().list());
    } catch {
      setError(t('common.error'));
    }
  }, []);

  const loadLists = useCallback(async () => {
    setListsError('');
    try {
      setLists(await getFavoritesRepository().listLists());
    } catch {
      setListsError(t('common.error'));
    }
  }, []);

  useEffect(() => {
    load();
    loadLists();
  }, [load, loadLists]);

  const removeFavorite = async (merchant: MerchantPublic) => {
    const prev = favorites;
    setFavorites((cur) => (cur ? cur.filter((f) => f.id !== merchant.id) : cur));
    try {
      await getFavoritesRepository().remove(merchant.id, `fav-${merchant.id}-${Date.now()}`);
    } catch {
      setFavorites(prev); // rollback
      toast(t('common.error'), 'error');
    }
  };

  const patchList = (listId: string, patch: (l: FavoriteList) => FavoriteList) => {
    setLists((cur) => (cur ? cur.map((l) => (l.id === listId ? patch(l) : l)) : cur));
  };

  const createList = async () => {
    const name = createName.trim();
    if (!name) {
      toast(t('favorites.listNameRequired'), 'error');
      return;
    }
    setCreating(true);
    try {
      const created = await getFavoritesRepository().createList({ name }, `flist-create-${Date.now()}`);
      setLists((cur) => (cur ? [created, ...cur] : [created]));
      setCreateVisible(false);
      setCreateName('');
      toast(t('favorites.listCreated'), 'success');
    } catch {
      toast(t('common.error'), 'error');
    } finally {
      setCreating(false);
    }
  };

  const addToList = async (list: FavoriteList, merchant: MerchantPublic) => {
    const prev = lists;
    if (!list.merchantIds.includes(merchant.id)) {
      patchList(list.id, (l) => ({ ...l, merchantIds: [...l.merchantIds, merchant.id] }));
    }
    setPickSheet(null);
    try {
      await getFavoritesRepository().addToList(list.id, merchant.id, `flist-add-${list.id}-${merchant.id}-${Date.now()}`);
      toast(t('favorites.added', { list: list.name }), 'success');
    } catch {
      setLists(prev); // rollback
      toast(t('common.error'), 'error');
    }
  };

  const removeFromList = async (list: FavoriteList, merchant: MerchantPublic) => {
    const prev = lists;
    patchList(list.id, (l) => ({ ...l, merchantIds: l.merchantIds.filter((id) => id !== merchant.id) }));
    try {
      await getFavoritesRepository().removeFromList(list.id, merchant.id, `flist-remove-${list.id}-${merchant.id}-${Date.now()}`);
      toast(t('favorites.removed', { list: list.name }), 'success');
    } catch {
      setLists(prev); // rollback
      toast(t('common.error'), 'error');
    }
  };

  const deleteList = async (list: FavoriteList) => {
    setDeleting(true);
    try {
      await getFavoritesRepository().deleteList(list.id, `flist-delete-${list.id}-${Date.now()}`);
      setLists((cur) => (cur ? cur.filter((l) => l.id !== list.id) : cur));
      if (selectedListId === list.id) setSelectedListId(null);
      setDeleteTarget(null);
      toast(t('favorites.listDeleted'), 'success');
    } catch {
      toast(t('common.error'), 'error');
    } finally {
      setDeleting(false);
    }
  };

  const renderMerchant = ({ item }: { item: MerchantPublic }) => (
    <Card style={styles.card} onPress={() => router.push(`/merchant/${item.id}`)}>
      <Row gap={Spacing.md}>
        <View style={styles.icon}>
          <Icon name="storefront" size={18} color={Colors.textSecondary} />
        </View>
        <View style={{ flex: 1, paddingRight: 56 }}>
          <Text style={styles.name} numberOfLines={1}>{item.businessName}</Text>
          <Row gap={Spacing.sm} style={{ marginTop: 4 }}>
            <Rating rating={item.rating} reviewCount={item.reviewCount} />
            <Pill label={item.isOpen ? t('merchant.open') : t('merchant.closed')} tone={item.isOpen ? 'success' : 'danger'} />
          </Row>
          <Row gap={Spacing.sm} style={{ marginTop: 4 }}>
            <Text style={styles.meta}>{item.city}</Text>
            {item.deliveryMinutes ? <Text style={styles.meta}>{t('order.estimated', { m: item.deliveryMinutes })}</Text> : null}
          </Row>
        </View>
      </Row>
      <Pressable
        onPress={() => setPickSheet({ kind: 'list-for-merchant', merchant: item })}
        hitSlop={10}
        accessibilityRole="button"
        accessibilityLabel={t('favorites.addToList')}
        style={styles.addToListOverlay}>
        <Icon name="list-outline" size={18} color={Colors.textSecondary} />
      </Pressable>
      <Pressable
        onPress={() => removeFavorite(item)}
        hitSlop={10}
        accessibilityRole="button"
        accessibilityLabel={t('favorite.remove')}
        style={styles.heartOverlay}>
        <Icon name="heart" size={20} color={Colors.danger} />
      </Pressable>
    </Card>
  );

  const renderSaved = ({ item }: { item: string }) => (
    <Card style={styles.card} onPress={() => router.push({ pathname: '/search', params: { q: item } })}>
      <Row gap={Spacing.md}>
        <View style={styles.icon}>
          <Icon name="search" size={18} color={Colors.textSecondary} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.name} numberOfLines={1}>{item}</Text>
        </View>
        <Pressable
          onPress={() => removeSavedSearch(item)}
          hitSlop={10}
          accessibilityRole="button"
          accessibilityLabel={t('search.savedRemove', { query: item })}
          style={styles.deleteButton}>
          <Icon name="trash-outline" size={18} color={Colors.textTertiary} />
        </Pressable>
      </Row>
    </Card>
  );

  const selectedList = lists?.find((l) => l.id === selectedListId) ?? null;
  const listMerchants = selectedList && favorites
    ? selectedList.merchantIds
        .map((id) => favorites.find((m) => m.id === id))
        .filter((m): m is MerchantPublic => Boolean(m))
    : null;

  const renderListRow = ({ item }: { item: FavoriteList }) => (
    <Card style={styles.card} onPress={() => setSelectedListId(item.id)} accessibilityLabel={item.name}>
      <Row gap={Spacing.md}>
        <View style={styles.icon}>
          <Icon name="list" size={18} color={Colors.textSecondary} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.name} numberOfLines={1}>{item.name}</Text>
          <Text style={styles.meta}>{t('lists.merchants', { n: item.merchantIds.length })}</Text>
        </View>
        <Icon name="chevron-forward" size={15} color={Colors.textFaint} />
      </Row>
    </Card>
  );

  const renderListMerchant = ({ item }: { item: MerchantPublic }) => (
    <Card style={styles.card} onPress={() => router.push(`/merchant/${item.id}`)}>
      <Row gap={Spacing.md}>
        <View style={styles.icon}>
          <Icon name="storefront" size={18} color={Colors.textSecondary} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.name} numberOfLines={1}>{item.businessName}</Text>
          <Row gap={Spacing.sm} style={{ marginTop: 4 }}>
            <Rating rating={item.rating} reviewCount={item.reviewCount} />
            <Pill label={item.isOpen ? t('merchant.open') : t('merchant.closed')} tone={item.isOpen ? 'success' : 'danger'} />
          </Row>
        </View>
        <Pressable
          onPress={() => selectedList && removeFromList(selectedList, item)}
          hitSlop={10}
          accessibilityRole="button"
          accessibilityLabel={t('favorites.removed', { list: selectedList?.name ?? '' })}
          style={styles.deleteButton}>
          <Icon name="close-circle" size={20} color={Colors.textTertiary} />
        </Pressable>
      </Row>
    </Card>
  );

  const renderListDetail = () => {
    if (!selectedList) return null;
    return (
      <>
        <Row style={{ paddingHorizontal: Spacing.lg, marginBottom: Spacing.md, justifyContent: 'space-between' }}>
          <Btn label={t('common.back')} onPress={() => setSelectedListId(null)} variant="subtle" size="sm" icon="arrow-back" />
          <Text style={styles.listDetailTitle} numberOfLines={1}>{selectedList.name}</Text>
          <Btn label={t('favorites.deleteList')} onPress={() => setDeleteTarget(selectedList)} variant="subtle" size="sm" icon="trash-outline" />
        </Row>
        <View style={{ paddingHorizontal: Spacing.lg }}>
          <Btn
            label={t('favorites.addMerchant')}
            onPress={() => setPickSheet({ kind: 'merchant-to-list', list: selectedList })}
            variant="ghost"
            icon="add-circle-outline"
            style={{ marginBottom: Spacing.md }}
          />
        </View>
        {listMerchants && listMerchants.length === 0 ? (
          <EmptyState icon="list-outline" title={t('lists.empty')} sub={t('favorites.addMerchant')} />
        ) : (
          <FlatList
            data={listMerchants ?? []}
            keyExtractor={(m) => m.id}
            onRefresh={loadLists}
            refreshing={false}
            showsVerticalScrollIndicator={false}
            contentContainerStyle={{ padding: Spacing.lg, paddingTop: 0, paddingBottom: 60 }}
            renderItem={renderListMerchant}
          />
        )}
      </>
    );
  };

  const renderListsSegment = () => {
    if (listsError) {
      return (
        <View style={{ padding: Spacing.lg }}>
          <ErrorState message={listsError} onRetry={loadLists} />
        </View>
      );
    }
    if (!lists) {
      return (
        <View style={{ padding: Spacing.lg }}>
          <SkeletonCard rows={3} />
        </View>
      );
    }
    if (selectedList) return renderListDetail();
    return (
      <FlatList
        data={lists}
        keyExtractor={(l) => l.id}
        onRefresh={() => {
          load();
          loadLists();
        }}
        refreshing={false}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ padding: Spacing.lg, paddingBottom: 60 }}
        ListHeaderComponent={
          <Card style={styles.newListCard} onPress={() => setCreateVisible(true)} accessibilityLabel={t('favorites.newList')}>
            <Row gap={Spacing.md}>
              <View style={styles.icon}>
                <Icon name="add-circle-outline" size={18} color={Colors.primaryDeep} />
              </View>
              <Text style={styles.newListText}>{t('favorites.newList')}</Text>
            </Row>
          </Card>
        }
        ListEmptyComponent={
          <EmptyState
            icon="list-outline"
            title={t('favorites.listsEmpty')}
            actionLabel={t('favorites.newList')}
            onAction={() => setCreateVisible(true)}
          />
        }
        renderItem={renderListRow}
      />
    );
  };

  if (error) {
    return (
      <Screen>
        <ErrorState message={error} onRetry={load} />
      </Screen>
    );
  }

  const comingSoonLabel = segment === 'providers' ? t('favorites.providersSoon') : t('favorites.dishesSoon');

  return (
    <Screen>
      <View style={{ paddingHorizontal: Spacing.lg, paddingTop: Spacing.lg }}>
        <Text style={styles.title}>{t('favorites.title')}</Text>
        <View style={styles.segmentRow}>
          {SEGMENTS.map((s) => (
            <Chip key={s.key} label={s.label} selected={segment === s.key} onPress={() => setSegment(s.key)} />
          ))}
        </View>
      </View>
      {segment === 'providers' || segment === 'dishes' ? (
        <View style={styles.comingSoonRow}>
          <View style={styles.disabledChip} accessibilityLabel={comingSoonLabel}>
            <Icon name="bookmark-outline" size={14} color={Colors.textTertiary} />
            <Text style={styles.disabledChipText}>{comingSoonLabel}</Text>
          </View>
        </View>
      ) : segment === 'lists' ? (
        renderListsSegment()
      ) : segment === 'merchants' ? (
        !favorites ? (
          <View style={{ padding: Spacing.lg }}>
            <SkeletonCard rows={3} />
          </View>
        ) : favorites.length === 0 ? (
          <EmptyState
            icon="heart-outline"
            title={t('favorites.empty')}
            actionLabel={t('favorites.browse')}
            onAction={() => router.push('/search')}
          />
        ) : (
          <FlatList
            data={favorites}
            keyExtractor={(m) => m.id}
            onRefresh={load}
            refreshing={false}
            showsVerticalScrollIndicator={false}
            contentContainerStyle={{ padding: Spacing.lg, paddingBottom: 60 }}
            renderItem={renderMerchant}
          />
        )
      ) : saved.length === 0 ? (
        <EmptyState icon="bookmark-outline" title={t('favorites.savedEmpty')} sub={t('search.savedEmptyHint')} />
      ) : (
        <FlatList
          data={saved}
          keyExtractor={(q) => q}
          onRefresh={load}
          refreshing={false}
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{ padding: Spacing.lg, paddingBottom: 60 }}
          renderItem={renderSaved}
        />
      )}

      <SheetModal visible={createVisible} onClose={() => setCreateVisible(false)} title={t('favorites.newList')}>
        <Field
          label={t('favorites.listName')}
          value={createName}
          onChangeText={setCreateName}
          placeholder={t('favorites.listName')}
          maxLength={40}
        />
        <Btn label={t('favorites.newList')} onPress={createList} loading={creating} icon="add-circle-outline" />
      </SheetModal>

      <SheetModal
        visible={pickSheet !== null}
        onClose={() => setPickSheet(null)}
        title={pickSheet?.kind === 'merchant-to-list' ? t('favorites.addMerchant') : t('favorites.addToList')}>
        {pickSheet?.kind === 'merchant-to-list' ? (
          (() => {
            const candidates = (favorites ?? []).filter((m) => !pickSheet.list.merchantIds.includes(m.id));
            if (candidates.length === 0) {
              return <EmptyState icon="list-outline" title={t('favorites.allInList')} />;
            }
            return candidates.map((m) => (
              <Card key={m.id} flat style={styles.pickRow} onPress={() => addToList(pickSheet.list, m)}>
                <Row gap={Spacing.md}>
                  <View style={styles.icon}>
                    <Icon name="storefront" size={16} color={Colors.textSecondary} />
                  </View>
                  <Text style={styles.pickText} numberOfLines={1}>{m.businessName}</Text>
                </Row>
              </Card>
            ));
          })()
        ) : (
          (() => {
            const list = pickSheet?.kind === 'list-for-merchant' ? pickSheet.merchant : null;
            const available = (lists ?? []).filter((l) => list && !l.merchantIds.includes(list.id));
            if ((lists ?? []).length === 0) {
              return (
                <>
                  <Text style={styles.pickHint}>{t('favorites.listsEmpty')}</Text>
                  <Btn
                    label={t('favorites.newList')}
                    onPress={() => {
                      setPickSheet(null);
                      setCreateVisible(true);
                    }}
                    variant="ghost"
                    icon="add-circle-outline"
                  />
                </>
              );
            }
            return available.map((l) => (
              <Card key={l.id} flat style={styles.pickRow} onPress={() => pickSheet && addToList(l, pickSheet.merchant)}>
                <Row gap={Spacing.md}>
                  <View style={styles.icon}>
                    <Icon name="list" size={16} color={Colors.textSecondary} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.pickText} numberOfLines={1}>{l.name}</Text>
                    <Text style={styles.meta}>{t('lists.merchants', { n: l.merchantIds.length })}</Text>
                  </View>
                </Row>
              </Card>
            ));
          })()
        )}
      </SheetModal>

      <SheetModal
        visible={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        title={t('favorites.deleteConfirm')}>
        <Text style={styles.pickHint}>{t('favorites.deleteConfirmSub')}</Text>
        <Row style={{ gap: Spacing.md }}>
          <Btn label={t('common.cancel')} onPress={() => setDeleteTarget(null)} variant="subtle" style={{ flex: 1 }} />
          <Btn label={t('favorites.deleteList')} onPress={() => deleteTarget && deleteList(deleteTarget)} variant="danger" loading={deleting} style={{ flex: 1 }} />
        </Row>
      </SheetModal>
    </Screen>
  );
}

const styles = StyleSheet.create({
  title: { fontSize: FontSize.xxl, fontFamily: Fonts.displayBold, color: Colors.text, marginBottom: Spacing.md },
  segmentRow: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.sm, marginBottom: Spacing.lg },
  card: { marginBottom: Spacing.md, paddingRight: Spacing.xl },
  icon: {
    width: 40,
    height: 40,
    borderRadius: Radius.md,
    backgroundColor: Colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  name: { fontSize: FontSize.md, fontFamily: Fonts.sansSemibold, color: Colors.text },
  meta: { fontSize: FontSize.xs, color: Colors.textTertiary, fontFamily: Fonts.sans },
  heartOverlay: { position: 'absolute', top: Spacing.sm, right: Spacing.sm, zIndex: 1 },
  addToListOverlay: { position: 'absolute', top: Spacing.lg + 2, right: Spacing.sm, zIndex: 1 },
  deleteButton: { padding: 2 },
  comingSoonRow: { paddingHorizontal: Spacing.lg },
  disabledChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    alignSelf: 'flex-start',
    paddingHorizontal: Spacing.md,
    paddingVertical: 8,
    borderRadius: Radius.pill,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
    opacity: 0.6,
  },
  disabledChipText: { fontSize: FontSize.sm, color: Colors.textTertiary, fontFamily: Fonts.sansMedium },
  newListCard: {
    marginBottom: Spacing.md,
    borderStyle: 'dashed',
    backgroundColor: Colors.surface,
  },
  newListText: { fontSize: FontSize.md, fontFamily: Fonts.sansSemibold, color: Colors.primaryDeep },
  listDetailTitle: { fontSize: FontSize.lg, fontFamily: Fonts.sansBold, color: Colors.text, flex: 1, textAlign: 'center', marginHorizontal: Spacing.sm },
  pickRow: { marginBottom: Spacing.sm },
  pickText: { fontSize: FontSize.md, fontFamily: Fonts.sansMedium, color: Colors.text, flex: 1 },
  pickHint: { fontSize: FontSize.sm, color: Colors.textSecondary, fontFamily: Fonts.sans, lineHeight: 18 },
});
