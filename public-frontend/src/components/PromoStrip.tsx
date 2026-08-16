import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { X } from 'lucide-react'
import { Link } from 'react-router-dom'
import { useI18n } from '@/i18n'

export function PromoStrip() {
  const { t } = useI18n()
  const [show, setShow] = useState(() => localStorage.getItem('hudumika.promo') !== 'dismissed')

  const dismiss = () => {
    setShow(false)
    localStorage.setItem('hudumika.promo', 'dismissed')
  }

  return (
    <AnimatePresence>
      {show && (
        <motion.div
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: 'auto', opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          className="relative z-[60] bg-ink-900 text-white"
        >
          <div className="container-x flex h-9 items-center justify-center gap-4 text-xs">
            <p className="font-medium">
              <span className="font-bold text-white">{t('promo.freeDelivery')}</span>
              <span className="text-white/60">{t('promo.feesApply')}</span>
            </p>
            <span className="hidden h-3 w-px bg-white/20 md:block" />
            <span className="hidden md:block">
              <Link to="/login" className="font-semibold text-white/80 transition hover:text-white">
                {t('promo.signIn')}
              </Link>
              <span className="mx-1.5 text-white/30">·</span>
              <Link to="/login" className="font-semibold text-white/80 transition hover:text-white">
                {t('promo.signUp')}
              </Link>
            </span>
            <button
              onClick={dismiss}
              className="absolute right-2 grid h-9 w-9 place-items-center rounded-full text-white/50 transition hover:bg-white/10 hover:text-white"
              aria-label={t('promo.dismiss')}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
