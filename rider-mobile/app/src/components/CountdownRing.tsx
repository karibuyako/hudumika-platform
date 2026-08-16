/* Self-ticking countdown ring (offer window, unreachable protocol, …).
 *
 * Owns its 1s interval internally so the parent screen does NOT re-render
 * every second — only this node ticks. Progress is derived from `expiresAt`
 * each tick, so background/foreground drift self-corrects.
 *
 * Ring: surface track + success-green progress arc that depletes linearly
 * over `totalSeconds`, mmss text centered, timer accessibility label that
 * updates per tick. Reduced-motion users get a static full ring (no sweep).
 */
import { useEffect, useRef, useState } from 'react';
import { AppState, StyleSheet, Text, View } from 'react-native';
import Svg, { Circle } from 'react-native-svg';

import { Colors, FontSize, NumberStyle } from '@/constants/theme';
import { mmss } from '@/lib/format';
import { useReduceMotion } from '@/components/ui';

export interface CountdownRingProps {
  /** ms epoch at which the countdown reaches zero. */
  expiresAt: number;
  /** Denominator used for the ring sweep (clamps the display). Default 120s. */
  totalSeconds?: number;
  /** Outer diameter in px. Default 72 (a 36px radius ring). */
  size?: number;
  strokeWidth?: number;
  /** Accessible prefix for the timer label (e.g. "New delivery offer"). */
  label?: string;
  /** Fired once when the countdown reaches zero. */
  onExpire?: () => void;
}

export function CountdownRing({
  expiresAt,
  totalSeconds = 120,
  size = 72,
  strokeWidth = 6,
  label,
  onExpire,
}: CountdownRingProps) {
  const reduceMotion = useReduceMotion();
  const [remaining, setRemaining] = useState(() =>
    Math.max(0, Math.min(totalSeconds, Math.floor((expiresAt - Date.now()) / 1000))),
  );
  const expiredRef = useRef(false);

  useEffect(() => {
    let iv: ReturnType<typeof setInterval> | undefined;
    const tick = () => {
      const rem = Math.max(0, Math.min(totalSeconds, Math.floor((expiresAt - Date.now()) / 1000)));
      setRemaining(rem);
      if (rem <= 0) {
        if (iv) clearInterval(iv);
        if (!expiredRef.current) {
          expiredRef.current = true;
          onExpire?.();
        }
      }
    };
    tick();
    iv = setInterval(tick, 1000);
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') tick();
    });
    return () => {
      if (iv) clearInterval(iv);
      sub.remove();
    };
  }, [expiresAt, totalSeconds, onExpire]);

  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const progress = remaining / totalSeconds;
  const offset = circumference * (1 - progress);
  const labelText = label ? `${label} — ${mmss(remaining)}` : mmss(remaining);

  return (
    <View
      accessible
      accessibilityRole="timer"
      accessibilityLabel={labelText}
      style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
      <Svg width={size} height={size} style={styles.ring}>
        <Circle cx={size / 2} cy={size / 2} r={radius} stroke={Colors.surface} strokeWidth={strokeWidth} fill="none" />
        <Circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          stroke={Colors.success}
          strokeWidth={strokeWidth}
          fill="none"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={reduceMotion ? 0 : offset}
        />
      </Svg>
      <Text style={styles.time}>{mmss(remaining)}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  ring: { position: 'absolute', transform: [{ rotate: '-90deg' }] },
  time: { fontSize: FontSize.lg, fontWeight: '800', color: Colors.text, fontVariant: NumberStyle.fontVariant },
});
