import { StyleSheet, Text, View, Dimensions } from 'react-native';
import Svg, { Circle, Line, Path, Rect } from 'react-native-svg';

import { Colors, FontSize, NumberStyle, Spacing } from '@/constants/theme';

export const CHART_WIDTH = Math.min(Dimensions.get('window').width - Spacing.lg * 2 - 2, 720);

function makePoints(data: { label: string; value: number }[], w: number, height: number, padBottom = 16) {
  const max = Math.max(...data.map((d) => d.value), 1);
  const stepX = data.length > 1 ? w / (data.length - 1) : 0;
  return {
    max,
    pts: data.map((d, i) => ({
      x: i * stepX,
      y: height - padBottom - (d.value / max) * (height - padBottom - 22),
      ...d,
    })),
  };
}

export function LineChart({
  data,
  height = 150,
  color = Colors.info,
  showArea = true,
  valueSuffix = '',
}: {
  data: { label: string; value: number }[];
  height?: number;
  color?: string;
  showArea?: boolean;
  valueSuffix?: string;
}) {
  if (data.length === 0) return null;
  const w = CHART_WIDTH;
  const { pts } = makePoints(data, w, height);
  const line = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  const area = pts.length > 1 ? `${line} L${pts[pts.length - 1].x},${height - 14} L${pts[0].x},${height - 14} Z` : '';
  const last = pts[pts.length - 1];
  const labelEvery = Math.max(1, Math.ceil(pts.length / 5));
  return (
    <View>
      <Svg width={w} height={height}>
        {[0.25, 0.5, 0.75].map((f) => (
          <Line key={f} x1={0} x2={w} y1={(height - 14) * f} y2={(height - 14) * f} stroke={Colors.border} strokeWidth={1} strokeDasharray="4 5" />
        ))}
        {pts.length > 2 && showArea ? <Path d={area} fill={color} opacity={0.1} /> : null}
        <Path d={line} stroke={color} strokeWidth={2.5} fill="none" strokeLinejoin="round" strokeLinecap="round" />
        {pts.map((p, i) =>
          i % labelEvery === 0 || i === pts.length - 1 ? (
            <Circle key={i} cx={p.x} cy={p.y} r={3} fill={Colors.card} stroke={color} strokeWidth={2} />
          ) : null,
        )}
        <Circle cx={last.x} cy={last.y} r={5} fill={color} opacity={0.25} />
        <Circle cx={last.x} cy={last.y} r={3.5} fill={color} />
      </Svg>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 6, paddingHorizontal: 2 }}>
        {pts
          .filter((_, i) => i % labelEvery === 0 || i === pts.length - 1)
          .map((p, i) => (
            <Text key={i} style={{ fontSize: FontSize.xs, color: Colors.textFaint }}>{p.label}</Text>
          ))}
      </View>
      <Text style={{ position: 'absolute', right: 0, top: height - 36, fontSize: FontSize.xl, fontWeight: '800', color, fontVariant: NumberStyle.fontVariant }}>
        {valueSuffix ?? ''}{last.value.toLocaleString()}
      </Text>
    </View>
  );
}

