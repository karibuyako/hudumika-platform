const value = (key: string) => {
  const candidate = import.meta.env[key]
  return typeof candidate === 'string' ? candidate.trim() : ''
}

export const PUBLIC_CONTACT = {
  consumer: { phone: value('VITE_SUPPORT_CONSUMER_PHONE'), email: value('VITE_SUPPORT_CONSUMER_EMAIL') },
  merchant: { phone: value('VITE_SUPPORT_MERCHANT_PHONE'), email: value('VITE_SUPPORT_MERCHANT_EMAIL') },
  provider: { phone: value('VITE_SUPPORT_PROVIDER_PHONE'), email: value('VITE_SUPPORT_PROVIDER_EMAIL') },
  rider: { phone: value('VITE_SUPPORT_RIDER_PHONE'), email: value('VITE_SUPPORT_RIDER_EMAIL') },
}

export const COMPANY_LOCATION = value('VITE_COMPANY_LOCATION')
