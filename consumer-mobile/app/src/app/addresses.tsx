import { useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';

import {
  Btn,
  Card,
  Chip,
  EmptyState,
  Field,
  Icon,
  Pill,
  Row,
  Screen,
  SheetModal,
} from '@/components/ui';
import { MapView } from '@/components/MapView';
import { Colors, Fonts, FontSize, Spacing } from '@/constants/theme';
import { t } from '@/i18n';
import { GeoError, getCurrentPosition, isServiceable } from '@/lib/geolocation';
import { accuracyKmFor, type Coordinate } from '@/lib/maps';
import { useAddressesStore, type SavedAddress } from '@/store/addresses';
import { useLocationStore } from '@/store/location';

export default function AddressesScreen() {
  const addresses = useAddressesStore((s) => s.addresses);
  const selectedId = useAddressesStore((s) => s.selectedId);
  const addAddress = useAddressesStore((s) => s.addAddress);
  const updateAddress = useAddressesStore((s) => s.updateAddress);
  const removeAddress = useAddressesStore((s) => s.removeAddress);
  const select = useAddressesStore((s) => s.select);
  const city = useLocationStore((s) => s.city);
  const serviceAreas = city?.serviceAreas ?? [];

  const [sheet, setSheet] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [label, setLabel] = useState('');
  const [lines, setLines] = useState('');
  const [landmark, setLandmark] = useState('');
  const [instructions, setInstructions] = useState('');
  const [area, setArea] = useState('');
  const [phone, setPhone] = useState('');
  const [lat, setLat] = useState<number | undefined>(undefined);
  const [lon, setLon] = useState<number | undefined>(undefined);
  /** GPS accuracy in meters (never fabricated) — drives the map disc. */
  const [accuracyMeters, setAccuracyMeters] = useState<number | undefined>(undefined);
  const [locating, setLocating] = useState(false);
  const [geoSupported, setGeoSupported] = useState(true);
  const [geoError, setGeoError] = useState('');
  const [error, setError] = useState('');

  const resetForm = () => {
    setLabel('');
    setLines('');
    setLandmark('');
    setInstructions('');
    setArea('');
    setPhone('');
    setLat(undefined);
    setLon(undefined);
    setAccuracyMeters(undefined);
    setGeoError('');
    setError('');
  };

  const openAdd = () => {
    setEditingId(null);
    resetForm();
    setSheet(true);
  };

  const openEdit = (address: SavedAddress) => {
    setEditingId(address.id);
    setLabel(address.label);
    setLines(address.lines);
    setLandmark(address.landmark ?? '');
    setInstructions(address.deliveryInstructions ?? '');
    setPhone(address.contactPhone);
    setLat(address.lat);
    setLon(address.lon);
    // Saved addresses carry no GPS accuracy — the preview shows the pin only.
    setAccuracyMeters(undefined);
    setGeoError('');
    // An area that is no longer serviceable under the current city must be
    // re-picked before saving (address.outsideServiceArea error state).
    if (address.serviceArea && city && serviceAreas.length > 0 && !isServiceable(address, city)) {
      setArea('');
      setError(t('address.outsideServiceArea'));
    } else {
      setArea(address.serviceArea ?? '');
      setError('');
    }
    setSheet(true);
  };

  const closeSheet = () => {
    setSheet(false);
    setEditingId(null);
  };

  // GPS fill-in — only when the Web Geolocation API actually yields a fix.
  // lat/lon are NEVER fabricated; on unsupported/denied platforms the button
  // hides itself gracefully and the address stays manually entered.
  const locate = async () => {
    if (locating) return;
    setLocating(true);
    setGeoError('');
    try {
      const position = await getCurrentPosition();
      setLat(position.lat);
      setLon(position.lon);
      setAccuracyMeters(position.accuracy);
    } catch (e) {
      if (e instanceof GeoError && (e.code === 'UNSUPPORTED' || e.code === 'PERMISSION_DENIED')) {
        setGeoSupported(false);
      } else {
        setGeoError(t('address.locationError'));
      }
    } finally {
      setLocating(false);
    }
  };

  const save = () => {
    if (!label.trim() || !lines.trim() || !phone.trim()) {
      setError(t('common.error'));
      return;
    }
    // Ops #16: the selected city's service areas are the servicability set.
    if (serviceAreas.length > 0 && !area.trim()) {
      setError(t('address.outsideServiceArea'));
      return;
    }
    const patch = {
      label: label.trim(),
      lines: lines.trim(),
      landmark: landmark.trim() || undefined,
      deliveryInstructions: instructions.trim() || undefined,
      serviceArea: area.trim() || undefined,
      contactPhone: phone.trim(),
      // Only coordinates from GPS detection are stored — never fabricated.
      ...(lat !== undefined && lon !== undefined ? { lat, lon } : {}),
    };
    if (editingId) {
      updateAddress(editingId, patch);
    } else {
      addAddress(patch);
    }
    closeSheet();
    resetForm();
  };

  // Form-preview coordinate: GPS-detected only (the save path stores it).
  const formCoord: Coordinate | null =
    lat !== undefined && lon !== undefined ? { lat, lon } : null;
  const formAccuracyKm =
    accuracyMeters !== undefined ? accuracyKmFor({ accuracy: accuracyMeters }) : undefined;

  return (
    <Screen>
      <View style={{ paddingHorizontal: Spacing.lg, paddingTop: Spacing.lg }}>
        <Row style={{ justifyContent: 'space-between' }}>
          <Text style={styles.title}>{t('addresses.title')}</Text>
          <Btn label={t('addresses.add')} onPress={openAdd} size="sm" icon="add" />
        </Row>
      </View>
      {addresses.length === 0 ? (
        <EmptyState icon="location-outline" title={t('addresses.empty')} sub={t('addresses.emptySub')} actionLabel={t('addresses.add')} onAction={openAdd} />
      ) : (
        <FlatList
          data={addresses}
          keyExtractor={(a) => a.id}
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{ padding: Spacing.lg, paddingBottom: 60 }}
          renderItem={({ item }) => {
            const outside = !isServiceable(item, city);
            return (
              <Card style={[styles.card, item.id === selectedId && styles.cardSelected]}>
                <Row gap={Spacing.md}>
                  <Pressable
                    onPress={outside ? undefined : () => select(item.id)}
                    disabled={outside}
                    hitSlop={8}
                    accessibilityRole="button"
                    accessibilityState={{ disabled: outside }}
                    accessibilityLabel={t('addresses.default')}>
                    <Icon name={item.id === selectedId ? 'radio-button-on' : 'radio-button-off'} size={18} color={outside ? Colors.textFaint : item.id === selectedId ? Colors.primary : Colors.borderStrong} />
                  </Pressable>
                  <Pressable style={{ flex: 1 }} onPress={() => openEdit(item)} accessibilityRole="button" accessibilityLabel={t('addresses.edit')}>
                    <Row gap={Spacing.sm} style={{ flexWrap: 'wrap' }}>
                      <Text style={styles.label}>{item.label}</Text>
                      {item.id === selectedId ? (
                        <Text style={{ color: Colors.primaryDeep, fontSize: FontSize.xs, fontFamily: Fonts.sansSemibold }}>{t('addresses.default')}</Text>
                      ) : null}
                      {outside ? <Pill label={t('address.outsideServiceArea')} tone="danger" /> : null}
                      {item.serviceArea ? <Pill label={item.serviceArea} tone="neutral" /> : null}
                    </Row>
                    <Text style={styles.meta}>{item.lines}</Text>
                    {item.landmark ? <Text style={styles.meta}>{item.landmark}</Text> : null}
                    {item.deliveryInstructions ? <Text style={styles.meta}>{item.deliveryInstructions}</Text> : null}
                    <Text style={styles.meta}>{item.contactPhone}</Text>
                  </Pressable>
                  <Pressable onPress={() => openEdit(item)} hitSlop={8} accessibilityRole="button" accessibilityLabel={t('addresses.edit')}>
                    <Icon name="create-outline" size={16} color={Colors.textSecondary} />
                  </Pressable>
                  <Pressable onPress={() => removeAddress(item.id)} hitSlop={8} accessibilityRole="button" accessibilityLabel={t('common.close')}>
                    <Icon name="trash-outline" size={16} color={Colors.danger} />
                  </Pressable>
                </Row>
                {/* Map preview for the selected address with saved
                    coordinates — the honest small stand-in for the blueprint's
                    full-screen map selector (native SDK later, same lib/maps
                    seam). Marker = the saved pin; no accuracy disc. */}
                {item.id === selectedId && item.lat !== undefined && item.lon !== undefined ? (
                  <View style={{ marginTop: Spacing.md }}>
                    <MapView center={{ lat: item.lat, lon: item.lon }} marker={{ lat: item.lat, lon: item.lon }} height={120} label={t('map.savedPin')} />
                  </View>
                ) : null}
              </Card>
            );
          }}
        />
      )}

      <SheetModal visible={sheet} onClose={closeSheet} title={editingId ? t('addresses.edit') : t('addresses.add')}>
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
          {serviceAreas.length > 0 ? (
            <View style={{ gap: Spacing.xs }}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                <Text style={styles.fieldLabel}>{t('address.area')}</Text>
                <Text style={styles.fieldHint}>{t('address.areaHint')}</Text>
              </View>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.sm }}>
                {serviceAreas.map((a) => (
                  <Chip
                    key={a.id}
                    label={a.name}
                    selected={area === a.name}
                    onPress={() => {
                      setArea(a.name);
                      setError('');
                    }}
                  />
                ))}
              </View>
            </View>
          ) : null}
          {geoSupported ? (
            <Btn label={t('address.useCurrentLocation')} onPress={locate} variant="outline" size="sm" icon="locate" loading={locating} />
          ) : null}
          {lat !== undefined && lon !== undefined ? <Text style={styles.hint}>{t('address.locationSet')}</Text> : null}
          {/* GPS-detected coordinate preview — the detected marker + the
              platform's accuracy disc. Honest small preview; the blueprint's
              full-screen map selector (pin + reverse-geocode) comes with the
              native maps SDK behind the same lib/maps seam. */}
          {formCoord ? (
            <View style={{ marginTop: Spacing.sm }}>
              <MapView center={formCoord} marker={formCoord} accuracyKm={formAccuracyKm} height={140} label={t('map.savedPin')} />
            </View>
          ) : null}
          {geoError ? <Text style={styles.error}>{geoError}</Text> : null}
          {error ? <Text style={styles.error}>{error}</Text> : null}
          <Btn label={t('addresses.save')} onPress={save} size="lg" />
        </View>
      </SheetModal>
    </Screen>
  );
}

const styles = StyleSheet.create({
  title: { fontSize: FontSize.xxl, fontFamily: Fonts.displayBold, color: Colors.text, marginBottom: Spacing.md },
  card: { marginBottom: Spacing.md },
  cardSelected: { borderColor: Colors.primary, borderWidth: 1.5 },
  label: { fontSize: FontSize.md, fontFamily: Fonts.sansSemibold, color: Colors.text },
  meta: { fontSize: FontSize.xs, color: Colors.textTertiary, fontFamily: Fonts.sans, marginTop: 2 },
  fieldLabel: {
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
    fontFamily: Fonts.sansSemibold,
  },
  fieldHint: { fontSize: FontSize.xs, color: Colors.textFaint, fontFamily: Fonts.sans },
  hint: { color: Colors.success, fontSize: FontSize.xs, fontFamily: Fonts.sansSemibold },
  error: { color: Colors.danger, fontSize: FontSize.sm, fontFamily: Fonts.sansSemibold },
});
