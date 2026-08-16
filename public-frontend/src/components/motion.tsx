import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  motion,
  useInView,
  useScroll,
  useTransform,
  useSpring,
  useMotionValue,
  useReducedMotion,
  type MotionValue,
} from 'framer-motion'
import { cn } from '@/utils/cn'

export const EASE = [0.16, 1, 0.3, 1] as const

/* ── Reveal: scroll-triggered fade-up ─────────────────────────── */
export function Reveal({
  children,
  delay = 0,
  y = 28,
  blur = true,
  className,
  once = true,
}: {
  children: ReactNode
  delay?: number
  y?: number
  blur?: boolean
  className?: string
  once?: boolean
}) {
  const reduce = useReducedMotion()
  if (reduce) return <div className={className}>{children}</div>
  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y, filter: blur ? 'blur(8px)' : 'blur(0px)' }}
      whileInView={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
      viewport={{ once, margin: '-80px' }}
      transition={{ duration: 0.8, delay, ease: EASE }}
    >
      {children}
    </motion.div>
  )
}

/* ── Stagger: cascading children entrance ─────────────────────── */
export function Stagger({
  children,
  className,
  gap = 0.08,
}: {
  children: ReactNode
  className?: string
  gap?: number
}) {
  const reduce = useReducedMotion()
  if (reduce) return <div className={className}>{children}</div>
  return (
    <motion.div
      className={className}
      initial="hidden"
      whileInView="show"
      viewport={{ once: true, margin: '-70px' }}
      variants={{
        hidden: {},
        show: { transition: { staggerChildren: gap } },
      }}
    >
      {children}
    </motion.div>
  )
}

export function StaggerItem({
  children,
  className,
  y = 24,
}: {
  children: ReactNode
  className?: string
  y?: number
}) {
  const reduce = useReducedMotion()
  if (reduce) return <div className={className}>{children}</div>
  return (
    <motion.div
      className={className}
      variants={{
        hidden: { opacity: 0, y, filter: 'blur(6px)' },
        show: { opacity: 1, y: 0, filter: 'blur(0px)' },
      }}
      transition={{ duration: 0.7, ease: EASE }}
    >
      {children}
    </motion.div>
  )
}

/* ── Words: word-by-word headline reveal ──────────────────────── */
export function Words({
  text,
  className,
  delay = 0,
  wordClass,
}: {
  text: string
  className?: string
  delay?: number
  wordClass?: (w: string, i: number) => string | undefined
}) {
  const words = text.split(' ')
  return (
    <span className={`inline-block ${className ?? ''}`}>
      {words.map((w, i) => (
        <span key={`${w}-${i}`} className="inline-block overflow-hidden align-bottom">
          <motion.span
            className={`inline-block ${wordClass?.(w, i) ?? ''}`}
            initial={{ y: '108%', opacity: 0 }}
            animate={{ y: '0%', opacity: 1 }}
            transition={{ duration: 0.9, delay: delay + i * 0.05, ease: EASE }}
          >
            {w}
            {i < words.length - 1 ? '\u00A0' : ''}
          </motion.span>
        </span>
      ))}
    </span>
  )
}

/* ── Typewriter: cycling text with cursor ─────────────────────── */
export function Typewriter({
  phrases,
  className,
  speed = 46,
  hold = 1700,
}: {
  phrases: string[]
  className?: string
  speed?: number
  hold?: number
}) {
  const [i, setI] = useState(0)
  const [txt, setTxt] = useState('')
  const [del, setDel] = useState(false)

  const reduce = useReducedMotion()

  useEffect(() => {
    if (reduce) return
    const full = phrases[i % phrases.length]
    if (!del && txt === full) {
      const t = setTimeout(() => setDel(true), hold)
      return () => clearTimeout(t)
    }
    if (del && txt === '') {
      setDel(false)
      setI((v) => v + 1)
      return
    }
    const t = setTimeout(
      () => setTxt(del ? full.slice(0, txt.length - 1) : full.slice(0, txt.length + 1)),
      del ? speed / 2 : speed,
    )
    return () => clearTimeout(t)
  }, [txt, del, i, phrases, speed, hold])

  return (
    <span className={className}>
      {reduce ? phrases[0] : txt}
      <span
        className="ml-0.5 inline-block h-[0.95em] w-[2px] translate-y-[2px] animate-caret bg-brand-500"
        aria-hidden
      />
    </span>
  )
}

