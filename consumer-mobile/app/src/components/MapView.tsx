/* Web-safe mini-map (blueprint §26 maps abstraction — the native seam is
 * src/lib/maps.ts; nothing here touches a native maps package).
 *
 * Plain Views only (no react-native-svg, no WebView): a bordered surface with
 * a subtle grid, a crosshair-style pin for the marker, an accuracy disc and a
 * coordinate caption. Rendering math is the pure mapProps() in lib/maps — the
 * component is a thin, testable shell over it.
 *
 * Interactive (Meituan-like) mode: when `interactive` is true the schematic is
 * augmented with merchant pins, a user-location dot and an "Open in Maps"
 * button that delegates to the native maps app via a geo: URI (Linking.openURL).
 * The pure-math projection stays the single source of truth; the extra pins
 * are decorative when no coordinates are supplied so the component remains
 * fully functional without a native map SDK.
 */
import { useMemo } from 'react';
import { Linking, StyleSheet, Text, View } from 'react-native';

import { Btn, Icon } from '@/components/ui';
import { Colors, Fonts, FontSize, Radius, Spacing } from '@/constants/theme';
import { t } from '@/i18n';
import {
  coordinateLabel,
  mapProps,
  MAP_DEFAULT_HEIGHT,
  MAP_DEFAULT_WIDTH,
  projectTo2D,
  type Coordinate,
} from '@/lib/maps';

export interface MapViewProps {
  /** The point the surface is centered on. */
  center: Coordinate;
  /** The pin to render. Null → "Location unavailable" placeholder. */
  marker?: Coordinate | null;
  /** Accuracy disc radius in km (m ÷ 1000 — GeoPosition.accuracy is meters). */
  accuracyKm?: number;
  /** Surface height in px (width fills the parent). */
  height?: number;
  /** a11y label — defaults to map.a11y; screens pass map.riderMarker etc. */
  label?: string;
  /** Meituan-like interactive mode: shows merchant pins, user location and an "Open in Maps" affordance. */
  interactive?: boolean;
  /** Optional extra pins for interactive mode (e.g. nearby merchants). When omitted decorative pins are shown. */
  merchantPins?: Coordinate[];
  /** Optional bike pins for interactive mode (e.g. nearby bikes). Rendered with bicycle icons. */
  bikePins?: Coordinate[];
  /** Selected bike pin index for highlight — when set, that pin uses gold background. */
  selectedBikeIndex?: number | null;
  /** Optional user location for interactive mode; a blue dot. When omitted a decorative dot is shown. */
  userLocation?: Coordinate | null;
  /** Called when the "Open in Maps" button is pressed, before the geo: URI is opened. */
  onOpenMaps?: () => void;
}

const GRID_STEP = 0.25;

