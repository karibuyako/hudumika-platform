/* Camera QR scanner for dine-in table codes (DINE-IN.md: payload
 * `hudumika:dinein:table:{tableId}`) and power-bank codes
 * (`hudumika:powerbank:{id}`). Renders inside a SheetModal: camera preview +
 * static scan overlay + Cancel. The parent runs the existing resolve flow once
 * onScan fires with a valid payload. When no filter is supplied the scanner
 * accepts dine-in and power-bank QRs.
 *
 * expo-camera is lazy-loaded so the esbuild node test bundle never imports
 * it; on web the module's own getUserMedia implementation powers the preview
 * (localhost/HTTPS only — denied/unavailable cameras degrade to the manual
 * entry field with an honest error). No animations — reduced-motion safe.
 */
import { useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { Btn, Icon, SheetModal } from '@/components/ui';
import { Colors, FontSize, Fonts, Radius, Spacing } from '@/constants/theme';
import { t } from '@/i18n';
import { parseTableQr } from '@/lib/dineIn';
import { parsePowerBankQr } from '@/lib/powerBank';

interface Props {
  visible: boolean;
  onScan: (payload: string) => void;
  onClose: () => void;
  /** Optional filter for scanned payloads — when omitted dine-in and power-bank QRs are accepted. */
  filter?: (payload: string) => boolean;
  /** Optional title override for the sheet (defaults to dineIn.scan). */
  title?: string;
  /** Optional hint override (defaults to dineIn.scanHint). */
  hint?: string;
}

/* Minimal local shapes — never a static import of expo-camera, so the node
 * test bundle (which bundles libs/repos/stores only) stays native-free. */
interface ScanResult {
  data: string;
}
type CameraModule = {
  CameraView: React.ComponentType<{
    facing?: 'front' | 'back';
    active?: boolean;
    style?: unknown;
    barcodeScannerSettings?: { barcodeTypes?: string[] };
    onBarcodeScanned?: (result: ScanResult) => void;
    onMountError?: (error: unknown) => void;
  }>;
  useCameraPermissions: () => [{ granted: boolean; status: string; canAskAgain: boolean } | null, () => Promise<{ granted: boolean }>, () => Promise<{ granted: boolean }>];
};

export function QrScanner({ visible, onScan, onClose, filter, title, hint }: Props) {
  const [mod, setMod] = useState<CameraModule | null>(null);
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    if (!visible) return;
    let mounted = true;
    setLoadError(false);
    // Lazy import: expo-camera loads only when the scanner actually opens
    // (and never in the node test bundle / headless web unless opened).
    import('expo-camera')
      .then((m) => {
        if (mounted) setMod(m as unknown as CameraModule);
      })
      .catch(() => {
        if (mounted) setLoadError(true);
      });
    return () => {
      mounted = false;
    };
  }, [visible]);

  return (
    <SheetModal visible={visible} onClose={onClose} title={title ?? t('dineIn.scan')}>
      {loadError || !mod ? (
        <View style={styles.body}>
          <View style={styles.iconWrap}>
            <Icon name="camera-outline" size={26} color={Colors.textTertiary} />
          </View>
          {loadError ? (
            <Text style={styles.copy} accessibilityRole="alert">
              {t('camera.denied')}
            </Text>
          ) : (
            <Text style={styles.copy}>{t('common.loading')}</Text>
          )}
          {loadError ? <Btn label={t('camera.retry')} onPress={() => setLoadError(false)} variant="outline" /> : null}
          <Btn label={t('common.cancel')} onPress={onClose} variant="subtle" size="lg" />
        </View>
      ) : (
        <CameraBody mod={mod} onScan={onScan} onClose={onClose} filter={filter} hint={hint} />
      )}
    </SheetModal>
  );
}

