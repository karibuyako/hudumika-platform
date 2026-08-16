import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowLeft, MapPin, Search, Clock, Truck } from 'lucide-react'
import { motion } from 'framer-motion'
import { SERVICE_GROUPS, RESTAURANTS } from '@/data/constants'
import { useCity } from '@/context/city'
import { Reveal, SectionHeading } from '@/components/motion'
import { Rating } from '@/components/Rating'
import { cn } from '@/utils/cn'
import { usePageMeta } from '@/hooks/usePageMeta'

const STEPS = [
  { n: '01', t: 'Browse & Choose', d: 'Explore menus from local restaurants, filter by cuisine, rating, or delivery time.' },
  { n: '02', t: 'Place Your Order', d: 'Checkout securely with M-Pesa, card, or cash on delivery.' },
  { n: '03', t: 'Track & Enjoy', d: 'Follow your rider in real time. Food arrives hot at your door.' },
]

export default function ConsumerPage() {
  usePageMeta('/consumer')
  const { cityName } = useCity()
  const [query, setQuery] = useState('')
  const [active, setActive] = useState<string>('All')

  const filtered = useMemo(() => {
    return RESTAURANTS.filter((r) => {
      const q = query.trim().toLowerCase()
      const matchQ = !q || r.name.toLowerCase().includes(q) || r.cuisine.toLowerCase().includes(q)
      const matchC = active === 'All' || r.category === active
      return matchQ && matchC
    })
  }, [query, active])

  const cats = ['All', ...SERVICE_GROUPS.map((c) => c.label)]

  return (
    <div className="pt-24">
      {/* Hero */}
      <section className="relative overflow-hidden bg-paper pt-10 pb-14 md:pt-14">
        <div className="absolute inset-0 opacity-[0.035]">
          <div className="absolute inset-0 bg-[radial-gradient(70%_50%_at_50%_0%,var(--color-brand-500),transparent_65%)]" />
        </div>
        <div className="container-x relative">
          <Link
            to="/"
            className="mb-8 inline-flex items-center gap-2 text-sm font-medium text-ink-500 transition-colors hover:text-ink-900"
          >
            <ArrowLeft className="h-4 w-4" />
            Back to home
          </Link>

          <div className="mx-auto max-w-2xl text-center">
            <motion.span
              initial={{ opacity: 0, y: 14 }}
              animate={{ opacity: 1, y: 0 }}
              className="inline-flex items-center gap-2 rounded-full border border-brand-500/20 bg-surface px-3.5 py-1.5 text-xs font-semibold text-ink-900 shadow-sm"
            >
              <MapPin className="h-3 w-3 text-brand-500" />
              Order online in {cityName}
            </motion.span>
            <motion.h1
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.08 }}
              className="mt-5 font-display text-3xl font-bold tracking-tight text-ink-900 md:text-4xl"
            >
              Food, delivered <span className="bg-gradient-to-r from-brand-600 to-brand-500 bg-clip-text text-transparent">fast</span>
            </motion.h1>
            <motion.p
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.16 }}
              className="mt-3 text-sm leading-relaxed text-ink-500 md:text-base"
            >
              Browse thousands of restaurants, order your favourite meals, and get them delivered to
              your door.
            </motion.p>
            <motion.div
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.24 }}
              className="mx-auto mt-7 flex max-w-md items-center gap-2 rounded-full border border-line bg-surface p-1.5 pl-4 shadow-sm transition-all focus-within:border-brand-500/40"
            >
              <Search className="h-4 w-4 shrink-0 text-brand-500" />
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search restaurants or cuisines…"
                className="w-full bg-transparent text-sm text-ink-900 outline-none placeholder:text-ink-300"
              />
            </motion.div>
          </div>
        </div>
      </section>

      {/* Category chips */}
      <section className="container-x">
        <div className="no-scrollbar -mx-4 flex gap-2 overflow-x-auto px-4 pb-1">
          {cats.map((c) => (
            <button
              key={c}
              onClick={() => setActive(c)}
              className={cn(
                'whitespace-nowrap rounded-full px-4 py-2 text-xs font-bold ring-1 transition',
                active === c
                  ? 'bg-ink-900 text-white ring-ink-900'
                  : 'bg-surface text-ink-700 ring-line hover:bg-paper',
              )}
            >
              {c}
            </button>
          ))}
        </div>
      </section>

      {/* Restaurant grid */}
      <section className="container-x py-12 md:py-16">
        <SectionHeading
          eyebrow="Explore"
          title={
            filtered.length
              ? `${filtered.length} place${filtered.length > 1 ? 's' : ''} near you`
              : 'No matches'
          }
          sub={query || active !== 'All' ? 'Showing results for your filters.' : 'From trusted local restaurants to big chains.'}
        />
        {filtered.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-line bg-surface p-10 text-center">
            <p className="text-sm font-semibold text-ink-900">Nothing matched your search.</p>
            <p className="mt-1 text-xs text-ink-500">Try a different name or clear the filters.</p>
            <button
              onClick={() => {
                setQuery('')
                setActive('All')
              }}
              className="mt-4 rounded-full bg-ink-900 px-5 py-2.5 text-xs font-bold text-surface transition hover:bg-brand-600"
            >
              Clear filters
            </button>
          </div>
        ) : (
          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {filtered.map((r, i) => (
              <Reveal key={r.name} delay={(i % 3) * 0.06}>
                <Link
                  to="/login"
                  className="group block overflow-hidden rounded-2xl border border-line bg-surface transition-all duration-500 hover:border-brand-500/20 hover:shadow-[0_20px_50px_-20px_rgba(16,20,18,0.25)]"
                >
                  <div className="relative h-44 overflow-hidden">
                    <img
                      src={r.image}
                      alt={r.name}
                      loading="lazy"
                      className="h-full w-full object-cover transition-transform duration-700 group-hover:scale-105"
                    />
                    <div className="absolute inset-0 bg-gradient-to-t from-ink-900/30 to-transparent" />
                    {r.promo && (
                      <span className="absolute top-3 left-3 rounded-full bg-brand-500 px-2.5 py-1 text-[10px] font-bold text-surface uppercase tracking-wide">
                        {r.promo}
                      </span>
                    )}
                    <span className="absolute bottom-3 left-3 rounded-full bg-surface px-2.5 py-1 shadow-sm">
                      <Rating value={r.rating} size="sm" className="gap-1" />
                    </span>
                  </div>
                  <div className="p-4">
                    <h3 className="text-sm font-bold text-ink-900">{r.name}</h3>
                    <p className="mt-1 text-xs text-ink-500">{r.cuisine}</p>
                    <div className="mt-3 flex items-center gap-3 text-xs text-ink-500">
                      <span className="flex items-center gap-1">
                        <Clock className="h-3 w-3 text-ink-300" aria-hidden />
                        {r.deliveryTime}
                      </span>
                      <span className="flex items-center gap-1 truncate">
                        <Truck className="h-3 w-3 text-ink-300" aria-hidden />
                        {r.deliveryFee}
                      </span>
                    </div>
                  </div>
                </Link>
              </Reveal>
            ))}
          </div>
        )}
      </section>

      {/* How ordering works */}
      <section className="border-y border-line bg-surface py-14 md:py-20">
        <div className="container-x">
          <SectionHeading eyebrow="How it works" title="Three steps to your door" center />
          <div className="relative mt-12 grid gap-10 md:grid-cols-3">
            <div className="pointer-events-none absolute top-10 left-[20%] right-[20%] hidden h-px bg-line md:block" />
            {STEPS.map((s) => (
              <Reveal key={s.n} className="relative text-center">
                <div className="mx-auto flex h-20 w-20 items-center justify-center rounded-full border-2 border-line bg-paper">
                  <span className="font-display text-xl font-bold text-brand-500">{s.n}</span>
                </div>
                <h3 className="mt-4 font-display text-lg font-bold text-ink-900">{s.t}</h3>
                <p className="mx-auto mt-2 max-w-xs text-sm leading-relaxed text-ink-500">{s.d}</p>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* App download */}
      <section className="container-x py-14 md:py-20">
        <Reveal>
          <div className="overflow-hidden rounded-3xl bg-ink-900">
            <div className="grid items-center gap-8 p-8 md:grid-cols-2 md:p-12">
              <div>
                <span className="inline-flex items-center gap-2 rounded-full bg-brand-500/20 px-3 py-1 text-xs font-semibold text-brand-50">
                  Get the HUDumika app
                </span>
                <h2 className="mt-4 font-display text-2xl font-bold text-surface">
                  Order even faster on mobile
                </h2>
                <p className="mt-2 max-w-sm text-sm leading-relaxed text-white/60">
                  Live rider tracking, exclusive app-only deals, and one-tap reordering with your
                  saved addresses.
                </p>
                <div className="mt-6 inline-flex rounded-full bg-white/10 px-5 py-3 text-xs font-semibold text-white/80 ring-1 ring-white/15">
                  App Store & Google Play links coming soon
                </div>
                <p className="mt-4 text-xs text-white/50">
                  Already a member?{' '}
                  <Link to="/login" className="font-semibold text-white transition hover:text-white/80">
                    Sign in →
                  </Link>
                </p>
              </div>
              <div className="hidden justify-center md:flex">
                <div className="rounded-[20px] bg-white/5 p-6 text-center ring-1 ring-white/10 backdrop-blur">
                  <div className="font-display text-2xl font-bold text-white">HUDumika</div>
                  <div className="mt-1 text-[10px] font-bold tracking-widest text-white/50">ORDER · BOOK · TRACK</div>
                  <div className="mx-auto mt-4 h-24 w-24 rounded-[16px] bg-white/10" aria-hidden />
                  <div className="mt-3 text-xs text-white/60">App preview · links coming soon</div>
                </div>
              </div>
            </div>
          </div>
        </Reveal>
      </section>
    </div>
  )
}
