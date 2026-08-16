import { createContext, useContext, useState, type ReactNode } from 'react'
import { CITIES } from '@/data/constants'

type CityCtx = {
  cityId: string
  cityName: string
  setCityId: (id: string) => void
  cityOpen: boolean
  setCityOpen: (open: boolean) => void
}

const Ctx = createContext<CityCtx | null>(null)

export function CityProvider({ children }: { children: ReactNode }) {
  const [cityId, setCityId] = useState('dar')
  const [cityOpen, setCityOpen] = useState(false)
  const cityName = CITIES.find((c) => c.id === cityId)?.name ?? 'Dar es Salaam'

  return (
    <Ctx.Provider value={{ cityId, cityName, setCityId, cityOpen, setCityOpen }}>
      {children}
    </Ctx.Provider>
  )
}

export function useCity() {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useCity must be used within CityProvider')
  return ctx
}