export function MapView({
  center,
  marker,
  accuracyKm,
  height = MAP_DEFAULT_HEIGHT,
  label,
  interactive = false,
  merchantPins,
  bikePins,
  selectedBikeIndex,
  userLocation,
  onOpenMaps,
}: MapViewProps) {
  const props = useMemo(
    () => mapProps(center, marker ?? null, accuracyKm, MAP_DEFAULT_WIDTH, height),
    [center, marker, accuracyKm, height],
  );

  const gridLines = useMemo(() => {
    const lines: { key: string; horizontal: boolean; pos: `${number}%` }[] = [];
    for (const f of [GRID_STEP, GRID_STEP * 2, GRID_STEP * 3]) {
      lines.push({ key: `h${f}`, horizontal: true, pos: `${f * 100}%` });
      lines.push({ key: `v${f}`, horizontal: false, pos: `${f * 100}%` });
    }
    return lines;
  }, []);

  const handleOpenMaps = () => {
    if (onOpenMaps) onOpenMaps();
    const target = marker ?? center;
    const geoUrl = `geo:${target.lat},${target.lon}?q=${target.lat},${target.lon}`;
    void Linking.openURL(geoUrl);
  };

  // Interactive merchant pins: when real coordinates are supplied they are
  // projected with the same zoom/center; otherwise decorative fixed pins
  // are shown so the interactive placeholder still feels Meituan-like.
  const projectedMerchants = useMemo(() => {
    if (!interactive || !merchantPins || merchantPins.length === 0) return [];
    return merchantPins.map((coord, idx) => {
      const [dx, dy] = projectTo2D(coord, center, props.zoomPxPerKm);
      const x = MAP_DEFAULT_WIDTH / 2 + dx;
      const y = height / 2 + dy;
      return { key: `merchant-${idx}`, x, y };
    });
  }, [interactive, merchantPins, center, props.zoomPxPerKm, height]);

  const projectedBikes = useMemo(() => {
    if (!interactive || !bikePins || bikePins.length === 0) return [];
    return bikePins.map((coord, idx) => {
      const [dx, dy] = projectTo2D(coord, center, props.zoomPxPerKm);
      const x = MAP_DEFAULT_WIDTH / 2 + dx;
      const y = height / 2 + dy;
      return { key: `bike-${idx}`, x, y, selected: selectedBikeIndex === idx };
    });
  }, [interactive, bikePins, center, props.zoomPxPerKm, height, selectedBikeIndex]);

  const projectedUser = useMemo(() => {
    if (!interactive || !userLocation) return null;
    const [dx, dy] = projectTo2D(userLocation, center, props.zoomPxPerKm);
    return {
      x: MAP_DEFAULT_WIDTH / 2 + dx,
      y: height / 2 + dy,
    };
  }, [interactive, userLocation, center, props.zoomPxPerKm, height]);

  return (
    <View style={{ gap: Spacing.xs }}>
      <View
        style={[styles.surface, { height }, interactive && styles.surfaceInteractive]}
        accessible
        accessibilityRole="image"
        accessibilityLabel={label ?? t('map.a11y')}
        accessibilityValue={props.hasMarker ? { text: coordinateLabel(center) } : undefined}>
        {/* grid of View lines */}
        {gridLines.map((line) => (
          <View
            key={line.key}
            pointerEvents="none"
            style={[line.horizontal ? styles.gridH : styles.gridV, line.horizontal ? { top: line.pos } : { left: line.pos }]}
          />
        ))}

        {props.hasMarker ? (
          <>
            {props.accuracyRadius > 0 ? (
              <View
                pointerEvents="none"
                style={[
                  styles.accuracy,
                  {
                    left: props.markerX - props.accuracyRadius,
                    top: props.markerY - props.accuracyRadius,
                    width: props.accuracyRadius * 2,
                    height: props.accuracyRadius * 2,
                    borderRadius: props.accuracyRadius,
                  },
                ]}
              />
            ) : null}
            {/* crosshair-style pin: dot anchored at the marker point */}
            <View
              pointerEvents="none"
              style={[styles.marker, { left: props.markerX - MARKER_SIZE / 2, top: props.markerY - MARKER_SIZE / 2 }]}>
              <Icon name="location" size={16} color={Colors.primary} />
            </View>
          </>
        ) : (
          <View style={styles.placeholder}>
            <Icon name="location-outline" size={26} color={Colors.textFaint} />
            <Text style={styles.placeholderText}>{t('map.unavailable')}</Text>
          </View>
        )}

        {/* Meituan-like interactive augmentations: merchant pins + user location. */}
        {interactive ? (
          <>
            {/* Projected merchant pins when coordinates supplied */}
            {projectedMerchants.map((m) => (
              <View
                key={m.key}
                pointerEvents="none"
                style={[styles.merchantPin, { left: m.x - MERCHANT_PIN_SIZE / 2, top: m.y - MERCHANT_PIN_SIZE / 2 }]}>
                <Icon name="storefront" size={12} color={Colors.white} />
              </View>
            ))}
            {/* Projected bike pins — bicycle icons, gold when selected */}
            {projectedBikes.map((b) => (
              <View
                key={b.key}
                pointerEvents="none"
                style={[
                  styles.merchantPin,
                  styles.bikePin,
                  b.selected && styles.bikePinSelected,
                  { left: b.x - MERCHANT_PIN_SIZE / 2, top: b.y - MERCHANT_PIN_SIZE / 2 },
                ]}>
                <Icon name="bicycle" size={12} color={Colors.white} />
              </View>
            ))}
            {/* Decorative merchant pins when no coordinates supplied and no bike pins */}
            {projectedMerchants.length === 0 && projectedBikes.length === 0 ? (
              <>
                <View pointerEvents="none" style={[styles.merchantPin, styles.merchantPinDeco1]}>
                  <Icon name="storefront" size={12} color={Colors.white} />
                </View>
                <View pointerEvents="none" style={[styles.merchantPin, styles.merchantPinDeco2]}>
                  <Icon name="restaurant" size={12} color={Colors.white} />
                </View>
                <View pointerEvents="none" style={[styles.merchantPin, styles.merchantPinDeco3]}>
                  <Icon name="cafe" size={12} color={Colors.white} />
                </View>
              </>
            ) : null}

            {/* User location: projected when supplied, otherwise decorative */}
            {projectedUser ? (
              <View
                pointerEvents="none"
                style={[styles.userDotOuter, { left: projectedUser.x - USER_DOT_SIZE / 2, top: projectedUser.y - USER_DOT_SIZE / 2 }]}>
                <View style={styles.userDotInner} />
              </View>
            ) : (
              <View pointerEvents="none" style={[styles.userDotOuter, styles.userDotDeco]}>
                <View style={styles.userDotInner} />
              </View>
            )}
          </>
        ) : null}

        <View style={styles.centerDot} />
      </View>

      <Text style={styles.caption}>
        {t('map.coordinates')}: {coordinateLabel(center)}
      </Text>

      {interactive ? (
        <Btn label="Open in Maps" onPress={handleOpenMaps} variant="outline" size="sm" icon="navigate-outline" style={{ alignSelf: 'flex-start' }} />
      ) : null}
    </View>
  );
}

