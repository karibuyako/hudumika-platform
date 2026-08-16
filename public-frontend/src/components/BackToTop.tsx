import { useState, useEffect } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { ArrowUp } from 'lucide-react'

export function BackToTop() {
  const [show, setShow] = useState(false)

  useEffect(() => {
    const onScroll = () => setShow(window.scrollY > 600)
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  return (
    <AnimatePresence>
      {show && (
        <motion.button
          initial={{ opacity: 0, scale: 0.8, y: 12 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.8, y: 12 }}
          onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
          className="group fixed right-5 bottom-5 z-[100] flex h-11 w-11 items-center justify-center rounded-full border border-line bg-surface shadow-[0_4px_6px_-1px_rgba(16,20,18,0.06)] transition-colors hover:border-brand-500/30"
          aria-label="Back to top"
        >
          <ArrowUp className="h-4 w-4 text-ink-700 transition-transform duration-300 group-hover:-translate-y-0.5" />
        </motion.button>
      )}
    </AnimatePresence>
  )
}