/* ── Counter: animated number on scroll ───────────────────────── */
export function Counter({
  to,
  suffix = '',
  prefix = '',
  decimals = 0,
  duration = 1900,
  className,
}: {
  to: number
  suffix?: string
  prefix?: string
  decimals?: number
  duration?: number
  className?: string
}) {
  const ref = useRef<HTMLSpanElement>(null)
  const inView = useInView(ref, { once: true, margin: '-60px' })
  const [val, setVal] = useState(0)

  useEffect(() => {
    if (!inView) return
    let raf = 0
    const start = performance.now()
    const tick = (now: number) => {
      const p = Math.min((now - start) / duration, 1)
      const eased = 1 - Math.pow(1 - p, 4)
      setVal(to * eased)
      if (p < 1) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [inView, to, duration])

  return (
    <span ref={ref} className={className}>
      {prefix}
      {val.toLocaleString(undefined, {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals,
      })}
      {suffix}
    </span>
  )
}

/* ── Parallax ─────────────────────────────────────────────────── */
export function useParallax(
  distance = 80,
): [React.RefObject<HTMLDivElement | null>, MotionValue<number>] {
  const ref = useRef<HTMLDivElement>(null)
  const { scrollYProgress } = useScroll({
    target: ref,
    offset: ['start end', 'end start'],
  })
  const y = useTransform(scrollYProgress, [0, 1], [distance, -distance])
  return [ref, useSpring(y, { stiffness: 90, damping: 22, mass: 0.4 })]
}

/* ── Marquee: infinite horizontal scroll ──────────────────────── */
export function Marquee({
  children,
  duration = 42,
  className,
}: {
  children: ReactNode
  duration?: number
  className?: string
}) {
  return (
    <div className={`marquee-mask relative overflow-hidden ${className ?? ''}`}>
      <div
        className="animate-marquee flex w-max items-center"
        style={{ ['--marquee-duration' as string]: `${duration}s` }}
      >
        <div className="flex shrink-0 items-center">{children}</div>
        <div className="flex shrink-0 items-center" aria-hidden>
          {children}
        </div>
      </div>
    </div>
  )
}

/* ── ScrollProgress: top progress bar ─────────────────────────── */
export function ScrollProgress() {
  const { scrollYProgress } = useScroll()
  const x = useSpring(scrollYProgress, { stiffness: 140, damping: 26, mass: 0.3 })
  return (
    <motion.div
      style={{ scaleX: x }}
      className="fixed inset-x-0 top-0 z-[95] h-[2px] origin-left bg-gradient-to-r from-brand-500 via-brand-600 to-brand-700"
    />
  )
}

/* ── SectionHeading: eyebrow + title + sub + action ───────────── */
export function SectionHeading({
  eyebrow,
  title,
  sub,
  action,
  light,
  center,
  className,
}: {
  eyebrow?: string
  title: string
  sub?: string
  action?: ReactNode
  light?: boolean
  center?: boolean
  className?: string
}) {
  return (
    <Reveal
      className={cn(
        'mb-8 flex flex-wrap items-end justify-between gap-4',
        center && 'flex-col items-center text-center',
        className,
      )}
    >
      <div className={cn(center && 'flex flex-col items-center')}>
        {eyebrow && (
          <p
            className={cn(
              'mb-2 text-xs font-bold uppercase tracking-[0.22em]',
              light ? 'text-white/60' : 'text-brand-500',
            )}
          >
            {eyebrow}
          </p>
        )}
        <h2
          className={cn(
            'font-display text-2xl font-bold tracking-tight text-ink-900 sm:text-3xl',
            light && 'text-white',
          )}
        >
          {title}
        </h2>
        {sub && (
          <p className={cn('mt-2 max-w-xl text-sm', light ? 'text-white/60' : 'text-ink-500')}>
            {sub}
          </p>
        )}
      </div>
      {action}
    </Reveal>
  )
}

/* ── Tilt3DCard: mouse-follow 3D tilt (reference build) ───────── */
export function Tilt3DCard({
  children,
  className,
}: {
  children: ReactNode
  className?: string
}) {
  const cardRef = useRef<HTMLDivElement>(null)
  const reduce = useReducedMotion()
  if (reduce) return <div className={cn('tilt-3d cursor-pointer', className)}>{children}</div>
  const x = useMotionValue(0.5)
  const y = useMotionValue(0.5)

  const rotateX = useTransform(y, [0, 1], [14, -14])
  const rotateY = useTransform(x, [0, 1], [-14, 14])

  function handleMouseMove(e: React.MouseEvent) {
    const el = cardRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    x.set((e.clientX - rect.left) / rect.width)
    y.set((e.clientY - rect.top) / rect.height)
  }

  function handleMouseLeave() {
    x.set(0.5)
    y.set(0.5)
  }

  return (
    <motion.div
      ref={cardRef}
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
      style={{ rotateX, rotateY, transformStyle: 'preserve-3d' }}
      whileHover={{ scale: 1.02, translateZ: 20 }}
      transition={{ type: 'spring', stiffness: 300, damping: 20 }}
      className={cn('tilt-3d cursor-pointer [perspective:1000px]', className)}
    >
      <div style={{ transform: 'translateZ(30px)' }} className="h-full">
        {children}
      </div>
    </motion.div>
  )
}

/* ── FloatingBadge: infinite gentle float (reference build) ───── */
export function FloatingBadge({
  children,
  className,
  duration = 5,
  amplitude = 6,
  delay = 0,
}: {
  children: ReactNode
  className?: string
  duration?: number
  amplitude?: number
  delay?: number
}) {
  const reduce = useReducedMotion()
  if (reduce) return <div className={className}>{children}</div>
  return (
    <motion.div
      animate={{ y: [0, -amplitude, 0] }}
      transition={{ duration, repeat: Infinity, ease: 'easeInOut', delay }}
      className={className}
    >
      {children}
    </motion.div>
  )
}

export { motion, useScroll, useTransform, useSpring, useInView, useMotionValue }
