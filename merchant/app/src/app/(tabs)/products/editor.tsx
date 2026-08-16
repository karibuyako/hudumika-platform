import { Stack, router, useLocalSearchParams } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import type { AddonOption, CatalogueOptionChoice, CatalogueOptionsGroup, ComboItem, ProductRow, VariantSpec } from '@/api/types';
import { Btn, Card, Empty, Icon, Row } from '@/components/ui';
import { Colors, FontSize, Radius, Spacing } from '@/constants/theme';
import { t, onLocaleChange } from '@/i18n';
import { tzs } from '@/lib/format';
import { useCatalogStore } from '@/store/catalog';

const EMOJIS = ['🍢', '🥩', '🍗', '🍖', '🍆', '🌽', '🍺', '🍜', '🦪', '🥤', '🫓', '🔥'];
const MAX_IMAGES = 4;

export default function ProductEditorScreen() {
  useSyncExternalStore(onLocaleChange, () => 0);
  const { id } = useLocalSearchParams<{ id?: string }>();
  const products = useCatalogStore((s) => s.products);
  const loaded = useCatalogStore((s) => s.loaded);
  const hydrate = useCatalogStore((s) => s.hydrate);

  useEffect(() => {
    if (!loaded) void hydrate();
  }, [loaded, hydrate]);

  const existing = id ? products.find((p) => p.id === id) : undefined;
  const notFound = !!id && loaded && !existing;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: Colors.bg }} edges={['top']}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.topBar}>
        <Pressable onPress={() => router.back()} hitSlop={12} accessibilityRole="button" accessibilityLabel={t('common.back')} style={{ padding: 4 }}>
          <Icon name="chevron-back" size={26} color={Colors.text} />
        </Pressable>
        <Text style={styles.topTitle}>{id ? t('prde.edit') : t('prde.add')}</Text>
        <View style={{ width: 26 }} />
      </View>
      {notFound ? (
        <View style={{ flex: 1, justifyContent: 'center' }}>
          <Empty icon="alert-circle-outline" title={t('prde.notFound')} sub={t('prde.notFoundSub')} />
        </View>
      ) : (
        <EditorForm key={existing?.id ?? 'new'} existing={existing} />
      )}
    </SafeAreaView>
  );
}

