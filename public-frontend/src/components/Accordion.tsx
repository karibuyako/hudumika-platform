import { useId, useState, type ReactNode } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { ChevronDown } from 'lucide-react'
import { cn } from '@/utils/cn'

export function Accordion({
  items,
  title,
  defaultOpen = 0,
  className,
}: {
  items: { q: string; a: string }[]
  title?: string
  defaultOpen?: number | null
  className?: string
}) {
  const [open, setOpen] = useState<number | null>(defaultOpen)
  const baseId = useId()

  return (
    <div className={cn('overflow-hidden rounded-[20px] bg-surface ring-1 ring-line', className)}>
      {title && (
        <div className="border-b border-line bg-paper px-6 py-4">
          <h3 className="text-sm font-black tracking-wide text-ink-900 uppercase">{title}</h3>
        </div>
      )}
      <div>
        {items.map((item, i) => {
          const isOpen = open === i
          const panelId = `${baseId}-panel-${i}`
          const buttonId = `${baseId}-button-${i}`
          return (
            <div key={item.q} className="border-b border-line last:border-0">
              <button
                id={buttonId}
                onClick={() => setOpen(isOpen ? null : i)}
                className="flex w-full items-center justify-between gap-4 px-6 py-4 text-left transition-colors hover:bg-paper/60"
                aria-expanded={isOpen}
                aria-controls={panelId}
              >
                <span className="text-sm font-semibold text-ink-900">{item.q}</span>
                <ChevronDown
                  className={cn('h-4 w-4 shrink-0 text-ink-300 transition-transform duration-300', isOpen && 'rotate-180')}
                  aria-hidden
                />
              </button>
              <AnimatePresence initial={false}>
                {isOpen && (
                  <motion.div
                    id={panelId}
                    role="region"
                    aria-labelledby={buttonId}
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: 'auto', opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
                  >
                    <p className="px-6 pb-5 text-sm leading-relaxed text-ink-500">{item.a}</p>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          )
        })}
      </div>
    </div>
  )
}

export { motion, AnimatePresence }
