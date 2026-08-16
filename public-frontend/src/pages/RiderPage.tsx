import { useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowLeft, Check, ShieldCheck, Zap, HeartHandshake, Trophy } from 'lucide-react'
import { motion } from 'framer-motion'
import { RIDER_TRACKS, RIDER_STORIES, formatTZS, IMG } from '@/data/constants'
import { usePageMeta } from '@/hooks/usePageMeta'
import { Reveal, Tilt3DCard, SectionHeading } from '@/components/motion'
import { RiderSignupForm } from '@/components/forms/RiderSignupForm'
import { Accordion } from '@/components/Accordion'
import { cn } from '@/utils/cn'

const BENEFITS = [
  { icon: ShieldCheck, t: 'Insurance & safety', d: 'Covered from day one — insurance and safety training included.' },
  { icon: Zap, t: 'Fast payouts', d: 'Get paid daily to M-Pesa. No waiting weeks for your earnings.' },
  { icon: HeartHandshake, t: 'Support when you need it', d: '24/7 rider hotline and community group help you succeed.' },
  { icon: Trophy, t: 'Grow with us', d: 'Top riders get bonuses, priority orders, and more.' },
]

const FAQ = [
  { q: 'What are the requirements to become a rider?', a: 'You must be 18+, hold a valid ID, and have a smartphone plus a vehicle (boda, bicycle, or car). No experience needed — we train you.' },
  { q: 'How do earnings and payouts work?', a: 'You earn per delivery at a transparent rate that varies by city and distance. Bonuses reward consistency. Payouts go to M-Pesa daily.' },
  { q: 'Am I covered by insurance?', a: 'Yes — every rider has insurance from the moment they start, plus free safety training and a starter kit including a hot bag and helmet.' },
  { q: 'Can I ride part-time?', a: 'Absolutely. Flex riders dash whenever they want — evenings, weekends, or peak hours. There are no fixed shifts.' },
]

