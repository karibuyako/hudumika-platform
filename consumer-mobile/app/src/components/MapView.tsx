/* Web-safe mini-map (blueprint §26 maps abstraction — the native seam is
 * src/lib/maps.ts; nothing here touches a native maps package).
 *
 * Plain Views only (no react-native-svg, no WebView): a bordered surface with
 * a subtle grid, a crosshair-style pin for the marker, an accuracy disc and a
 * coordinate caption. Rendering math is the pure mapProps() in lib/maps — the
 * component is a thin, testable shell over it.
 */
import { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { Icon } from '@/components/ui';
import { Colors, Fonts, FontSize, Radius, Spacing } from '@/constants/theme';
import { t } from '@/i18n';
import {
  coordinateLabel,
  mapProps,
  MAP_DEFAULT_HEIGHT,
  MAP_DEFAULT_WIDTH,
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
}

const GRID_STEP = 0.25;

export function MapView({ center, marker, accuracyKm, height = MAP_DEFAULT_HEIGHT, label }: MapViewProps) {
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

  return (
    <View style={{ gap: Spacing.xs }}>
      <View
        style={[styles.surface, { height }]}
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

        <View style={styles.centerDot} />
      </View>

      <Text style={styles.caption}>
        {t('map.coordinates')}: {coordinateLabel(center)}
      </Text>
    </View>
  );
}

const MARKER_SIZE = 24;

const styles = StyleSheet.create({
  surface: {
    width: '100%',
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: Colors.surface,
    overflow: 'hidden',
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
});
