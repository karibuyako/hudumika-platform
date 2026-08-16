export type AppPlatform = 'ios' | 'android'

export type AppLinks = {
  customer: Record<AppPlatform, string>
  merchant: Record<AppPlatform, string>
  provider: Record<AppPlatform, string>
  rider: Record<AppPlatform, string>
}

const value = (key: string) => {
  const candidate = import.meta.env[key]
  return typeof candidate === 'string' ? candidate.trim() : ''
}

export const APP_LINKS: AppLinks = {
  customer: { ios: value('VITE_CUSTOMER_IOS_URL'), android: value('VITE_CUSTOMER_ANDROID_URL') },
  merchant: { ios: value('VITE_MERCHANT_IOS_URL'), android: value('VITE_MERCHANT_ANDROID_URL') },
  provider: { ios: value('VITE_PROVIDER_IOS_URL'), android: value('VITE_PROVIDER_ANDROID_URL') },
  rider: { ios: value('VITE_RIDER_IOS_URL'), android: value('VITE_RIDER_ANDROID_URL') },
}