const MARKER_SIZE = 24;
const MERCHANT_PIN_SIZE = 22;
const USER_DOT_SIZE = 18;

const styles = StyleSheet.create({
  surface: {
    width: '100%',
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: Colors.surface,
    overflow: 'hidden',
  },
  surfaceInteractive: {
    backgroundColor: Colors.surface,
    borderColor: Colors.borderStrong,
  },
  gridH: {
    position: 'absolute',
    left: 0,
    right: 0,
    height: 1,
    backgroundColor: Colors.border,
  },
  gridV: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    width: 1,
    backgroundColor: Colors.border,
  },
  accuracy: {
    position: 'absolute',
    backgroundColor: Colors.primarySoft,
    borderWidth: 1,
    borderColor: Colors.primary,
    opacity: 0.55,
  },
  marker: {
    position: 'absolute',
    width: MARKER_SIZE,
    height: MARKER_SIZE,
    borderRadius: MARKER_SIZE / 2,
    backgroundColor: Colors.white,
    borderWidth: 1.5,
    borderColor: Colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  centerDot: {
    position: 'absolute',
    left: '50%',
    top: '50%',
    width: 6,
    height: 6,
    marginLeft: -3,
    marginTop: -3,
    borderRadius: 3,
    backgroundColor: Colors.textFaint,
  },
  placeholder: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.sm,
  },
  placeholderText: {
    color: Colors.textTertiary,
    fontSize: FontSize.xs,
    fontFamily: Fonts.sansMedium,
  },
  caption: {
    fontSize: FontSize.xs,
    color: Colors.textTertiary,
    fontFamily: Fonts.sans,
    textAlign: 'center',
  },
  merchantPin: {
    position: 'absolute',
    width: MERCHANT_PIN_SIZE,
    height: MERCHANT_PIN_SIZE,
    borderRadius: MERCHANT_PIN_SIZE / 2,
    backgroundColor: Colors.primaryDeep,
    borderWidth: 1.5,
    borderColor: Colors.white,
    alignItems: 'center',
    justifyContent: 'center',
    // subtle shadow so pins float above grid
    shadowColor: Colors.black,
    shadowOpacity: 0.12,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 2 },
    elevation: 2,
  },
  bikePin: {
    backgroundColor: Colors.ink,
  },
  bikePinSelected: {
    backgroundColor: Colors.gold,
    borderColor: Colors.white,
    borderWidth: 2,
  },
  merchantPinDeco1: {
    left: '18%',
    top: '22%',
  },
  merchantPinDeco2: {
    left: '62%',
    top: '30%',
  },
  merchantPinDeco3: {
    left: '38%',
    top: '68%',
  },
  userDotOuter: {
    position: 'absolute',
    width: USER_DOT_SIZE,
    height: USER_DOT_SIZE,
    borderRadius: USER_DOT_SIZE / 2,
    backgroundColor: 'rgba(37, 99, 235, 0.18)',
    borderWidth: 1,
    borderColor: Colors.info,
    alignItems: 'center',
    justifyContent: 'center',
  },
  userDotDeco: {
    left: '52%',
    top: '58%',
  },
  userDotInner: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: Colors.info,
    borderWidth: 1.5,
    borderColor: Colors.white,
  },
});
