const value = (key: string) => {
  const candidate = import.meta.env[key]
  return typeof candidate === 'string' ? candidate.trim() : ''
}

export const USE_MOCKS = !import.meta.env.PROD && value('VITE_USE_MOCKS') !== 'false'

export const MOCK_FLAGS = {
  merchants: value('VITE_MOCK_MERCHANTS') !== 'false',
  services: value('VITE_MOCK_SERVICES') !== 'false',
} as const
