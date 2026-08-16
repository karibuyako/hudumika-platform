import { Link } from 'react-router-dom'
import { ArrowLeft, Check, LayoutDashboard, TrendingUp, Wallet, Megaphone, Star } from 'lucide-react'
import { motion } from 'framer-motion'
import {
  MERCHANT_MODULES,
  COMMISSION_TIERS,
  MERCHANT_TESTIMONIALS,
  IMG,
} from '@/data/constants'
import { usePageMeta } from '@/hooks/usePageMeta'
import { Reveal, Tilt3DCard, SectionHeading, Stagger, StaggerItem } from '@/components/motion'
import { MerchantSignupForm } from '@/components/forms/MerchantSignupForm'
import { Accordion } from '@/components/Accordion'
import { AppDownloadPanel } from '@/components/AppDownloadPanel'

const BENEFITS = [
  { icon: TrendingUp, t: 'Increase Visibility', d: 'Get discovered by thousands of hungry customers in your area.' },
  { icon: LayoutDashboard, t: 'Manage Orders', d: 'Accept, prepare, and track orders from a single dashboard.' },
  { icon: Megaphone, t: 'Marketing Tools', d: 'Run campaigns, promotions, and analytics to boost sales.' },
  { icon: Wallet, t: 'Fast Payouts', d: 'Transparent pricing with fast, reliable daily payouts.' },
]

const STEPS = [
  { n: '01', t: 'Sign up in 3 min', d: 'Register your shop, upload menu & documents. Approved in 24h.' },
  { n: '02', t: 'We bring customers', d: 'Appear to users nearby. Boost visibility with marketing tools.' },
  { n: '03', t: 'Earn & grow', d: 'Accept orders on the dashboard, riders pick up, you get paid daily to M-Pesa.' },
]

const FAQ = [
  { q: 'How long does onboarding take?', a: 'Apply online and most businesses are approved within 24 hours. Our team helps you list your menu and go live the same day.' },
  { q: 'What is the commission structure?', a: '0% for your first 30 days, then a transparent 14% flat rate on every order. Partners doing 300+ orders a month move to our 10% growth rate.' },
  { q: 'When do I get paid?', a: 'Payouts are settled daily to your registered M-Pesa or bank account, with a clear statement of every order.' },
  { q: 'Do I need my own delivery riders?', a: 'No — the HUDumika rider network handles pickup and delivery. You focus on preparing great food.' },
]

