import { useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { ArrowLeft, MapPin, Search, BadgeCheck, Clock } from 'lucide-react'
import { motion } from 'framer-motion'
import { SERVICE_GROUPS, SERVICE_ICONS, HOME_SERVICES, RESTAURANTS } from '@/data/constants'
import { useCity } from '@/context/city'
import { usePageMeta } from '@/hooks/usePageMeta'
import { Reveal, SectionHeading } from '@/components/motion'
import { Rating } from '@/components/Rating'
import { cn } from '@/utils/cn'

export default function ServicesPage() {
  usePageMeta('/services')
  const { cityName } = useCity()
  const [params, setParams] = useSearchParams()
  const active = params.get('category') ?? 'all'
  const [query, setQuery] = useState('')

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase()
    return SERVICE_GROUPS.filter((g) => {
      const matchQ = !q || g.label.toLowerCase().includes(q) || g.description.toLowerCase().includes(q)
      const matchC = active === 'all' || g.id === active
      return matchQ && matchC
    })
  }, [active, query])

  const homeServices = active === 'all' || active === 'home'
  const restaurants = active === 'all' || active === 'food' || active === 'groceries' || active === 'pharmacy'

  const setCat = (id: string) => {
    if (id === 'all') setParams({})
    else setParams({ category: id })
  }

  const cats = [
    { id: 'all', label: 'All services' },
    ...SERVICE_GROUPS.map((g) => ({ id: g.id, label: g.label })),
  ]

  return (
    <div className="pt-24">
      <section className="relative overflow-hidden bg-paper pt-10 pb-12 md:pt-14">
        <div className="absolute inset-0 opacity-[0.035]">
          <div className="absolute inset-0 bg-[radial-gradient(70%_50%_at_50%_0%,var(--color-brand-500),transparent_65%)]" />
        </div>
        <div className="container-x relative">
          <Link to="/" className="mb-8 inline-flex items-center gap-2 text-sm font-medium text-ink-500 transition-colors hover:text-ink-900">
            <ArrowLeft className="h-4 w-4" aria-hidden />
            Back to home
          </Link>
          <div className="max-w-2xl">
            <motion.span
              initial={{ opacity: 0, y: 14 }}
              animate={{ opacity: 1, y: 0 }}
              className="inline-flex items-center gap-2 rounded-full border border-brand-500/20 bg-surface px-3.5 py-2 text-xs font-semibold text-ink-900 shadow-sm"
            >
              <MapPin className="h-3 w-3 text-brand-500" aria-hidden />
              All services in {cityName}
            </motion.span>
            <motion.h1
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.08 }}
              className="mt-5 font-display text-3xl font-bold tracking-tight text-ink-900 md:text-4xl"
            >
              Order it, or <span className="bg-gradient-to-r from-brand-600 to-brand-500 bg-clip-text text-transparent">book someone</span> to do it
            </motion.h1>
            <motion.p
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.16 }}
              className="mt-3 text-sm leading-relaxed text-ink-500 md:text-base"
            >
              Food, groceries, home services, beauty, repairs and more — everything your day
              needs, from verified local partners.
            </motion.p>
            <motion.div
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.24 }}
              className="mt-7 flex max-w-md items-center gap-2 rounded-full border border-line bg-surface p-1.5 pl-4 shadow-sm transition-all focus-within:border-brand-500/40"
            >
              <Search className="h-4 w-4 shrink-0 text-brand-500" aria-hidden />
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search services or descriptions…"
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
              key={c.id}
              onClick={() => setCat(c.id)}
              className={cn(
                'whitespace-nowrap rounded-full px-4 py-2 text-xs font-bold ring-1 transition',
                active === c.id ? 'bg-ink-900 text-white ring-ink-900' : 'bg-surface text-ink-700 ring-line hover:bg-paper',
              )}
            >
              {c.label}
            </button>
          ))}
        </div>
      </section>

      {/* Service groups */}
      <section className="container-x py-12 md:py-16">
        <SectionHeading
          eyebrow="Browse"
          title={groups.length ? `${groups.length} service group${groups.length > 1 ? 's' : ''}` : 'No matches'}
          sub={query || active !== 'all' ? 'Showing results for your selection.' : 'Everything is delivered or booked through verified local partners.'}
        />
        {groups.length === 0 ? (
          <div className="rounded-[20px] border border-dashed border-line bg-surface p-10 text-center">
            <p className="text-sm font-semibold text-ink-900">Nothing matched your search.</p>
            <p className="mt-1 text-xs text-ink-500">Try a different name or clear the filters.</p>
            <button
              onClick={() => {
                setQuery('')
                setCat('all')
              }}
              className="mt-4 rounded-full bg-ink-900 px-5 py-2.5 text-xs font-bold text-white transition hover:bg-brand-600"
            >
              Clear filters
            </button>
          </div>
        ) : (
          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {groups.map((g, i) => {
              const Icon = SERVICE_ICONS[g.id]
              return (
                <Reveal key={g.id} delay={(i % 3) * 0.06}>
                  <Link
                    to={`/services?category=${g.id}`}
                    className="group block overflow-hidden rounded-[20px] border border-line bg-surface transition-all duration-500 hover:border-brand-500/25 hover:shadow-[0_20px_50px_-20px_rgba(16,20,18,0.2)]"
                  >
                    <div className="relative h-40 overflow-hidden">
                      <img
                        src={g.image}
                        alt={g.label}
                        loading="lazy"
                        className="h-full w-full object-cover transition-transform duration-700 group-hover:scale-105"
                      />
                      <div className="absolute inset-0 bg-gradient-to-t from-ink-900/40 to-transparent" aria-hidden />
                      <span className="absolute bottom-3 left-3 inline-flex items-center gap-1.5 rounded-full bg-surface px-3 py-1.5 text-xs font-bold text-ink-900 shadow-sm">
                        <Icon className="h-3.5 w-3.5 text-brand-500" aria-hidden />
                        {g.kind === 'order' ? 'Order' : 'Book'} · {g.tagline}
                      </span>
                    </div>
                    <div className="p-4">
                      <h3 className="text-sm font-bold text-ink-900">{g.label}</h3>
                      <p className="mt-1 text-xs leading-relaxed text-ink-500">{g.description}</p>
                      <span className="mt-3 inline-flex items-center gap-1 text-xs font-bold text-brand-600">
                        {g.cta} <span aria-hidden>→</span>
                      </span>
                    </div>
                  </Link>
                </Reveal>
              )
            })}
          </div>
        )}
      </section>

      {/* Home services detail */}
      {homeServices && (
        <section className="border-y border-line bg-surface py-14 md:py-16">
          <div className="container-x">
            <SectionHeading
              eyebrow="Book a pro"
              title="Home services near you"
              sub="Verified providers with transparent pricing — payment releases after you confirm the job."
            />
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {HOME_SERVICES.map((h, i) => (
                <Reveal key={h.id} delay={(i % 4) * 0.05}>
                  <div className="group h-full overflow-hidden rounded-[20px] border border-line bg-paper transition-all duration-300 hover:shadow-[0_20px_50px_-20px_rgba(16,20,18,0.15)]">
                    <div className="relative h-28 overflow-hidden">
                      <img src={h.image} alt={h.label} loading="lazy" className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-[1.04]" />
                      <span className="absolute top-2.5 left-2.5 inline-flex items-center gap-1 rounded-full bg-surface px-2 py-1 text-[10px] font-bold text-ink-900 shadow-sm">
                        <BadgeCheck className="h-3 w-3 text-brand-500" aria-hidden />
                        {h.available}
                      </span>
                    </div>
                    <div className="p-4">
                      <div className="flex items-center justify-between">
                        <h3 className="text-sm font-bold text-ink-900">{h.label}</h3>
                        <Rating value={h.rating} size="sm" className="gap-1" />
                      </div>
                      <p className="mt-1 text-[11px] text-ink-500">{h.description}</p>
                      <div className="mt-3 flex items-center justify-between border-t border-line pt-3">
                        <span className="text-xs font-bold text-ink-900">{h.price}</span>
                        <span className="flex items-center gap-1 text-xs font-semibold text-brand-600">
                          <Clock className="h-3 w-3" aria-hidden />
                          Book
                        </span>
                      </div>
                    </div>
                  </div>
                </Reveal>
              ))}
            </div>
          </div>
        </section>
      )}

      {/* Order detail */}
      {restaurants && (
        <section className="container-x py-14 md:py-16">
          <SectionHeading
            eyebrow="Popular near you"
            title="Restaurants & shops"
            action={
              <Link to="/consumer" className="hidden text-sm font-semibold text-brand-600 transition-colors hover:text-brand-700 md:block">
                View all →
              </Link>
            }
          />
          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {RESTAURANTS.slice(0, 6).map((r, i) => (
              <Reveal key={r.name} delay={(i % 3) * 0.06}>
                <Link to="/consumer" className="group block overflow-hidden rounded-[20px] border border-line bg-surface transition-all duration-500 hover:border-brand-500/25 hover:shadow-[0_20px_50px_-20px_rgba(16,20,18,0.2)]">
                  <div className="relative h-40 overflow-hidden">
                    <img src={r.image} alt={r.name} loading="lazy" className="h-full w-full object-cover transition-transform duration-700 group-hover:scale-105" />
                    {r.promo && (
                      <span className="absolute top-3 left-3 rounded-full bg-brand-500 px-2.5 py-1 text-[10px] font-bold text-white uppercase tracking-wide">
                        {r.promo}
                      </span>
                    )}
                  </div>
                  <div className="p-4">
                    <h3 className="text-sm font-bold text-ink-900">{r.name}</h3>
                    <p className="mt-1 text-xs text-ink-500">{r.cuisine}</p>
                    <div className="mt-3 flex items-center gap-3 text-xs text-ink-500">
                      <Rating value={r.rating} size="sm" className="gap-1" />
                      <span className="flex items-center gap-1">
                        <Clock className="h-3 w-3 text-ink-300" aria-hidden />
                        {r.deliveryTime}
                      </span>
                    </div>
                  </div>
                </Link>
              </Reveal>
            ))}
          </div>
        </section>
      )}
    </div>
  )
}