function EditorForm({ existing }: { existing?: ProductRow }) {
  useSyncExternalStore(onLocaleChange, () => 0);
  const products = useCatalogStore((s) => s.products);
  const categories = useCatalogStore((s) => s.categories);
  const createProduct = useCatalogStore((s) => s.createProduct);
  const updateProduct = useCatalogStore((s) => s.updateProduct);

  const isEdit = !!existing;
  const [name, setName] = useState(existing?.name ?? '');
  const [emoji, setEmoji] = useState(existing?.emoji ?? EMOJIS[0]);
  const [price, setPrice] = useState(existing ? String(existing.price) : '');
  const [stock, setStock] = useState(existing ? String(existing.stock) : '');
  const [description, setDescription] = useState(existing?.description ?? '');
  const [categoryId, setCategoryId] = useState(existing?.categoryId ?? categories[0]?.id ?? '');
  const [visible, setVisible] = useState(existing?.visible ?? true);
  const [zeroStockAction, setZeroStockAction] = useState<'hide' | 'showSoldOut'>(
    existing?.zeroStockAction ?? 'showSoldOut',
  );
  const [images, setImages] = useState<string[]>(existing?.images ?? []);
  const [imageInput, setImageInput] = useState('');
  const [videoUrl, setVideoUrl] = useState(existing?.videoUrl ?? '');
  const [variants, setVariants] = useState<VariantSpec[]>(existing?.variants ?? []);
  const [options, setOptions] = useState<CatalogueOptionsGroup[]>(existing?.options ?? []);
  const [addons, setAddons] = useState<AddonOption[]>(existing?.addons ?? []);
  const [isCombo, setIsCombo] = useState((existing?.comboItems.length ?? 0) > 0);
  const [comboItems, setComboItems] = useState<ComboItem[]>(existing?.comboItems ?? []);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');

  const basePrice = Number(price) || 0;
  const comboTotal = comboItems.reduce((sum, i) => sum + i.qty * i.price, 0);
  const availableComboProducts = products.filter(
    (p) => p.id !== existing?.id && !comboItems.some((i) => i.productId === p.id),
  );

  const addImage = () => {
    const url = imageInput.trim();
    if (!url || images.length >= MAX_IMAGES) return;
    setImages((arr) => [...arr, url]);
    setImageInput('');
  };

  const addVariant = () => setVariants((arr) => [...arr, { id: `v${Date.now().toString(36)}`, name: '', price: 0 }]);
  const patchVariant = (vid: string, patch: Partial<VariantSpec>) =>
    setVariants((arr) => arr.map((v) => (v.id === vid ? { ...v, ...patch } : v)));

  const addAddon = () => setAddons((arr) => [...arr, { id: `a${Date.now().toString(36)}`, name: '', price: 0 }]);
  const patchAddon = (aid: string, patch: Partial<AddonOption>) =>
    setAddons((arr) => arr.map((a) => (a.id === aid ? { ...a, ...patch } : a)));

  const addOptionGroup = () =>
    setOptions((arr) => [...arr, { name: '', choices: [], required: false }]);
  const patchOptionGroup = (idx: number, patch: Partial<CatalogueOptionsGroup>) =>
    setOptions((arr) => arr.map((g, i) => (i === idx ? { ...g, ...patch } : g)));
  const addOptionChoice = (idx: number) => {
    const id = `optc${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    setOptions((arr) =>
      arr.map((g, i) => (i === idx ? { ...g, choices: [...g.choices, { id, label: '', priceTZS: 0 }] } : g)),
    );
  };
  const patchOptionChoice = (idx: number, cid: string, patch: Partial<CatalogueOptionChoice>) =>
    setOptions((arr) =>
      arr.map((g, i) =>
        i === idx ? { ...g, choices: g.choices.map((c) => (c.id === cid ? { ...c, ...patch } : c)) } : g,
      ),
    );
  const removeOptionChoice = (idx: number, cid: string) =>
    setOptions((arr) =>
      arr.map((g, i) => (i === idx ? { ...g, choices: g.choices.filter((c) => c.id !== cid) } : g)),
    );

  const pickComboProduct = (p: ProductRow) => {
    setComboItems((arr) => [...arr, { productId: p.id, name: p.name, emoji: p.emoji, qty: 1, price: p.price }]);
  };
  const setComboQty = (productId: string, delta: number) =>
    setComboItems((arr) => arr.map((i) => (i.productId === productId ? { ...i, qty: Math.max(1, i.qty + delta) } : i)));
  const setComboPrice = (productId: string, value: string) =>
    setComboItems((arr) => arr.map((i) => (i.productId === productId ? { ...i, price: Number(value) || 0 } : i)));

  const save = async () => {
    if (!name.trim() || basePrice <= 0 || saving) return;
    setSaving(true);
    setSaveError('');
    const payload: Partial<ProductRow> & { name: string; price: number } = {
      name: name.trim(),
      emoji: emoji.trim() || EMOJIS[0],
      price: basePrice,
      stock: Math.max(0, Number(stock) || 0),
      description: description.trim(),
      categoryId,
      visible,
      images: images.slice(0, MAX_IMAGES),
      videoUrl: videoUrl.trim(),
      variants: variants.filter((v) => v.name.trim()),
      options: options
        .map((g) => ({
          ...g,
          name: g.name.trim(),
          choices: g.choices
            .filter((c) => c.label.trim())
            .map((c) => ({ id: c.id, label: c.label.trim(), priceTZS: Math.max(0, Math.round(Number(c.priceTZS) || 0)) })),
        }))
        .filter((g) => g.name && g.choices.length > 0),
      addons: addons.filter((a) => a.name.trim()),
      comboItems: isCombo ? comboItems.filter((i) => !!i.productId) : [],
      zeroStockAction,
    };
    const res = isEdit && existing ? await updateProduct(existing.id, payload) : await createProduct(payload);
    if (!res) {
      setSaving(false);
      setSaveError(t('prde.saveFailed'));
      return;
    }
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    router.back();
  };

  const canSave = !!name.trim() && basePrice > 0;

  return (
    <View style={{ flex: 1 }}>
      <ScrollView
        contentContainerStyle={{ padding: Spacing.lg, gap: Spacing.md, paddingBottom: 40 }}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled">
        <Card style={{ gap: Spacing.md }}>
          <FieldRow label={t('prde.name')}>
            <TextInput
              value={name}
              onChangeText={setName}
              placeholder={t('prde.namePh')}
              placeholderTextColor={Colors.textFaint}
              maxLength={30}
              style={styles.input}
            />
          </FieldRow>

          <View style={{ gap: Spacing.xs }}>
            <Text style={styles.fieldLabel}>{t('prde.emoji')}</Text>
            <TextInput
              value={emoji}
              onChangeText={setEmoji}
              placeholder="🍢"
              placeholderTextColor={Colors.textFaint}
              maxLength={4}
              style={styles.input}
            />
            <Row gap={6} style={{ flexWrap: 'wrap' }}>
              {EMOJIS.map((e) => (
                <Pressable
                  key={e}
                  onPress={() => setEmoji(e)}
                  accessibilityRole="button"
                  accessibilityLabel={e}
                  accessibilityState={{ selected: emoji === e }}
                  style={[styles.emojiOption, emoji === e && { backgroundColor: Colors.primary }]}>
                  <Text style={{ fontSize: 16 }}>{e}</Text>
                </Pressable>
              ))}
            </Row>
          </View>

          <Row gap={Spacing.md}>
            <View style={{ flex: 1 }}>
              <FieldRow label={isCombo ? t('prde.comboPrice') : t('prde.price')}>
                <TextInput
                  value={price}
                  onChangeText={setPrice}
                  placeholder="12"
                  placeholderTextColor={Colors.textFaint}
                  keyboardType="decimal-pad"
                  maxLength={7}
                  style={styles.input}
                />
              </FieldRow>
            </View>
            <View style={{ flex: 1 }}>
              <FieldRow label={t('prde.stock')}>
                <TextInput
                  value={stock}
                  onChangeText={setStock}
                  placeholder="99"
                  placeholderTextColor={Colors.textFaint}
                  keyboardType="number-pad"
                  maxLength={5}
                  style={styles.input}
                />
              </FieldRow>
            </View>
          </Row>

          <FieldRow label={t('prde.desc')}>
            <TextInput
              value={description}
              onChangeText={setDescription}
              placeholder={t('prde.descPh')}
              placeholderTextColor={Colors.textFaint}
              maxLength={60}
              multiline
              style={[styles.input, styles.multiline]}
            />
          </FieldRow>

          <View style={{ gap: Spacing.xs }}>
            <Text style={styles.fieldLabel}>{t('prde.category')}</Text>
            {categories.length === 0 ? (
              <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary }}>{t('prde.noCategories')}</Text>
            ) : (
              <Row gap={6} style={{ flexWrap: 'wrap' }}>
                {categories.map((c) => (
                  <Pressable
                    key={c.id}
                    onPress={() => setCategoryId(c.id)}
                    accessibilityRole="button"
                    accessibilityLabel={c.name}
                    accessibilityState={{ selected: categoryId === c.id }}
                    style={[styles.chip, categoryId === c.id && styles.chipActive]}>
                    <Text style={[styles.chipText, categoryId === c.id && { color: Colors.text, fontWeight: '700' }]}>
                      {c.name}
                    </Text>
                  </Pressable>
                ))}
              </Row>
            )}
          </View>

          <View style={{ gap: Spacing.xs }}>
            <Text style={styles.fieldLabel}>{t('prde.zeroStock')}</Text>
            <Row gap={6}>
              <Pressable
                onPress={() => setZeroStockAction('showSoldOut')}
                accessibilityRole="button"
                accessibilityLabel={t('prde.showSoldOut')}
                accessibilityState={{ selected: zeroStockAction === 'showSoldOut' }}
                style={[styles.chip, zeroStockAction === 'showSoldOut' && styles.chipActive]}>
                <Text style={[styles.chipText, zeroStockAction === 'showSoldOut' && { color: Colors.text, fontWeight: '700' }]}>
                  {t('prde.showSoldOut')}
                </Text>
              </Pressable>
              <Pressable
                onPress={() => setZeroStockAction('hide')}
                accessibilityRole="button"
                accessibilityLabel={t('prde.hideWhen0')}
                accessibilityState={{ selected: zeroStockAction === 'hide' }}
                style={[styles.chip, zeroStockAction === 'hide' && styles.chipActive]}>
                <Text style={[styles.chipText, zeroStockAction === 'hide' && { color: Colors.text, fontWeight: '700' }]}>
                  {t('prde.hideWhen0')}
                </Text>
              </Pressable>
            </Row>
          </View>

          <Row style={{ justifyContent: 'space-between' }}>
            <View style={{ flex: 1, paddingRight: Spacing.lg }}>
              <Text style={{ fontSize: FontSize.md, fontWeight: '700', color: Colors.text }}>{t('prde.visible')}</Text>
              <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary, marginTop: 2 }}>
                {t('prde.visibleSub')}
              </Text>
            </View>
            <Switch
              value={visible}
              onValueChange={setVisible}
              trackColor={{ false: Colors.borderStrong, true: Colors.success }}
              thumbColor={Colors.white}
            />
          </Row>
        </Card>

        <Card style={{ gap: Spacing.md }}>
          <Text style={styles.cardTitle}>{t('prde.photos')}</Text>
          {images.map((img, i) => (
            <Row key={`${img}-${i}`} gap={8}>
              <View style={styles.imageChip}>
                <Text numberOfLines={1} style={{ flex: 1, fontSize: FontSize.sm, color: Colors.textSecondary }}>
                  {img}
                </Text>
              </View>
              <Pressable onPress={() => setImages((arr) => arr.filter((_, x) => x !== i))} hitSlop={8} accessibilityRole="button" accessibilityLabel={t('common.remove')}>
                <Icon name="close-circle" size={18} color={Colors.danger} />
              </Pressable>
            </Row>
          ))}
          <Row gap={8}>
            <View style={{ flex: 1 }}>
              <FieldRow label="">
                <TextInput
                  value={imageInput}
                  onChangeText={setImageInput}
                  placeholder={t('prde.photoPh')}
                  placeholderTextColor={Colors.textFaint}
                  style={styles.input}
                />
              </FieldRow>
            </View>
            <Btn label={t('prde.addBtn')} size="sm" variant="ghost" onPress={addImage} disabled={!imageInput.trim() || images.length >= MAX_IMAGES} />
          </Row>
          <View style={{ gap: Spacing.xs }}>
            <FieldRow label={t('prde.videoUrl')}>
              <TextInput
                value={videoUrl}
                onChangeText={setVideoUrl}
                placeholder={t('prde.videoPh')}
                placeholderTextColor={Colors.textFaint}
                style={styles.input}
              />
            </FieldRow>
            <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary }}>{t('prde.videoPh2')}</Text>
          </View>
        </Card>

        <Card style={{ gap: Spacing.md }}>
          <Row style={{ justifyContent: 'space-between' }}>
            <View>
              <Text style={styles.cardTitle}>{t('prde.specs')}</Text>
              <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary, marginTop: 2 }}>
                {variants.length > 0 ? t('prde.specsCount', { n: variants.length }) : t('prde.specsPh')}
              </Text>
            </View>
            <Btn label={t('prde.addSpec')} size="sm" variant="ghost" icon="add" onPress={addVariant} />
          </Row>
          {variants.map((v) => (
            <Row key={v.id} gap={8} style={{ alignItems: 'flex-end' }}>
              <View style={{ flex: 1.6 }}>
                <FieldRow label="">
                  <TextInput
                    value={v.name}
                    onChangeText={(t) => patchVariant(v.id, { name: t })}
                    placeholder={t('prde.specNamePh')}
                    placeholderTextColor={Colors.textFaint}
                    style={styles.input}
                  />
                </FieldRow>
              </View>
              <View style={{ flex: 1 }}>
                <FieldRow label="">
                  <TextInput
                    value={v.price ? String(v.price) : ''}
                    onChangeText={(t) => patchVariant(v.id, { price: Number(t) || 0 })}
                    placeholder={t('prde.extraYuan')}
                    placeholderTextColor={Colors.textFaint}
                    keyboardType="decimal-pad"
                    style={styles.input}
                  />
                </FieldRow>
              </View>
              <Pressable onPress={() => setVariants((arr) => arr.filter((x) => x.id !== v.id))} hitSlop={10} accessibilityRole="button" accessibilityLabel={t('common.remove')} style={{ paddingBottom: 12 }}>
                <Icon name="trash-outline" size={18} color={Colors.danger} />
              </Pressable>
            </Row>
          ))}
          {variants.length === 0 ? (
            <Text style={{ fontSize: FontSize.sm, color: Colors.textTertiary }}>{t('prde.noSpecs')}</Text>
          ) : null}
        </Card>

        <Card style={{ gap: Spacing.md }}>
          <Row style={{ justifyContent: 'space-between' }}>
            <View style={{ flex: 1 }}>
              <Text style={styles.cardTitle}>{t('prde.options')}</Text>
              <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary, marginTop: 2 }}>
                {options.length > 0 ? t('prde.specsCount', { n: options.length }) : t('prde.optionsPh')}
              </Text>
            </View>
            <Btn label={t('prde.addOption')} size="sm" variant="ghost" icon="add" onPress={addOptionGroup} />
          </Row>
          {options.map((g, idx) => (
            <View key={`${g.name}-${idx}`} style={{ gap: Spacing.sm }}>
              <Row gap={8} style={{ alignItems: 'flex-end' }}>
                <View style={{ flex: 1 }}>
                  <FieldRow label="">
                    <TextInput
                      value={g.name}
                      onChangeText={(v) => patchOptionGroup(idx, { name: v })}
                      placeholder={t('prde.optionNamePh')}
                      placeholderTextColor={Colors.textFaint}
                      maxLength={80}
                      style={styles.input}
                    />
                  </FieldRow>
                </View>
                <Pressable onPress={() => setOptions((arr) => arr.filter((_, i) => i !== idx))} hitSlop={10} accessibilityRole="button" accessibilityLabel={t('common.remove')} style={{ paddingBottom: 12 }}>
                  <Icon name="trash-outline" size={18} color={Colors.danger} />
                </Pressable>
              </Row>
              <Row gap={Spacing.md}>
                <View style={{ flex: 1 }}>
                  <FieldRow label={t('prde.minSel')}>
                    <TextInput
                      value={g.min !== undefined ? String(g.min) : ''}
                      onChangeText={(v) => patchOptionGroup(idx, { min: v ? Math.max(0, Math.round(Number(v) || 0)) : undefined })}
                      placeholder="0"
                      placeholderTextColor={Colors.textFaint}
                      keyboardType="number-pad"
                      style={styles.input}
                    />
                  </FieldRow>
                </View>
                <View style={{ flex: 1 }}>
                  <FieldRow label={t('prde.maxSel')}>
                    <TextInput
                      value={g.max !== undefined ? String(g.max) : ''}
                      onChangeText={(v) => patchOptionGroup(idx, { max: v ? Math.max(0, Math.round(Number(v) || 0)) : undefined })}
                      placeholder="0"
                      placeholderTextColor={Colors.textFaint}
                      keyboardType="number-pad"
                      style={styles.input}
                    />
                  </FieldRow>
                </View>
              </Row>
              <Row style={{ justifyContent: 'space-between', alignItems: 'center' }}>
                <Text style={{ fontSize: FontSize.xs, color: Colors.textSecondary, fontWeight: '600' }}>{t('prde.required')}</Text>
                <Switch
                  value={g.required === true}
                  onValueChange={(v) => patchOptionGroup(idx, { required: v })}
                  trackColor={{ false: Colors.borderStrong, true: Colors.success }}
                  thumbColor={Colors.white}
                />
              </Row>
              {g.choices.map((c) => (
                <Row key={c.id ?? `${c.label}-${c.priceTZS}`} gap={8} style={{ alignItems: 'flex-end' }}>
                  <View style={{ flex: 1.4 }}>
                    <FieldRow label="">
                      <TextInput
                        value={c.label}
                        onChangeText={(v) => patchOptionChoice(idx, c.id ?? '', { label: v })}
                        placeholder={t('prde.choiceLabelPh')}
                        placeholderTextColor={Colors.textFaint}
                        style={styles.input}
                      />
                    </FieldRow>
                  </View>
                  <View style={{ flex: 1 }}>
                    <FieldRow label="">
                      <TextInput
                        value={c.priceTZS ? String(c.priceTZS) : ''}
                        onChangeText={(v) => patchOptionChoice(idx, c.id ?? '', { priceTZS: Math.round(Number(v) || 0) })}
                        placeholder={t('prde.choicePricePh')}
                        placeholderTextColor={Colors.textFaint}
                        keyboardType="number-pad"
                        style={styles.input}
                      />
                    </FieldRow>
                  </View>
                  <Pressable onPress={() => removeOptionChoice(idx, c.id ?? '')} hitSlop={10} accessibilityRole="button" accessibilityLabel={t('common.remove')} style={{ paddingBottom: 12 }}>
                    <Icon name="close-circle" size={18} color={Colors.danger} />
                  </Pressable>
                </Row>
              ))}
              <Btn label={t('prde.addChoice')} size="sm" variant="ghost" icon="add" onPress={() => addOptionChoice(idx)} />
            </View>
          ))}
          {options.length === 0 ? (
            <Text style={{ fontSize: FontSize.sm, color: Colors.textTertiary }}>{t('prde.noOptions')}</Text>
          ) : null}
        </Card>

        <Card style={{ gap: Spacing.md }}>
          <Row style={{ justifyContent: 'space-between' }}>
            <View>
              <Text style={styles.cardTitle}>{t('prde.addons')}</Text>
              <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary, marginTop: 2 }}>
                {t('prde.addonsSub')}
              </Text>
            </View>
            <Btn label={t('prde.addBtn')} size="sm" variant="ghost" icon="add" onPress={addAddon} />
          </Row>
          {addons.map((a) => (
            <Row key={a.id} gap={8} style={{ alignItems: 'flex-end' }}>
              <View style={{ flex: 1.4 }}>
                <FieldRow label="">
                  <TextInput
                    value={a.name}
                    onChangeText={(t) => patchAddon(a.id, { name: t })}
                    placeholder={t('prde.name')}
                    placeholderTextColor={Colors.textFaint}
                    style={styles.input}
                  />
                </FieldRow>
              </View>
              <View style={{ flex: 0.9 }}>
                <FieldRow label="">
                  <TextInput
                    value={a.price ? String(a.price) : ''}
                    onChangeText={(t) => patchAddon(a.id, { price: Number(t) || 0 })}
                    placeholder={t('prde.priceYuan')}
                    placeholderTextColor={Colors.textFaint}
                    keyboardType="decimal-pad"
                    style={styles.input}
                  />
                </FieldRow>
              </View>
              <View style={{ flex: 0.7 }}>
                <FieldRow label="">
                  <TextInput
                    value={a.emoji ?? ''}
                    onChangeText={(t) => patchAddon(a.id, { emoji: t })}
                    placeholder="😋"
                    placeholderTextColor={Colors.textFaint}
                    maxLength={4}
                    style={styles.input}
                  />
                </FieldRow>
              </View>
              <Pressable onPress={() => setAddons((arr) => arr.filter((x) => x.id !== a.id))} hitSlop={10} accessibilityRole="button" accessibilityLabel={t('common.remove')} style={{ paddingBottom: 12 }}>
                <Icon name="trash-outline" size={18} color={Colors.danger} />
              </Pressable>
            </Row>
          ))}
          {addons.length === 0 ? (
            <Text style={{ fontSize: FontSize.sm, color: Colors.textTertiary }}>{t('prde.noAddons')}</Text>
          ) : null}
        </Card>

        <Card style={{ gap: Spacing.md }}>
          <Row style={{ justifyContent: 'space-between' }}>
            <View>
              <Text style={styles.cardTitle}>{t('prde.combo')}</Text>
              <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary, marginTop: 2 }}>
                {t('prde.comboSub')}
              </Text>
            </View>
            <Switch
              value={isCombo}
              onValueChange={setIsCombo}
              trackColor={{ false: Colors.borderStrong, true: Colors.success }}
              thumbColor={Colors.white}
            />
          </Row>
          {isCombo ? (
            <>
              {comboItems.map((i) => (
                <Row key={i.productId} gap={8}>
                  <View style={styles.comboItemBox}>
                    <Text style={{ fontSize: 16 }}>{i.emoji}</Text>
                  </View>
                  <Text style={{ flex: 1, fontSize: FontSize.sm, color: Colors.text }} numberOfLines={1}>
                    {i.name}
                  </Text>
                  <Pressable onPress={() => setComboQty(i.productId, -1)} hitSlop={8} accessibilityRole="button" accessibilityLabel={t('common.remove')} style={styles.qtyBtn}>
                    <Icon name="remove" size={14} color={Colors.textSecondary} />
                  </Pressable>
                  <Text style={{ fontSize: FontSize.sm, fontWeight: '700', color: Colors.text, minWidth: 18, textAlign: 'center' }}>
                    {i.qty}
                  </Text>
                  <Pressable onPress={() => setComboQty(i.productId, 1)} hitSlop={8} accessibilityRole="button" accessibilityLabel={t('common.add')} style={styles.qtyBtn}>
                    <Icon name="add" size={14} color={Colors.textSecondary} />
                  </Pressable>
                  <View style={{ width: 64 }}>
                    <FieldRow label="">
                      <TextInput
                        value={i.price ? String(i.price) : ''}
                        onChangeText={(t) => setComboPrice(i.productId, t)}
                        placeholder="¥"
                        placeholderTextColor={Colors.textFaint}
                        keyboardType="decimal-pad"
                        style={[styles.input, { paddingVertical: 8 }]}
                      />
                    </FieldRow>
                  </View>
                  <Pressable onPress={() => setComboItems((arr) => arr.filter((x) => x.productId !== i.productId))} hitSlop={8} accessibilityRole="button" accessibilityLabel={t('common.remove')}>
                    <Icon name="close-circle" size={18} color={Colors.danger} />
                  </Pressable>
                </Row>
              ))}
              {comboItems.length > 0 ? (
                <Text style={{ fontSize: FontSize.sm, color: Colors.textSecondary }}>
                  {t('prde.comboCalc', { a: tzs(comboTotal), b: tzs(basePrice) })}
                </Text>
              ) : null}
              <View style={{ gap: Spacing.xs }}>
                <Text style={styles.fieldLabel}>{t('prde.addItem')}</Text>
                {availableComboProducts.length === 0 ? (
                  <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary }}>{t('prde.noMore')}</Text>
                ) : (
                  <Row gap={6} style={{ flexWrap: 'wrap' }}>
                    {availableComboProducts.map((p) => (
                      <Pressable key={p.id} onPress={() => pickComboProduct(p)} accessibilityRole="button" accessibilityLabel={`${p.emoji} ${p.name}`} style={styles.chip}>
                        <Text numberOfLines={1} style={[styles.chipText, { maxWidth: 160 }]}>
                          {p.emoji} {p.name}
                        </Text>
                      </Pressable>
                    ))}
                  </Row>
                )}
              </View>
            </>
          ) : null}
        </Card>
      </ScrollView>

      <View style={styles.footer}>
        {saveError ? <Text style={styles.saveError}>{saveError}</Text> : null}
        <Btn label={t('prde.save')} size="lg" onPress={save} disabled={!canSave || saving} loading={saving} />
      </View>
    </View>
  );
}

function FieldRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={{ gap: Spacing.xs }}>
      <Text style={styles.fieldLabel}>{label}</Text>
      {children}
    </View>
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
  fieldLabel: { fontSize: FontSize.sm, color: Colors.textSecondary, fontWeight: '600' },
  cardTitle: { fontSize: FontSize.md, fontWeight: '700', color: Colors.text },
  input: {
    borderWidth: 1,
    borderColor: Colors.borderStrong,
    borderRadius: Radius.md,
    paddingHorizontal: Spacing.md,
    paddingVertical: 11,
    fontSize: FontSize.md,
    color: Colors.text,
    backgroundColor: Colors.card,
  },
  multiline: { minHeight: 76, textAlignVertical: 'top' },
  chip: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: Radius.pill,
    borderWidth: 1,
    borderColor: Colors.borderStrong,
    backgroundColor: Colors.card,
  },
  chipActive: { backgroundColor: Colors.primary, borderColor: Colors.primaryDark },
  chipText: { fontSize: FontSize.sm, color: Colors.textSecondary, fontWeight: '600' },
  emojiOption: {
    width: 36,
    height: 36,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: Colors.surface,
  },
  imageChip: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: Colors.borderStrong,
    borderRadius: Radius.md,
    paddingHorizontal: Spacing.md,
    paddingVertical: 9,
    backgroundColor: Colors.surface,
  },
  comboItemBox: {
    width: 34,
    height: 34,
    borderRadius: 10,
    backgroundColor: Colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  qtyBtn: {
    width: 26,
    height: 26,
    borderRadius: 13,
    borderWidth: 1,
    borderColor: Colors.borderStrong,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: Colors.card,
  },
  footer: {
    padding: Spacing.lg,
    paddingBottom: 28,
    backgroundColor: Colors.card,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: Colors.border,
    gap: Spacing.sm,
  },
  saveError: { fontSize: FontSize.sm, color: Colors.danger, fontWeight: '600', textAlign: 'center' },
});