export default function MerchantPage() {
  usePageMeta('/merchant')

  return (
    <div className="pt-24">
      {/* Hero */}
      <section className="relative overflow-hidden bg-paper pb-16 pt-10 md:pt-14">
        <div className="absolute -right-10 top-10 h-72 w-72 rounded-full bg-brand-50 blur-2xl" aria-hidden />
        <div className="absolute -left-10 bottom-0 h-64 w-64 rounded-full bg-brand-500/10 blur-3xl" aria-hidden />
        <div className="container-x relative grid items-center gap-10 lg:grid-cols-2">
          <div>
            <Link to="/" className="mb-8 inline-flex items-center gap-2 text-sm font-medium text-ink-500 transition-colors hover:text-ink-900">
              <ArrowLeft className="h-4 w-4" aria-hidden />
              Back to home
            </Link>
            <motion.p
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              className="mb-3 inline-flex rounded-full bg-ink-900 px-4 py-1.5 text-xs font-bold text-white"
            >
              For restaurants & shops
            </motion.p>
            <motion.h1
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.05 }}
              className="font-display text-4xl leading-[0.95] font-bold tracking-tight text-ink-900 sm:text-5xl"
            >
              Grow your business with{' '}
              <span className="bg-gradient-to-r from-brand-600 to-emerald-600 bg-clip-text text-transparent">
                HUDumika
              </span>
            </motion.h1>
            <motion.p
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.1 }}
              className="mt-4 max-w-xl text-sm leading-relaxed text-ink-500 sm:text-base"
            >
              Reach more customers, increase order volume, and drive more sales. Manage everything
              from one easy-to-use dashboard.
            </motion.p>
            <motion.div
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.16 }}
              className="mt-7 flex flex-wrap gap-3"
            >
              <a href="#apply" className="rounded-full bg-ink-900 px-7 py-3.5 text-sm font-black text-white shadow-lg transition hover:bg-black">
                Become a Partner →
              </a>
              <a href="#calculator" className="rounded-full bg-surface px-7 py-3.5 text-sm font-bold text-ink-900 ring-1 ring-line transition hover:bg-paper">
                Estimate your growth
              </a>
            </motion.div>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: 0.3 }}
              className="mt-8 flex flex-wrap gap-6 text-sm"
            >
              <span className="flex items-center gap-2 font-bold text-ink-900">
                <span className="h-2 w-2 rounded-full bg-emerald-500" aria-hidden /> 0% commission · 30 days
              </span>
              <span className="flex items-center gap-2 font-bold text-ink-900">
                <span className="h-2 w-2 rounded-full bg-brand-600" aria-hidden /> Free onboarding
              </span>
            </motion.div>
          </div>

          <Tilt3DCard className="hidden lg:block">
            <div className="overflow-hidden rounded-[28px] bg-white p-3 shadow-2xl ring-1 ring-line">
              <img src={IMG.merchant} alt="Restaurant food ready for delivery" loading="lazy" className="aspect-[4/3] w-full rounded-[20px] object-cover" />
              <div className="grid grid-cols-3 gap-3 p-4">
                <div className="rounded-[16px] bg-paper p-3 text-center ring-1 ring-line">
                  <div className="text-lg font-black text-ink-900">+68%</div>
                  <div className="text-[11px] text-ink-500">More orders</div>
                </div>
                <div className="rounded-[16px] bg-emerald-50 p-3 text-center">
                  <div className="text-lg font-black text-ink-900">4.8</div>
                  <div className="text-[11px] text-ink-500">Rating</div>
                </div>
                <div className="rounded-[16px] bg-paper p-3 text-center ring-1 ring-line">
                  <div className="text-lg font-black text-ink-900">24/7</div>
                  <div className="text-[11px] text-ink-500">Support</div>
                </div>
              </div>
            </div>
          </Tilt3DCard>
        </div>
      </section>

      {/* Benefits */}
      <section className="container-x py-14">
        <SectionHeading eyebrow="Why partner" title="Built for merchants" sub="Everything you need to grow, in one dashboard." />
        <Stagger className="grid gap-4 md:grid-cols-2 lg:grid-cols-4" gap={0.08}>
          {BENEFITS.map((b) => {
            const Icon = b.icon
            return (
              <StaggerItem key={b.t}>
                <div className="group h-full rounded-[20px] bg-surface p-6 ring-1 ring-line transition-all duration-300 hover:-translate-y-1 hover:shadow-[0_20px_50px_-20px_rgba(16,20,18,0.15)]">
                  <span className="mb-3 grid h-11 w-11 place-items-center rounded-[12px] bg-brand-50 text-brand-600 transition-colors group-hover:bg-brand-500 group-hover:text-white">
                    <Icon className="h-5 w-5" aria-hidden />
                  </span>
                  <h3 className="font-bold text-ink-900">{b.t}</h3>
                  <p className="mt-1 text-sm leading-relaxed text-ink-500">{b.d}</p>
                </div>
              </StaggerItem>
            )
          })}
        </Stagger>
      </section>

      {/* How it works */}
      <section className="container-x py-14">
        <SectionHeading eyebrow="How it works" title="From signup to first order" />
        <div className="grid gap-4 md:grid-cols-3">
          {STEPS.map((s) => (
            <Reveal key={s.n}>
              <div className="h-full rounded-[20px] bg-surface p-6 ring-1 ring-line">
                <div className="font-mono text-xs font-bold tracking-widest text-brand-500">{s.n}</div>
                <h3 className="mt-1 text-lg font-black text-ink-900">{s.t}</h3>
                <p className="mt-1 text-sm leading-relaxed text-ink-500">{s.d}</p>
              </div>
            </Reveal>
          ))}
        </div>
      </section>

      {/* Commission tiers */}
      <section className="border-y border-line bg-surface py-14">
        <div className="container-x">
          <SectionHeading
            eyebrow="Transparent pricing"
            title="Simple, honest commission"
            sub="No hidden fees. You always know exactly what you keep."
            center
          />
          <div className="mx-auto grid max-w-4xl gap-4 md:grid-cols-3">
            {COMMISSION_TIERS.map((t, i) => (
              <Reveal key={t.name} delay={i * 0.07}>
                <div className={t.featured ? 'rounded-[20px] bg-ink-900 p-7 text-white shadow-xl' : 'h-full rounded-[20px] bg-paper p-7 ring-1 ring-line'}>
                  <div className={`text-xs font-bold tracking-widest uppercase ${t.featured ? 'text-white/50' : 'text-ink-500'}`}>
                    {t.name}
                  </div>
                  <div className={`mt-2 font-display text-4xl font-bold ${t.featured ? 'text-white' : 'text-ink-900'}`}>
                    {t.rate}
                  </div>
                  <p className={`mt-3 text-sm leading-relaxed ${t.featured ? 'text-white/70' : 'text-ink-500'}`}>
                    {t.description}
                  </p>
                </div>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* Partner operating model */}
      <section id="calculator" className="container-x py-14">
        <Reveal>
          <div className="overflow-hidden rounded-[28px] bg-ink-900 p-6 sm:p-10">
            <div className="grid gap-10 lg:grid-cols-[0.85fr_1.15fr] lg:items-center">
              <div>
                <p className="text-xs font-bold uppercase tracking-[0.16em] text-white/60">Partner operating model</p>
                <h2 className="mt-2 font-display text-3xl font-bold text-white">The tools to run your day</h2>
                <p className="mt-3 text-sm text-white/60">
                  HUDumika gives merchants practical tools to attract customers, fulfil orders, and
                  understand their business without hiding the important details.
                </p>
                <a href="#apply" className="mt-7 inline-flex rounded-full bg-surface px-6 py-3 text-sm font-bold text-ink-900 transition hover:bg-brand-50">
                  Start your application →
                </a>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                {[
                  { title: 'Visibility', text: 'Reach customers searching for food, groceries, and local services.' },
                  { title: 'Operations', text: 'Manage orders, menus, hours, stock, and staff from one place.' },
                  { title: 'Marketing', text: 'Create promotions and campaigns that fit your business.' },
                  { title: 'Payouts', text: 'See clear statements and settlement timing without guesswork.' },
                ].map((item) => (
                  <div key={item.title} className="rounded-[16px] bg-white/10 p-5 ring-1 ring-white/10">
                    <div className="text-sm font-bold text-white">{item.title}</div>
                    <p className="mt-2 text-xs leading-relaxed text-white/60">{item.text}</p>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </Reveal>
      </section>

      {/* Dashboard preview mock */}
      <section className="container-x py-14">
        <SectionHeading
          eyebrow="The dashboard"
          title="Your business at a glance"
          sub="The same tools your team will use — insights, orders, menu and money in one place."
        />
        <Reveal>
          <div className="overflow-hidden rounded-[28px] border border-line bg-surface shadow-[0_30px_80px_-40px_rgba(16,20,18,0.3)]">
            <div className="flex items-center gap-1.5 border-b border-line bg-paper px-4 py-3">
              <span className="h-2.5 w-2.5 rounded-full bg-danger/60" aria-hidden />
              <span className="h-2.5 w-2.5 rounded-full bg-accent/60" aria-hidden />
              <span className="h-2.5 w-2.5 rounded-full bg-brand-500/60" aria-hidden />
              <span className="ml-3 flex-1 truncate rounded-full bg-surface px-4 py-1 text-[11px] font-medium text-ink-500 ring-1 ring-line">
                Merchant dashboard · URL configured after deployment
              </span>
            </div>
            <div className="grid gap-4 p-6 md:grid-cols-2 lg:grid-cols-3">
              {MERCHANT_MODULES.map((m, i) => (
                <motion.div
                  key={m.title}
                  initial={{ opacity: 0, y: 14 }}
                  whileInView={{ opacity: 1, y: 0 }}
                  viewport={{ once: true }}
                  transition={{ delay: i * 0.05 }}
                  className="rounded-[16px] border border-line bg-paper p-5 transition-colors hover:border-brand-500/30"
                >
                  <div className="flex items-center gap-2">
                    <span className="h-2 w-2 rounded-full bg-brand-500" aria-hidden />
                    <div className="text-sm font-bold text-ink-900">{m.title}</div>
                  </div>
                  <p className="mt-2 text-xs leading-relaxed text-ink-500">{m.desc}</p>
                  <div className="mt-3 flex items-center gap-1 text-[11px] font-semibold text-brand-600">
                    Open <span aria-hidden>→</span>
                  </div>
                </motion.div>
              ))}
            </div>
          </div>
        </Reveal>
      </section>

      {/* Testimonials */}
      <section className="border-y border-line bg-surface py-14">
        <div className="container-x">
          <SectionHeading eyebrow="Partner stories" title="Merchants love the platform" center />
          <div className="mx-auto grid max-w-4xl gap-5 md:grid-cols-2">
            {MERCHANT_TESTIMONIALS.map((t, i) => (
              <Reveal key={t.name} delay={i * 0.08}>
                <div className="flex h-full flex-col rounded-[20px] border border-line bg-paper p-7">
                  <div className="flex gap-0.5" aria-hidden>
                    {[1, 2, 3, 4, 5].map((s) => (
                      <Star key={s} className="h-4 w-4 fill-brand-500 text-brand-500" />
                    ))}
                  </div>
                  <p className="mt-4 flex-1 text-sm leading-relaxed text-ink-700">"{t.quote}"</p>
                  <div className="mt-6">
                    <div className="text-sm font-semibold text-ink-900">{t.name}</div>
                    <div className="text-xs text-ink-500">{t.role}</div>
                  </div>
                </div>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* Signup */}
      <section id="apply" className="container-x py-14">
        <div className="grid gap-8 lg:grid-cols-2">
          <Reveal>
            <div className="overflow-hidden rounded-[28px] bg-ink-900 p-8 text-white">
              <h3 className="font-display text-2xl font-bold">Why partners join HUDumika</h3>
              <ul className="mt-6 space-y-4">
                {[
                  'Listed in 8 cities — Dar, Arusha, Mwanza, Dodoma, Zanzibar',
                  'Average +68% orders after the first month',
                  'Dedicated account manager & training',
                  'Marketing support · photographer comes to you',
                ].map((li) => (
                  <li key={li} className="flex gap-3 text-sm">
                    <span className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full bg-white text-brand-600">
                      <Check className="h-3.5 w-3.5" aria-hidden />
                    </span>
                    <span>{li}</span>
                  </li>
                ))}
              </ul>
              <div className="mt-8">
                <div className="text-xs font-bold tracking-widest text-white/60 uppercase">Merchant app</div>
                <p className="mt-2 text-xs text-white/70">Accept orders and track payouts on the go.</p>
                <span className="mt-3 inline-block rounded-full bg-white/10 px-4 py-2 text-xs font-semibold text-white ring-1 ring-white/15">
                  Store links coming soon
                </span>
              </div>
              <Link to="/login" className="mt-6 inline-block text-xs font-semibold text-white/70 underline transition hover:text-white">
                Already a partner? Merchant login →
              </Link>
            </div>
          </Reveal>
          <Reveal delay={0.08}>
            <MerchantSignupForm />
          </Reveal>
        </div>
      </section>

      {/* FAQ */}
      <section className="container-x pb-14">
        <div className="grid gap-10 lg:grid-cols-2">
          <SectionHeading eyebrow="Questions" title="Merchant FAQ" />
          <Accordion items={FAQ} defaultOpen={null} />
        </div>
      </section>
    </div>
  )
}