function CameraBody({ mod, onScan, onClose, filter, hint }: { mod: CameraModule; onScan: (p: string) => void; onClose: () => void; filter?: (payload: string) => boolean; hint?: string }) {
  // Called unconditionally once the module exists (hooks rules).
  const [permission, requestPermission] = mod.useCameraPermissions();
  const [startFailed, setStartFailed] = useState(false);
  const [done, setDone] = useState(false);
  const handledRef = useRef(false);

  // Permission prompt happens on demand (expo-camera on web asks on request).
  const allow = async () => {
    const result = await requestPermission();
    // getUserMedia denial/rejection still lands here — the view then shows
    // the explainer copy and the manual entry remains usable.
    setStartFailed(result.granted ? false : true);
  };

  if (permission === null) {
    return (
      <View style={styles.body}>
        <Text style={styles.copy}>{t('common.loading')}</Text>
        <Btn label={t('common.cancel')} onPress={onClose} variant="subtle" size="lg" />
      </View>
    );
  }

  if (!permission.granted || startFailed) {
    const denied = !permission.granted && permission.status === 'denied' && !permission.canAskAgain;
    return (
      <View style={styles.body}>
        <View style={styles.iconWrap}>
          <Icon name="camera-outline" size={26} color={Colors.textTertiary} />
        </View>
        <Text style={styles.copy} accessibilityRole="alert">
          {denied ? t('camera.denied') : t('camera.explain')}
        </Text>
        {denied ? (
          <>
            <Btn label={t('camera.retry')} onPress={allow} variant="outline" />
            <Text style={styles.hint}>{t('dineIn.manualHint')}</Text>
          </>
        ) : (
          <Btn label={t('camera.allow')} onPress={allow} size="lg" />
        )}
        <Btn label={t('common.cancel')} onPress={onClose} variant="subtle" size="lg" />
      </View>
    );
  }

  return (
    <View style={styles.body}>
      <View style={styles.previewWrap}>
        <mod.CameraView
          style={StyleSheet.absoluteFill}
          facing="back"
          active={!done}
          barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
          onBarcodeScanned={(result) => {
            if (handledRef.current) return;
            // Ignore foreign QRs — only exact payloads per the filter resolve.
            // Default accepts dine-in and power-bank QRs (hudumika:powerbank:{id}).
            const ok = filter
              ? filter(result.data)
              : !!parseTableQr(result.data) || !!parsePowerBankQr(result.data);
            if (!ok) return;
            handledRef.current = true;
            setDone(true);
            onScan(result.data);
          }}
          onMountError={() => {
            // No camera / stream denied at the browser level — degrade with
            // an honest error; the manual entry field remains.
            handledRef.current = true;
            setDone(true);
            setStartFailed(true);
          }}
        />
        <View style={styles.scanFrame} pointerEvents="none">
          <View style={[styles.corner, styles.cornerTL]} />
          <View style={[styles.corner, styles.cornerTR]} />
          <View style={[styles.corner, styles.cornerBL]} />
          <View style={[styles.corner, styles.cornerBR]} />
        </View>
      </View>
      <Text style={styles.hint}>{hint ?? t('dineIn.scanHint')}</Text>
      <Btn label={t('common.cancel')} onPress={onClose} variant="subtle" size="lg" />
    </View>
  );
}

const styles = StyleSheet.create({
  body: { alignItems: 'center', gap: Spacing.md, paddingVertical: Spacing.sm },
  iconWrap: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: Colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  copy: {
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
    fontFamily: Fonts.sans,
    textAlign: 'center',
    lineHeight: 19,
  },
  hint: { fontSize: FontSize.xs, color: Colors.textTertiary, fontFamily: Fonts.sans, textAlign: 'center' },
  previewWrap: {
    width: '100%',
    height: 280,
    borderRadius: Radius.lg,
    overflow: 'hidden',
    backgroundColor: Colors.black,
  },
  scanFrame: {
    position: 'absolute',
    top: '25%',
    bottom: '25%',
    left: '20%',
    right: '20%',
  },
  corner: {
    position: 'absolute',
    width: 22,
    height: 22,
    borderColor: Colors.white,
  },
  cornerTL: { top: 0, left: 0, borderTopWidth: 3, borderLeftWidth: 3, borderTopLeftRadius: 6 },
  cornerTR: { top: 0, right: 0, borderTopWidth: 3, borderRightWidth: 3, borderTopRightRadius: 6 },
  cornerBL: { bottom: 0, left: 0, borderBottomWidth: 3, borderLeftWidth: 3, borderBottomLeftRadius: 6 },
  cornerBR: { bottom: 0, right: 0, borderBottomWidth: 3, borderRightWidth: 3, borderBottomRightRadius: 6 },
});