export default function RiderPage() {
  usePageMeta('/rider')
  const [city, setCity] = useState('Dar es Salaam')
  const [orders, setOrders] = useState(18)

  const rate = city === 'Dar es Salaam' ? 2800 : city === 'Arusha' ? 2500 : 2200
  const bonus = orders > 20 ? 15000 : orders > 15 ? 8000 : 0
  const daily = orders * rate + bonus
  const weekly = daily * 6
  const monthly = daily * 26

  return (
    <div className="pt-24">
      {/* Hero — dark band */}
      <section className="relative overflow-hidden bg-ink-900">
        <img src={IMG.heroRider} alt="" aria-hidden className="absolute inset-0 h-full w-full object-cover opacity-50" fetchPriority="high" />
        <div className="absolute inset-0 bg-gradient-to-r from-ink-900 via-ink-900/85 to-emerald-900/40" aria-hidden />
        <div className="absolute inset-0 bg-gradient-to-t from-ink-900 via-transparent to-transparent" aria-hidden />
        <div className="container-x relative grid gap-10 py-14 lg:grid-cols-2 lg:py-20">
          <div>
            <Link to="/" className="mb-8 inline-flex items-center gap-2 text-sm font-medium text-white/60 transition-colors hover:text-white">
              <ArrowLeft className="h-4 w-4" aria-hidden />
              Back to home
            </Link>
            <motion.p
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              className="mb-3 inline-flex items-center gap-2 rounded-full bg-surface px-4 py-1.5 text-xs font-bold text-ink-900 ring-1 ring-line"
            >
              <span className="h-2 w-2 rounded-full bg-ink-900" aria-hidden /> Deliver with HUDumika
            </motion.p>
            <motion.h1
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.05 }}
              className="font-display text-4xl leading-[0.95] font-bold text-white sm:text-5xl"
            >
              Earn on <span className="text-emerald-400">your schedule</span>
            </motion.h1>
            <motion.p
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.1 }}
              className="mt-4 max-w-xl text-white/75"
            >
              Choose your hours, track your earnings, and get paid fast. All you need is a bike or
              scooter and a smartphone.
            </motion.p>
            <motion.div
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.16 }}
              className="mt-7 flex flex-wrap gap-3"
            >
              <a href="#apply" className="rounded-full bg-surface px-7 py-3.5 text-sm font-bold text-ink-900 ring-1 ring-line transition hover:bg-white">
                Apply now
              </a>
              <a href="#calculator" className="rounded-full bg-white/10 px-7 py-3.5 text-sm font-bold text-white ring-1 ring-white/20 backdrop-blur transition hover:bg-white hover:text-ink-900">
                Calculate earnings
              </a>
            </motion.div>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: 0.3 }}
              className="mt-8 grid grid-cols-3 gap-4"
            >
              {[
                { k: 'TZS 45k', v: 'Max / day' },
                { k: 'Daily', v: 'M-Pesa payout' },
                { k: '4.8', v: 'Rider rating' },
              ].map((s) => (
                <div key={s.v} className="rounded-[16px] bg-white/10 p-4 ring-1 ring-white/10 backdrop-blur">
                  <div className="text-lg font-black text-white">{s.k}</div>
                  <div className="text-xs text-white/60">{s.v}</div>
                </div>
              ))}
            </motion.div>
          </div>

          <Tilt3DCard className="hidden lg:block">
            <div className="relative overflow-hidden rounded-[28px] bg-white p-3 shadow-2xl">
              <img src={IMG.riderPortrait} alt="Rider delivering with a motorcycle" loading="lazy" className="aspect-[4/3] w-full rounded-[20px] object-cover" />
              <div className="absolute right-5 bottom-5 left-5 rounded-[18px] bg-white p-4 shadow-xl">
                <div className="flex items-center gap-3">
                  <img src={IMG.riderAvatar} alt="Juma" className="h-10 w-10 rounded-full object-cover" />
                  <div>
                    <div className="text-sm font-bold text-ink-900">Juma · Boda Rider · Dar</div>
                    <div className="text-xs text-ink-500">1,428 deliveries · 4.9 rating</div>
                  </div>
                  <span className="ml-auto rounded-full bg-emerald-500 px-3 py-1 text-xs font-bold text-white">Online</span>
                </div>
                <div className="mt-3 grid grid-cols-3 gap-2 text-center">
                  <div className="rounded-xl bg-paper p-2">
                    <div className="text-sm font-black text-ink-900">TZS 38k</div>
                    <div className="text-[10px] text-ink-500">Today</div>
                  </div>
                  <div className="rounded-xl bg-paper p-2">
                    <div className="text-sm font-black text-ink-900">18</div>
                    <div className="text-[10px] text-ink-500">Orders</div>
                  </div>
                  <div className="rounded-xl bg-paper p-2">
                    <div className="text-sm font-black text-emerald-600">100%</div>
                    <div className="text-[10px] text-ink-500">On time</div>
                  </div>
                </div>
              </div>
            </div>
          </Tilt3DCard>
        </div>
      </section>

      {/* Two tracks */}
      <section className="container-x py-14 md:py-20">
        <SectionHeading
          eyebrow="Two ways to ride"
          title="Choose your style"
          sub="Stable income with a dedicated area, or complete freedom — you pick."
        />
        <div className="grid gap-5 md:grid-cols-2">
          {RIDER_TRACKS.map((t, i) => (
            <Reveal key={t.id} delay={i * 0.08}>
              <div
                className={cn(
                  'relative flex h-full flex-col overflow-hidden rounded-[24px] p-8',
                  t.highlight
                    ? 'bg-ink-900 text-white shadow-[0_30px_80px_-30px_rgba(16,20,18,0.5)]'
                    : 'bg-surface ring-1 ring-line',
                )}
              >
                {t.highlight && (
                  <span className="absolute top-5 right-5 rounded-full bg-brand-500 px-3 py-1 text-[10px] font-bold text-white">
                    Most popular
                  </span>
                )}
                <h3 className={cn('font-display text-xl font-bold', t.highlight ? 'text-white' : 'text-ink-900')}>{t.name}</h3>
                <p className={cn('mt-1 text-sm', t.highlight ? 'text-white/60' : 'text-ink-500')}>{t.tagline}</p>
                <ul className="mt-6 flex-1 space-y-3">
                  {t.features.map((f) => (
                    <li key={f} className="flex items-start gap-2.5 text-sm">
                      <Check className={cn('mt-0.5 h-4 w-4 shrink-0', t.highlight ? 'text-emerald-400' : 'text-brand-500')} aria-hidden />
                      <span className={t.highlight ? 'text-white/85' : 'text-ink-700'}>{f}</span>
                    </li>
                  ))}
                </ul>
                <a
                  href="#apply"
                  className={cn(
                    'mt-7 rounded-full py-3 text-center text-sm font-bold transition',
                    t.highlight ? 'bg-surface text-ink-900 hover:bg-white' : 'bg-ink-900 text-white hover:bg-brand-600',
                  )}
                >
                  {t.cta}
                </a>
              </div>
            </Reveal>
          ))}
        </div>
      </section>

      {/* Earnings estimator */}
      <section id="calculator" className="container-x pb-14">
        <Reveal>
          <div className="overflow-hidden rounded-[28px] bg-ink-900 p-6 sm:p-10">
            <div className="grid gap-10 lg:grid-cols-2">
              <div>
                <p className="text-xs font-bold uppercase tracking-[0.16em] text-white/60">Earnings Calculator</p>
                <h2 className="mt-2 font-display text-3xl font-bold text-white">How much can you earn?</h2>
                <p className="mt-3 text-sm text-white/60">
                  Illustrative estimate — rates vary by city, with bonuses for high performers.
                </p>

                <div className="mt-8 space-y-6">
                  <div>
                    <label className="text-sm font-bold text-white">City</label>
                    <div className="mt-2 flex flex-wrap gap-2">
                      {['Dar es Salaam', 'Arusha', 'Mwanza', 'Dodoma', 'Zanzibar'].map((c) => (
                        <button
                          key={c}
                          onClick={() => setCity(c)}
                          className={cn(
                            'rounded-full px-4 py-2 text-sm font-bold ring-1 transition',
                            city === c ? 'bg-white text-ink-900 ring-white' : 'bg-white/10 text-white ring-white/20 hover:bg-white/15',
                          )}
                        >
                          {c}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div>
                    <div className="flex items-center justify-between">
                      <label htmlFor="rideOrders" className="text-sm font-bold text-white">Orders per day</label>
                      <span className="rounded-full bg-white px-3 py-1 text-sm font-black text-ink-900">{orders} orders</span>
                    </div>
                    <input
                      id="rideOrders"
                      type="range"
                      min={5}
                      max={35}
                      value={orders}
                      onChange={(e) => setOrders(parseInt(e.target.value))}
                      className="mt-3 w-full accent-white"
                    />
                    <div className="flex justify-between text-xs text-white/40">
                      <span>5</span>
                      <span>35</span>
                    </div>
                  </div>
                </div>
              </div>

              <div className="grid gap-4">
                <div className="rounded-[20px] bg-white p-6">
                  <div className="text-sm font-bold text-ink-500">Estimated Earnings · Daily</div>
                  <div className="mt-2 flex items-baseline gap-2">
                    <span className="font-display text-4xl font-black text-ink-900">{formatTZS(daily)}</span>
                    <span className="text-sm font-bold text-emerald-600">/ day</span>
                  </div>
                  <div className="mt-1 text-xs text-ink-500">
                    {formatTZS(rate)} per order
                    {bonus ? ` + ${formatTZS(bonus)} bonus` : ''} · {city}
                  </div>

                  <div className="mt-6 grid grid-cols-2 gap-3">
                    <div className="rounded-[16px] bg-paper p-4 ring-1 ring-line">
                      <div className="text-xs font-bold text-ink-500">Per Week</div>
                      <div className="text-xl font-black text-ink-900">{formatTZS(weekly)}</div>
                    </div>
                    <div className="rounded-[16px] bg-paper p-4 ring-1 ring-line">
                      <div className="text-xs font-bold text-ink-500">Per Month</div>
                      <div className="text-xl font-black text-ink-900">{formatTZS(monthly)}</div>
                    </div>
                  </div>

                  <a href="#apply" className="mt-6 flex w-full items-center justify-center rounded-full bg-brand-500 py-3.5 text-sm font-black text-white shadow-lg shadow-brand-500/20 transition hover:brightness-105">
                    Start Earning Now →
                  </a>
                  <p className="mt-2 text-center text-xs text-ink-500">
                    Illustrative estimate · Payout daily via M-Pesa
                  </p>
                </div>

                <div className="grid grid-cols-3 gap-3 text-center text-white">
                  {[
                    { k: '18-25', v: 'Avg orders / day' },
                    { k: '24/7', v: 'Support' },
                    { k: '100%', v: 'Insurance' },
                  ].map((s) => (
                    <div key={s.v} className="rounded-[16px] bg-white/10 p-3 ring-1 ring-white/10 backdrop-blur">
                      <div className="text-lg font-black">{s.k}</div>
                      <div className="text-xs text-white/60">{s.v}</div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </Reveal>
      </section>

      {/* Benefits */}
      <section className="container-x py-14">
        <SectionHeading eyebrow="Benefits" title="We've got your back" />
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          {BENEFITS.map((b, i) => {
            const Icon = b.icon
            return (
              <motion.div
                key={b.t}
                initial={{ opacity: 0, y: 16 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ delay: i * 0.07 }}
                className="group h-full rounded-[20px] bg-surface p-6 ring-1 ring-line transition-all duration-300 hover:-translate-y-1 hover:shadow-[0_20px_50px_-20px_rgba(16,20,18,0.15)]"
              >
                <span className="mb-3 grid h-11 w-11 place-items-center rounded-[12px] bg-brand-50 text-brand-600 transition-colors group-hover:bg-brand-500 group-hover:text-white">
                  <Icon className="h-5 w-5" aria-hidden />
                </span>
                <h3 className="font-bold text-ink-900">{b.t}</h3>
                <p className="mt-1 text-sm leading-relaxed text-ink-500">{b.d}</p>
              </motion.div>
            )
          })}
        </div>
      </section>

      {/* Stories */}
      <section className="border-y border-line bg-surface py-14 md:py-20">
        <div className="container-x">
          <SectionHeading eyebrow="Rider stories" title="Real riders, real earnings" />
          <div className="grid gap-5 md:grid-cols-3">
            {RIDER_STORIES.map((s, i) => (
              <Reveal key={s.name} delay={i * 0.08}>
                <div className="flex h-full flex-col rounded-[20px] border border-line bg-paper p-7">
                  <div className="flex items-center gap-3">
                    <span className="grid h-11 w-11 place-items-center rounded-full bg-ink-900 font-display text-sm font-bold text-white">
                      {s.name.split(' ').map((n) => n[0]).join('')}
                    </span>
                    <div>
                      <div className="text-sm font-bold text-ink-900">{s.name}</div>
                      <div className="text-xs text-ink-500">{s.role}</div>
                    </div>
                  </div>
                  <p className="mt-4 flex-1 text-sm leading-relaxed text-ink-700">"{s.quote}"</p>
                  <div className="mt-5 flex items-center justify-between border-t border-line pt-4 text-xs">
                    <span className="font-bold text-ink-900">{s.rating.toFixed(1)} rating</span>
                    <span className="text-ink-500">{s.orders}</span>
                  </div>
                </div>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* Signup */}
      <section id="apply" className="container-x py-14 md:py-20">
        <div className="grid gap-8 lg:grid-cols-2">
          <Reveal>
            <h2 className="font-display text-3xl font-bold text-ink-900">Ready to start?</h2>
            <p className="mt-3 max-w-md text-sm leading-relaxed text-ink-500">
              Requirements are simple: you're 18+, you have a smartphone, and you have a vehicle
              (boda, bicycle, or car). No experience needed — we train you.
            </p>
            <ul className="mt-6 space-y-3">
              {[
                '18+ years old with a valid ID',
                'Smartphone (Android or iOS)',
                'A bike, scooter, or car — or on foot for flex',
                'Free safety training & starter kit',
              ].map((item) => (
                <li key={item} className="flex items-center gap-3 rounded-[16px] bg-surface p-4 ring-1 ring-line">
                  <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-emerald-500 text-white">
                    <Check className="h-4 w-4" aria-hidden />
                  </span>
                  <span className="text-sm font-medium text-ink-900">{item}</span>
                </li>
              ))}
            </ul>
            <div className="mt-8 rounded-[20px] bg-ink-900 p-6 text-white">
              <div className="text-xs font-bold tracking-widest text-white/60 uppercase">Rider app</div>
              <p className="mt-2 text-sm text-white/70">Dash now, track earnings and cash out daily.</p>
              <span className="mt-3 inline-block rounded-full bg-white/10 px-4 py-2 text-xs font-semibold text-white ring-1 ring-white/15">
                Store links coming soon
              </span>
              <Link to="/login" className="mt-4 block text-xs font-semibold text-white/60 underline transition hover:text-white">
                Already a rider? Rider login →
              </Link>
            </div>
          </Reveal>
          <Reveal delay={0.08}>
            <RiderSignupForm />
          </Reveal>
        </div>
      </section>

      {/* FAQ */}
      <section className="border-y border-line bg-surface py-14">
        <div className="container-x grid gap-10 lg:grid-cols-2">
          <SectionHeading eyebrow="Questions" title="Rider FAQ" />
          <Accordion items={FAQ} defaultOpen={null} />
        </div>
      </section>
    </div>
  )
}
