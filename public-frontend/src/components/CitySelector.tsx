import { useEffect, useRef } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { X, MapPin, Check } from 'lucide-react'
import { CITIES } from '@/data/constants'
import { useCity } from '@/context/city'
import { cn } from '@/utils/cn'

export function CitySelector() {
  const { cityOpen, setCityOpen, cityId, setCityId } = useCity()
  const closeRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!cityOpen) return
    const prev = document.activeElement as HTMLElement | null
    closeRef.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setCityOpen(false)
    }
    document.addEventListener('keydown', onKey)
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = ''
      prev?.focus()
    }
  }, [cityOpen, setCityOpen])

  return (
    <AnimatePresence>
      {cityOpen && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
          className="fixed inset-0 z-[120] flex items-center justify-center px-4"
        >
          <div
            className="absolute inset-0 bg-ink-900/40 backdrop-blur-sm"
            onClick={() => setCityOpen(false)}
          />
          <motion.div
            initial={{ opacity: 0, y: -16, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -12, scale: 0.98 }}
            transition={{ duration: 0.28, ease: [0.16, 1, 0.3, 1] }}
            className="relative w-full max-w-md overflow-hidden rounded-[20px] border border-line bg-surface shadow-[0_50px_120px_-30px_rgba(16,20,18,0.3)]"
            role="dialog"
            aria-modal="true"
            aria-label="Select your city"
          >
            <div className="flex items-center justify-between border-b border-line px-5 py-4">
              <div className="flex items-center gap-2">
                <MapPin className="h-4 w-4 text-brand-500" aria-hidden />
                <span className="text-sm font-semibold text-ink-900">Select your city</span>
              </div>
              <button
                ref={closeRef}
                onClick={() => setCityOpen(false)}
                className="grid h-9 w-9 place-items-center rounded-full text-ink-300 transition-colors hover:bg-paper hover:text-ink-700"
                aria-label="Close city selector"
              >
                <X className="h-4 w-4" aria-hidden />
              </button>
            </div>
            <div className="max-h-[52vh] overflow-y-auto p-2">
              {CITIES.map((city) => (
                <button
                  key={city.id}
                  onClick={() => {
                    setCityId(city.id)
                    setCityOpen(false)
                  }}
                  className={cn(
                    'flex w-full items-center justify-between rounded-xl px-4 py-3 text-left transition-colors',
                    cityId === city.id ? 'bg-brand-50' : 'hover:bg-paper',
                  )}
                >
                  <span>
                    <span className="block text-sm font-medium text-ink-900">{city.name}</span>
                    <span className="block text-xs text-ink-500">{city.region}</span>
                  </span>
                  {cityId === city.id && <Check className="h-4 w-4 text-brand-500" aria-hidden />}
                </button>
              ))}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
