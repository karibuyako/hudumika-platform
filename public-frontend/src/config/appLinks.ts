export type AppPlatform = 'ios' | 'android'

export type AppLinks = {
  customer: Record<AppPlatform, string> & { apk: string }
  merchant: Record<AppPlatform, string> & { apk: string }
  provider: Record<AppPlatform, string> & { apk: string }
  rider: Record<AppPlatform, string> & { apk: string }
}

// APK binaries are produced by .github/workflows/build-android.yml and published
// to GitHub Releases. The site links to the latest release asset for each app,
// served from GitHub's free CDN. Override per-app via VITE_*_APK_URL if needed.
const RELEASE_BASE = 'https://github.com/karibuyako/hudumika-platform/releases/latest/download'

const value = (key: string) => {
  const candidate = import.meta.env[key]
  return typeof candidate === 'string' ? candidate.trim() : ''
}

export const APP_LINKS: AppLinks = {
  customer: {
    ios: value('VITE_CUSTOMER_IOS_URL'),
    android: value('VITE_CUSTOMER_ANDROID_URL'),
    apk: value('VITE_CUSTOMER_APK_URL') || `${RELEASE_BASE}/hudumika-consumer.apk`,
  },
  merchant: {
    ios: value('VITE_MERCHANT_IOS_URL'),
    android: value('VITE_MERCHANT_ANDROID_URL'),
    apk: value('VITE_MERCHANT_APK_URL') || `${RELEASE_BASE}/hudumika-merchant.apk`,
  },
  provider: {
    ios: value('VITE_PROVIDER_IOS_URL'),
    android: value('VITE_PROVIDER_ANDROID_URL'),
    apk: value('VITE_PROVIDER_APK_URL') || `${RELEASE_BASE}/hudumika-provider.apk`,
  },
  rider: {
    ios: value('VITE_RIDER_IOS_URL'),
    android: value('VITE_RIDER_ANDROID_URL'),
    apk: value('VITE_RIDER_APK_URL') || `${RELEASE_BASE}/hudumika-rider.apk`,
  },
}
