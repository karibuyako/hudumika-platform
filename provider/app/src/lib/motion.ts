/* Motion & haptics — respect the system reduce-motion setting.
 *
 * M6 a11y: when the OS asks for reduced motion we disable slide/parallax
 * animations and skip haptic feedback. The flag is read once at boot in the
 * root layout and kept in sync via AccessibilityInfo.
 */
import { AccessibilityInfo } from 'react-native';

let reduceMotion = false;

export function setReduceMotion(enabled: boolean) {
  reduceMotion = enabled;
}

export function isReduceMotion(): boolean {
  return reduceMotion;
}

/** Gate for animations: pass to Modal/animation props. */
export function motionAnimation(): 'none' | 'slide' | 'fade' {
  return reduceMotion ? 'none' : 'slide';
}

/** Screen-reader announcement for live updates (new offer, expiry, status change). */
export function announce(message: string) {
  try {
    AccessibilityInfo.announceForAccessibility(message);
  } catch {
    /* unavailable on this platform */
  }
}

/* ---- Haptics wrapper (no-ops under reduce motion) ---- */

type HapticNotif = (type: 'success' | 'warning' | 'error') => void;

let notif: HapticNotif | null = null;
let selection: (() => void) | null = null;

function loadHaptics(): void {
  if (notif || selection) return;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Haptics = require('expo-haptics');
    notif = (type: 'success' | 'warning' | 'error') => void Haptics.notificationAsync(type);
    selection = () => void Haptics.selectionAsync();
  } catch {
    notif = () => undefined;
    selection = () => undefined;
  }
}

export function hapticSuccess() {
  if (reduceMotion) return;
  loadHaptics();
  notif?.('success');
}

export function hapticWarning() {
  if (reduceMotion) return;
  loadHaptics();
  notif?.('warning');
}

export function hapticError() {
  if (reduceMotion) return;
  loadHaptics();
  notif?.('error');
}

export function hapticSelection() {
  if (reduceMotion) return;
  loadHaptics();
  selection?.();
}