export function BarChart({
  data,
  height = 130,
  colors,
  valueSuffix = '',
}: {
  data: { label: string; value: number }[];
  height?: number;
  colors?: string[];
  valueSuffix?: string;
}) {
  if (data.length === 0) return null;
  const w = CHART_WIDTH;
  const max = Math.max(...data.map((d) => d.value), 1);
  const slot = w / data.length;
  const barW = Math.min(20, slot * 0.52);
  const labelEvery = Math.max(1, Math.ceil(data.length / 6));
  const maxIdx = data.findIndex((d) => d.value === max);
  const peekIdx = maxIdx >= 0 ? maxIdx : data.length - 1;
  const peekOfsLabel = peekIdx % labelEvery === 0 || peekIdx === data.length - 1 || peekIdx === 0;
  return (
    <View>
      <Svg width={w} height={height}>
        {[0.33, 0.66].map((f) => (
          <Line key={f} x1={0} x2={w} y1={(height - 18) * f} y2={(height - 18) * f} stroke={Colors.border} strokeWidth={1} strokeDasharray="4 5" />
        ))}
        {data.map((d, i) => {
          const barH = Math.max(2.5, (d.value / max) * (height - 30));
          const color = (colors ?? [])[i] ?? Colors.info;
          return (
            <Rect
              key={i}
              x={i * slot + (slot - barW) / 2}
              y={height - 18 - barH}
              width={barW}
              height={barH}
              rx={Math.min(4, barW / 3)}
              fill={color}
              opacity={i === maxIdx ? 1 : 0.5}
            />
          );
        })}
      </Svg>
      {!peekOfsLabel ? (
        <Text style={[styles.barValue, { left: peekIdx * slot + slot / 2 - 22 }]}>
          {valueSuffix}{data[peekIdx].value.toLocaleString()}
        </Text>
      ) : null}
      <View style={[styles.axis, { justifyContent: 'space-between' }]}>
        {data
          .filter((_, i) => i % labelEvery === 0 || i === data.length - 1)
          .map((d, i) => (
            <Text key={i} style={styles.axisText}>{d.label}</Text>
          ))}
      </View>
    </View>
  );
}

export function Donut({
  data,
  size = 132,
  thickness = 17,
  centerLabel,
  centerValue,
}: {
  data: { name: string; value: number; color: string }[];
  size?: number;
  thickness?: number;
  centerLabel?: string;
  centerValue?: string;
}) {
  const total = data.reduce((s, d) => s + d.value, 0) || 1;
  const r = (size - thickness) / 2;
  const circ = 2 * Math.PI * r;
  const offsets = data.map((_, i) => {
    const prior = data.slice(0, i).reduce((sum, d) => sum + d.value / total, 0);
    return -prior * circ;
  });
  return (
    <View style={styles.donutRow}>
      <View style={{ width: size, height: size }}>
        <Svg width={size} height={size}>
          {data.map((d, i) => {
            const frac = d.value / total;
            const dash = frac * circ;
            const offset = offsets[i];
            return (
              <Circle
                key={i}
                cx={size / 2}
                cy={size / 2}
                r={r}
                stroke={d.color}
                strokeWidth={thickness}
                fill="none"
                strokeDasharray={`${dash} ${circ - dash}`}
                strokeDashoffset={offset}
                strokeLinecap="butt"
                transform={`rotate(-90 ${size / 2} ${size / 2})`}
              />
            );
          })}
        </Svg>
        <View style={styles.donutCenter}>
          <Text style={{ fontSize: FontSize.xl, fontWeight: '800', color: Colors.text, fontVariant: NumberStyle.fontVariant }}>{centerValue}</Text>
          <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary }}>{centerLabel}</Text>
        </View>
      </View>
      <View style={styles.legend}>
        {data.map((d, i) => (
          <View key={i} style={styles.legendRow}>
            <View style={[styles.legendDot, { backgroundColor: d.color }]} />
            <Text style={styles.legendName} numberOfLines={1}>{d.name}</Text>
            <Text style={styles.legendValue}>{Math.round((d.value / total) * 100)}%</Text>
          </View>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  axis: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 6,
    paddingHorizontal: 2,
  },
  axisText: { fontSize: FontSize.xs, color: Colors.textFaint },
  lastValue: {
    position: 'absolute',
    right: 0,
    fontSize: FontSize.xl,
    fontWeight: '800',
    fontVariant: NumberStyle.fontVariant,
  },
  barValue: {
    position: 'absolute',
    top: 0,
    width: 44,
    textAlign: 'center',
    fontSize: FontSize.xs,
    fontWeight: '800',
    color: Colors.text,
    fontVariant: NumberStyle.fontVariant,
  },
  donutRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  donutCenter: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  legend: { flex: 1, gap: 10, paddingLeft: Spacing.xl },
  legendRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  legendDot: { width: 9, height: 9, borderRadius: 4.5 },
  legendName: { flex: 1, fontSize: FontSize.sm, color: Colors.textSecondary },
  legendValue: { fontSize: FontSize.sm, fontWeight: '700', color: Colors.text, fontVariant: NumberStyle.fontVariant },
});