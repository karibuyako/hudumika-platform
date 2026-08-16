import { useState } from 'react'
import { Link } from 'react-router-dom'
import {
  MapPin,
  ArrowRight,
  Star,
  Clock,
  ShieldCheck,
  BadgeCheck,
  Search,
  CreditCard,
  Truck,
  ArrowUpRight,
} from 'lucide-react'
import { motion } from 'framer-motion'
import { useCity } from '@/context/city'
import { useI18n } from '@/i18n'
import {
  SERVICE_GROUPS,
  HOME_SERVICES,
  AUDIENCES,
  RESTAURANTS,
  METRICS,
  IMG,
} from '@/data/constants'
import {
  Words,
  Typewriter,
  Reveal,
  Stagger,
  StaggerItem,
  SectionHeading,
  FloatingBadge,
} from '@/components/motion'
import { ButtonLink } from '@/components/Button'
import { Rating } from '@/components/Rating'
import { AppDownloadPanel, type AppInfo } from '@/components/AppDownloadPanel'
import { cn } from '@/utils/cn'
import { usePageMeta } from '@/hooks/usePageMeta'

/* ── Hero ──────────────────────────────────────────────────────── */
function Hero() {
  const { cityName, setCityOpen } = useCity()
  const { t } = useI18n()
  const [address, setAddress] = useState('')

  return (
    <section className="relative overflow-hidden bg-paper pt-28 pb-16 md:pt-36 md:pb-24">
      <div className="absolute inset-0 opacity-[0.035]">
        <div className="absolute inset-0 bg-[radial-gradient(70%_50%_at_50%_0%,var(--color-brand-500),transparent_65%)]" />
      </div>
      <div
        className="absolute inset-0 opacity-40 bg-grid"
        style={{ backgroundSize: '32px 32px' }}
        aria-hidden
      />

      <div className="container-x relative">
        <div className="grid items-center gap-12 lg:grid-cols-[1.05fr_0.95fr]">
          <div>
            <motion.button
              onClick={() => setCityOpen(true)}
              initial={{ opacity: 0, y: 14 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.6 }}
              className="inline-flex items-center gap-2 rounded-full border border-brand-500/20 bg-surface px-3.5 py-2 text-xs font-semibold text-ink-900 shadow-sm transition-colors hover:border-brand-500/40"
            >
              <span className="relative flex h-1.5 w-1.5">
                <span className="absolute inline-flex h-full w-full animate-pulse-ring rounded-full bg-brand-500" />
                <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-brand-500" />
              </span>
              Now serving {cityName}
            </motion.button>

            <h1 className="mt-6 font-display text-[clamp(2.2rem,5.2vw,3.7rem)] leading-[1.02] font-bold tracking-tight text-ink-900">
              <Words text={t('home.hero.headline')} delay={0.1} />
              <br />
              <span className="relative inline-block">
                <span className="relative z-10 bg-gradient-to-r from-brand-600 to-brand-500 bg-clip-text text-transparent">
                  <Words text={t('home.hero.headline2')} delay={0.28} />
                </span>
                <span className="absolute inset-x-0 bottom-1 h-3 -z-0 bg-brand-50" aria-hidden />
              </span>
            </h1>

            <motion.p
              initial={{ opacity: 0, y: 14 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.55, duration: 0.7 }}
              className="mt-5 max-w-lg text-base leading-relaxed text-ink-500 md:text-lg"
            >
              {t('home.hero.sub')}{' '}
              <span className="font-semibold text-ink-900">
                <Typewriter
                  phrases={[
                    t('home.hero.typePlumbers'),
                    t('home.hero.typeElectricians'),
                    t('home.hero.typeCleaners'),
                    t('home.hero.typeMore'),
                  ]}
                />
              </span>
            </motion.p>

            <motion.div
              initial={{ opacity: 0, y: 18 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.75, duration: 0.7 }}
              className="mt-8 flex max-w-lg flex-col gap-3 sm:flex-row"
            >
              <div className="flex flex-1 items-center gap-2 rounded-full border border-line bg-surface p-1.5 pl-4 shadow-sm transition-all focus-within:border-brand-500/40 focus-within:shadow-[0_0_0_3px_rgba(26,92,68,0.08)]">
                <MapPin className="h-4 w-4 shrink-0 text-brand-500" aria-hidden />
                <input
                  type="text"
                  value={address}
                  onChange={(e) => setAddress(e.target.value)}
                  placeholder={t('home.hero.addressPlaceholder')}
                  className="w-full bg-transparent text-sm text-ink-900 outline-none placeholder:text-ink-300"
                />
                <Link
                  to="/services"
                  className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-ink-900 text-surface transition-colors hover:bg-brand-600"
                  aria-label={t('home.hero.findServices')}
                >
                  <ArrowRight className="h-4 w-4" aria-hidden />
                </Link>
              </div>
              <ButtonLink to="/services" variant="secondary" className="sm:shrink-0">
                {t('home.hero.explore')}
              </ButtonLink>
            </motion.div>

            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: 0.95 }}
              className="mt-6 flex flex-wrap items-center gap-x-6 gap-y-2 text-xs text-ink-500"
            >
              {[t('home.hero.cities'), t('home.hero.freeDelivery'), t('home.hero.verified')].map((txt) => (
                <span key={txt} className="flex items-center gap-1.5 font-medium">
                  <span className="h-1 w-1 rounded-full bg-brand-500" aria-hidden />
                  {txt}
                </span>
              ))}
            </motion.div>
          </div>

          {/* Single strong visual + restrained status overlay */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.9, delay: 0.3 }}
            className="relative hidden lg:block"
          >
            <div className="overflow-hidden rounded-[28px] bg-surface shadow-[0_30px_80px_-30px_rgba(16,20,18,0.35)] ring-1 ring-line">
              <img
                src={IMG.heroHome}
                alt="A freshly delivered meal in Dar es Salaam"
                className="aspect-[4/4.6] w-full object-cover"
                loading="eager"
              />
              <div className="absolute inset-0 bg-gradient-to-t from-ink-900/60 via-transparent to-transparent" aria-hidden />
              <div className="absolute right-5 bottom-5 left-5 flex items-center justify-between rounded-[18px] bg-surface/95 p-4 backdrop-blur">
                <div>
                  <div className="text-sm font-bold text-ink-900">Green Bowl Kitchen</div>
                  <div className="mt-0.5 flex items-center gap-2 text-xs text-ink-500">
                    <Rating value={4.8} size="sm" />
                    <span>· 25 min</span>
                  </div>
                </div>
                <span className="rounded-full bg-brand-500 px-3 py-1.5 text-[11px] font-bold text-white">
                  On its way
                </span>
              </div>
            </div>

            <FloatingBadge className="absolute -left-5 top-8" amplitude={7}>
              <div className="flex items-center gap-2.5 rounded-2xl bg-surface px-4 py-3 shadow-lg ring-1 ring-line">
                <span className="grid h-9 w-9 place-items-center rounded-xl bg-brand-50 text-brand-600">
                  <ShieldCheck className="h-4 w-4" aria-hidden />
                </span>
                <div>
                  <div className="text-xs font-bold text-ink-900">Verified provider</div>
                  <div className="text-[11px] text-ink-500">Background-checked</div>
                </div>
              </div>
            </FloatingBadge>

            <FloatingBadge className="absolute -right-3 bottom-24" amplitude={9} duration={6} delay={0.8}>
              <div className="flex items-center gap-2 rounded-full bg-ink-900 py-2 pr-4 pl-2 text-white shadow-xl">
                <img src={IMG.riderAvatar} alt="" className="h-7 w-7 rounded-full object-cover" aria-hidden />
                <span className="text-xs font-bold">Rider · 12 min away</span>
              </div>
            </FloatingBadge>
          </motion.div>
        </div>
      </div>

      <div className="absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-paper to-transparent" aria-hidden />
    </section>
  )
}

