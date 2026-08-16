import { useState, useEffect } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Link } from 'react-router-dom'
import { useI18n } from '@/i18n'

const KEY = 'hudumika.consent'

export function CookieConsent() {
  const { t } = useI18n()
  const [show, setShow] = useState(false)

  useEffect(() => {
    if (localStorage.getItem(KEY)) return
    const t = setTimeout(() => setShow(true), 1800)
    return () => clearTimeout(t)
  }, [])

  const decide = (choice: 'all' | 'essential') => {
    localStorage.setItem(KEY, choice)
    setShow(false)
  }

  return (
    <AnimatePresence>
      {show && (
        <motion.div
          initial={{ opacity: 0, y: 40 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 40 }}
          transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
          className="fixed bottom-4 left-4 z-[110] w-[calc(100vw-2rem)] max-w-sm overflow-hidden rounded-[20px] border border-line bg-surface shadow-[0_30px_80px_-30px_rgba(16,20,18,0.25)]"
          role="dialog"
          aria-label={t('cookie.title')}
        >
          <div className="p-5">
            <div className="text-[10px] font-semibold tracking-widest text-ink-300 uppercase">
              {t('cookie.title')}
            </div>
            <p className="mt-2.5 text-xs leading-relaxed text-ink-500">
              {t('cookie.body')}{' '}
              <Link to="/cookies" className="inline-block py-1.5 font-semibold text-brand-600 hover:text-brand-700">
                {t('cookie.learnMore')}
              </Link>
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              <button
                onClick={() => decide('all')}
                className="rounded-full bg-ink-900 px-4 py-2 text-xs font-semibold text-surface transition-transform hover:scale-[1.03]"
              >
                {t('cookie.acceptAll')}
              </button>
              <button
                onClick={() => decide('essential')}
                className="rounded-full border border-line px-4 py-2 text-xs font-medium text-ink-700 transition-colors hover:border-ink-300"
              >
                {t('cookie.essential')}
              </button>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
