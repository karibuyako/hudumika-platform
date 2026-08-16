/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_CUSTOMER_IOS_URL?: string
  readonly VITE_CUSTOMER_ANDROID_URL?: string
  readonly VITE_MERCHANT_IOS_URL?: string
  readonly VITE_MERCHANT_ANDROID_URL?: string
  readonly VITE_PROVIDER_IOS_URL?: string
  readonly VITE_PROVIDER_ANDROID_URL?: string
  readonly VITE_RIDER_IOS_URL?: string
  readonly VITE_RIDER_ANDROID_URL?: string
  readonly VITE_SUPPORT_CONSUMER_PHONE?: string
  readonly VITE_SUPPORT_CONSUMER_EMAIL?: string
  readonly VITE_SUPPORT_MERCHANT_PHONE?: string
  readonly VITE_SUPPORT_MERCHANT_EMAIL?: string
  readonly VITE_SUPPORT_PROVIDER_PHONE?: string
  readonly VITE_SUPPORT_PROVIDER_EMAIL?: string
  readonly VITE_SUPPORT_RIDER_PHONE?: string
  readonly VITE_SUPPORT_RIDER_EMAIL?: string
  readonly VITE_COMPANY_LOCATION?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