/* ── Services bento ────────────────────────────────────────────── */
function ServicesBento() {
  const featured = SERVICE_GROUPS.filter((s) => ['food', 'home'].includes(s.id))
  const small = SERVICE_GROUPS.filter((s) => ['groceries', 'pharmacy', 'beauty', 'laundry', 'repairs', 'logistics'].includes(s.id))

  return (
    <section className="py-14 md:py-20">
      <div className="container-x">
        <SectionHeading
          eyebrow="Everything on HUDumika"
          title="What do you need today?"
          sub="Order it, or book someone to do it — one app for your whole day."
          action={
            <Link to="/services" className="inline-flex items-center gap-1.5 rounded-full bg-ink-900 px-5 py-2.5 text-sm font-bold text-white transition hover:bg-brand-600">
              All services <ArrowUpRight className="h-4 w-4" aria-hidden />
            </Link>
          }
        />

        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
          {featured.map((s, i) => (
            <Reveal key={s.id} delay={i * 0.06} className={cn('col-span-2', i === 0 ? 'md:row-span-2' : '')}>
              <Link
                to={`/services?category=${s.id}`}
                className="group relative block h-full overflow-hidden rounded-[24px] ring-1 ring-line"
              >
                <img
                  src={s.image}
                  alt={s.label}
                  loading={i === 0 ? 'eager' : 'lazy'}
                  className={cn(
                    'w-full object-cover transition-transform duration-700 group-hover:scale-[1.03]',
                    i === 0 ? 'aspect-[4/5] md:aspect-auto md:h-full md:min-h-[420px]' : 'aspect-[16/10]',
                  )}
                />
                <div className="absolute inset-0 bg-gradient-to-t from-ink-900/85 via-ink-900/15 to-transparent" aria-hidden />
                <div className="absolute bottom-0 left-0 right-0 p-6">
                  <span className="inline-flex rounded-full bg-surface px-3 py-1 text-[11px] font-bold text-ink-900">
                    {s.kind === 'order' ? 'Order' : 'Book'} · {s.tagline}
                  </span>
                  <h3 className="mt-2.5 font-display text-xl font-bold text-white md:text-2xl">{s.label}</h3>
                  <p className="mt-1 max-w-xs text-sm leading-relaxed text-white/75">{s.description}</p>
                  <span className="mt-4 inline-flex items-center gap-1.5 text-sm font-bold text-white">
                    {s.cta}
                    <ArrowRight className="h-4 w-4 transition-transform duration-300 group-hover:translate-x-1" aria-hidden />
                  </span>
                </div>
              </Link>
            </Reveal>
          ))}

          {small.map((s, i) => (
            <Reveal key={s.id} delay={0.1 + i * 0.05}>
              <Link
                to={`/services?category=${s.id}`}
                className="group relative block overflow-hidden rounded-[20px] ring-1 ring-line"
              >
                <img
                  src={s.image}
                  alt={s.label}
                  loading="lazy"
                  className="aspect-[16/10] w-full object-cover transition-transform duration-700 group-hover:scale-[1.03]"
                />
                <div className="absolute inset-0 bg-gradient-to-t from-ink-900/80 via-ink-900/10 to-transparent" aria-hidden />
                <div className="absolute bottom-0 left-0 right-0 p-4">
                  <h3 className="text-sm font-bold text-white">{s.label}</h3>
                  <span className="mt-1 inline-flex items-center gap-1 text-xs font-semibold text-white/80">
                    {s.cta} <ArrowRight className="h-3 w-3" aria-hidden />
                  </span>
                </div>
              </Link>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  )
}

/* ── Audience paths ────────────────────────────────────────────── */
function AudiencePaths() {
  return (
    <section className="border-y border-line bg-surface py-16 md:py-20">
      <div className="container-x">
        <SectionHeading
          eyebrow="Choose your path"
          title="One platform, four ways in"
          sub="Order and book, grow your business, offer services, or deliver."
          center
        />
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {AUDIENCES.map((a, i) => {
            const Icon = a.icon
            return (
              <motion.div
                key={a.id}
                initial={{ opacity: 0, y: 24 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true, margin: '-60px' }}
                transition={{ duration: 0.5, delay: i * 0.08, ease: [0.16, 1, 0.3, 1] }}
                className="group relative flex h-full flex-col overflow-hidden rounded-[20px] border border-line bg-paper p-6 transition-all duration-500 hover:border-brand-500/25 hover:shadow-[0_20px_50px_-20px_rgba(16,20,18,0.2)]"
              >
                <div className="flex items-center justify-between">
                  <span className="grid h-11 w-11 place-items-center rounded-[12px] bg-ink-900 text-white transition-colors group-hover:bg-brand-500">
                    <Icon className="h-5 w-5" aria-hidden />
                  </span>
                  <span className="rounded-full bg-brand-50 px-3 py-1 text-[11px] font-bold text-brand-600">
                    {a.offer}
                  </span>
                </div>
                <h3 className="mt-4 font-display text-lg font-bold text-ink-900">{a.title}</h3>
                <p className="mt-2 flex-1 text-sm leading-relaxed text-ink-500">{a.description}</p>
                <ButtonLink to={a.href} variant="dark" size="sm" className="mt-5 w-full">
                  {a.cta}
                  <ArrowRight className="h-3.5 w-3.5" aria-hidden />
                </ButtonLink>
              </motion.div>
            )
          })}
        </div>
      </div>
    </section>
  )
}

/* ── Home services spotlight ───────────────────────────────────── */
function HomeServicesSpotlight() {
  return (
    <section className="py-16 md:py-20">
      <div className="container-x">
        <SectionHeading
          eyebrow="Home Services"
          title="Trusted help, right at home"
          sub="Plumbers, electricians, cleaners and repair pros — verified, rated, and bookable in minutes."
          action={
            <Link to="/services?category=home" className="hidden text-sm font-semibold text-brand-600 transition-colors hover:text-brand-700 md:block">
              All home services →
            </Link>
          }
        />
        <div className="-mx-4 mt-10 flex gap-4 overflow-x-auto px-4 pb-4 no-scrollbar">
          {HOME_SERVICES.map((h, i) => (
            <Reveal key={h.id} delay={i * 0.05}>
              <Link
                to="/services?category=home"
                className="group block w-60 shrink-0 overflow-hidden rounded-[20px] border border-line bg-surface transition-all duration-500 hover:border-brand-500/25 hover:shadow-[0_20px_50px_-20px_rgba(16,20,18,0.2)]"
              >
                <div className="relative h-32 overflow-hidden">
                  <img
                    src={h.image}
                    alt={h.label}
                    loading="lazy"
                    className="h-full w-full object-cover transition-transform duration-700 group-hover:scale-105"
                  />
                  <span className="absolute top-3 left-3 inline-flex items-center gap-1 rounded-full bg-surface px-2.5 py-1 text-[10px] font-bold text-ink-900 shadow-sm">
                    <BadgeCheck className="h-3 w-3 text-brand-500" aria-hidden />
                    {h.available}
                  </span>
                </div>
                <div className="p-4">
                  <div className="flex items-center justify-between">
                    <h3 className="text-sm font-bold text-ink-900">{h.label}</h3>
                    <Rating value={h.rating} size="sm" className="gap-1" />
                  </div>
                  <p className="mt-1 text-xs text-ink-500">{h.description}</p>
                  <div className="mt-3 flex items-center justify-between border-t border-line pt-3">
                    <span className="text-sm font-bold text-ink-900">{h.price}</span>
                    <span className="text-xs font-semibold text-brand-600">Book now →</span>
                  </div>
                </div>
              </Link>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  )
}

/* ── Trust / metrics ───────────────────────────────────────────── */
function TrustSection() {
  return (
    <section className="border-y border-line bg-surface py-16 md:py-20">
      <div className="container-x">
        <div className="grid gap-10 lg:grid-cols-12">
          <Reveal className="lg:col-span-4">
            <span className="text-xs font-semibold tracking-widest text-brand-500 uppercase">
              By the numbers
            </span>
            <h2 className="mt-3 font-display text-xl font-bold leading-snug text-ink-900 md:text-2xl">
              Trusted across the city
            </h2>
            <p className="mt-3 text-sm leading-relaxed text-ink-500">
              Real numbers from real orders and bookings across Tanzania.
            </p>
          </Reveal>
          <Stagger className="grid grid-cols-2 gap-8 lg:col-span-8 lg:grid-cols-4" gap={0.1}>
            {METRICS.map((m) => (
              <StaggerItem key={m.label}>
                <div>
                  <div className="font-display text-3xl font-bold tracking-tight text-ink-900 md:text-4xl">
                    {m.value}
                  </div>
                  <div className="mt-2 text-xs leading-snug text-ink-500">{m.label}</div>
                </div>
              </StaggerItem>
            ))}
          </Stagger>
        </div>

        <div className="mt-12 grid gap-4 md:grid-cols-3">
          {[
            { icon: Search, t: 'Find it', d: 'Browse 2,000+ restaurants, shops and verified service providers near you.' },
            { icon: CreditCard, t: 'Book it', d: 'Pay safely with M-Pesa, card, or cash — always transparent pricing.' },
            { icon: Truck, t: 'Get it done', d: 'Track deliveries live and confirm completed jobs before payment release.' },
          ].map((s, i) => {
            const Icon = s.icon
            return (
              <Reveal key={s.t} delay={i * 0.07}>
                <div className="flex h-full items-start gap-4 rounded-[20px] bg-paper p-6 ring-1 ring-line">
                  <span className="grid h-11 w-11 shrink-0 place-items-center rounded-[12px] bg-ink-900 text-white">
                    <Icon className="h-5 w-5" aria-hidden />
                  </span>
                  <div>
                    <h3 className="text-sm font-bold text-ink-900">{s.t}</h3>
                    <p className="mt-1 text-sm leading-relaxed text-ink-500">{s.d}</p>
                  </div>
                </div>
              </Reveal>
            )
          })}
        </div>
      </div>
    </section>
  )
}

/* ── Restaurants strip ─────────────────────────────────────────── */
function RestaurantsStrip() {
  return (
    <section className="py-16 md:py-20">
      <div className="container-x">
        <SectionHeading
          eyebrow="Popular near you"
          title="Favourite restaurants"
          action={
            <Link to="/consumer" className="hidden text-sm font-semibold text-brand-600 transition-colors hover:text-brand-700 md:block">
              View all →
            </Link>
          }
        />
        <div className="-mx-4 mt-10 flex gap-4 overflow-x-auto px-4 pb-4 no-scrollbar">
          {RESTAURANTS.slice(0, 6).map((r, i) => (
            <Reveal key={r.name} delay={i * 0.08}>
              <Link
                to="/consumer"
                className="group block w-64 shrink-0 overflow-hidden rounded-[20px] border border-line bg-surface transition-all duration-500 hover:border-brand-500/25 hover:shadow-[0_20px_50px_-20px_rgba(16,20,18,0.2)]"
              >
                <div className="relative h-40 overflow-hidden">
                  <img
                    src={r.image}
                    alt={r.name}
                    loading="lazy"
                    className="h-full w-full object-cover transition-transform duration-700 group-hover:scale-105"
                  />
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
      </div>
    </section>
  )
}

/* ── Testimonials ──────────────────────────────────────────────── */
function Testimonials() {
  const TESTIMONIALS = [
    { quote: 'Booked a plumber through the app at 9am — fixed by lunch. Prices shown upfront, no surprises.', name: 'Neema K.', role: 'Customer, Dar es Salaam', rating: 5 },
    { quote: 'Orders are up 40% since we joined. The dashboard makes the whole menu easy to manage.', name: 'Grace Mwangi', role: 'Owner, Green Bowl Kitchen', rating: 5 },
    { quote: 'I deliver part-time and the flexibility is perfect. Payments are always on time.', name: 'David O.', role: 'Rider, Dar es Salaam', rating: 5 },
  ]
  return (
    <section className="border-y border-line bg-surface py-16 md:py-20">
      <div className="container-x">
        <SectionHeading
          eyebrow="What people say"
          title="Loved by customers, pros, and partners"
          center
        />
        <Stagger className="mt-12 grid gap-5 md:grid-cols-3" gap={0.1}>
          {TESTIMONIALS.map((t) => (
            <StaggerItem key={t.name}>
              <div className="flex h-full flex-col rounded-[20px] border border-line bg-paper p-7 transition-all duration-300 hover:shadow-[0_20px_50px_-20px_rgba(16,20,18,0.15)]">
                <div className="flex gap-0.5" aria-hidden>
                  {Array.from({ length: t.rating }).map((_, i) => (
                    <Star key={i} className="h-4 w-4 fill-brand-500 text-brand-500" />
                  ))}
                </div>
                <p className="mt-4 flex-1 text-sm leading-relaxed text-ink-700">"{t.quote}"</p>
                <div className="mt-6">
                  <div className="text-sm font-semibold text-ink-900">{t.name}</div>
                  <div className="text-xs text-ink-500">{t.role}</div>
                </div>
              </div>
            </StaggerItem>
          ))}
        </Stagger>
      </div>
    </section>
  )
}

/* ── Page ──────────────────────────────────────────────────────── */
export default function HomePage() {
  usePageMeta('/')

  const APPS: AppInfo[] = [
    { id: 'customer', name: 'HUDumika', audience: 'Order & book', description: 'Food, groceries, pharmacy and home services in one app.', accent: 'bg-brand-500' },
    { id: 'merchant', name: 'HUDumika Merchant', audience: 'For businesses', description: 'Orders, menu, insights and payouts from your pocket.', accent: 'bg-amber-500' },
    { id: 'provider', name: 'HUDumika Provider', audience: 'For professionals', description: 'Accept bookings, manage your calendar and get paid weekly.', accent: 'bg-blue-500' },
    { id: 'rider', name: 'HUDumika Rider', audience: 'For delivery partners', description: 'Find orders near you, track earnings and cash out daily.', accent: 'bg-emerald-500' },
  ]

  return (
    <>
      <Hero />
      <ServicesBento />
      <AudiencePaths />
      <HomeServicesSpotlight />
      <TrustSection />
      <RestaurantsStrip />
      <Testimonials />
      <section className="py-16 md:py-20">
        <div className="container-x">
          <AppDownloadPanel apps={APPS} />
        </div>
      </section>
    </>
  )
}
