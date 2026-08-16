import { Link } from 'react-router-dom'
import { ArrowLeft, Check, ShieldCheck, Wallet, CalendarCheck, Star } from 'lucide-react'
import { motion } from 'framer-motion'
import { PROVIDER_BENEFITS, PROVIDER_CATEGORIES, IMG } from '@/data/constants'
import { usePageMeta } from '@/hooks/usePageMeta'
import { Reveal, Tilt3DCard, SectionHeading, Stagger, StaggerItem } from '@/components/motion'
import { AppDownloadPanel } from '@/components/AppDownloadPanel'
import { Accordion } from '@/components/Accordion'
import { ProviderSignupForm } from '@/components/forms/ProviderSignupForm'

const STEPS = [
  { n: '01', t: 'Apply in minutes', d: 'Tell us your trade, city and rates. Verification takes under 24 hours.' },
  { n: '02', t: 'Get verified', d: 'ID check, background check and a skills review build your trusted badge.' },
  { n: '03', t: 'Receive bookings', d: 'Customers in your area book you directly — you approve each job.' },
  { n: '04', t: 'Work & get paid', d: 'Complete the job, get rated, and receive weekly payouts to M-Pesa.' },
]

const FAQ = [
  { q: 'Do I need to be a registered business?', a: 'No. Individuals can join as providers after passing ID and background verification. Registered businesses are welcome too and can list multiple team members.' },
  { q: 'How much does it cost to join?', a: 'Joining is free. Providers keep a transparent share of each booking — see the exact rate before you accept any job.' },
  { q: 'How do payouts work?', a: 'Funds from completed jobs are settled weekly to your M-Pesa or bank account, with a clear statement of every job.' },
  { q: 'What if a customer is unhappy with my work?', a: 'We mediate fairly. Payment is released only after the customer confirms completion, and disputes are reviewed by our team within 48 hours.' },
]

const PROVIDER_FAQ = [
  { q: 'Which services can I offer?', a: 'Any local service: plumbing, electrical, cleaning, appliance repair, painting, carpentry, moving, laundry, beauty and more. Pick the categories you are qualified for.' },
  { q: 'Can I set my own prices?', a: 'Yes — you set your rates within fair ranges for your trade and city. Customers always see the full price before booking.' },
  { q: 'Do I need my own tools?', a: 'Yes for most trades. For cleaning and laundry services, we help source partner supplies at wholesale rates.' },
  { q: 'What is the provider dashboard?', a: 'Your dashboard shows incoming bookings, your calendar, earnings, ratings and payouts — all in one place, on web and app.' },
]

export default function ProviderPage() {
  usePageMeta('/provider')

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
              For home-service professionals
            </motion.p>
            <motion.h1
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.05 }}
              className="font-display text-4xl leading-[0.95] font-bold tracking-tight text-ink-900 sm:text-5xl"
            >
              Your trade, <span className="bg-gradient-to-r from-brand-600 to-emerald-600 bg-clip-text text-transparent">fully booked</span>
            </motion.h1>
            <motion.p
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.1 }}
              className="mt-4 max-w-xl text-sm leading-relaxed text-ink-500 sm:text-base"
            >
              Plumbers, electricians, cleaners, repair pros and more — get booked by customers in
              your area, set your own rates, and get paid weekly.
            </motion.p>
            <motion.div
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.16 }}
              className="mt-7 flex flex-wrap gap-3"
            >
              <a href="#apply" className="rounded-full bg-ink-900 px-7 py-3.5 text-sm font-black text-white shadow-lg transition hover:bg-black">
                Apply as a Provider →
              </a>
              <a href="#how" className="rounded-full bg-surface px-7 py-3.5 text-sm font-bold text-ink-900 ring-1 ring-line transition hover:bg-paper">
                How it works
              </a>
            </motion.div>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: 0.3 }}
              className="mt-8 flex flex-wrap gap-6 text-sm"
            >
              <span className="flex items-center gap-2 font-bold text-ink-900">
                <ShieldCheck className="h-4 w-4 text-brand-500" aria-hidden /> Verified badge
              </span>
              <span className="flex items-center gap-2 font-bold text-ink-900">
                <Wallet className="h-4 w-4 text-brand-500" aria-hidden /> Weekly payouts
              </span>
              <span className="flex items-center gap-2 font-bold text-ink-900">
                <Star className="h-4 w-4 fill-brand-500 text-brand-500" aria-hidden /> Customer ratings
              </span>
            </motion.div>
          </div>

          <Tilt3DCard className="hidden lg:block">
            <div className="overflow-hidden rounded-[28px] bg-surface p-3 shadow-2xl ring-1 ring-line">
              <img src={IMG.provider} alt="A service professional at work" loading="lazy" className="aspect-[4/3] w-full rounded-[20px] object-cover" />
              <div className="grid grid-cols-3 gap-3 p-4">
                <div className="rounded-[16px] bg-paper p-3 text-center ring-1 ring-line">
                  <div className="text-lg font-black text-ink-900">4.8</div>
                  <div className="text-[11px] text-ink-500">Avg rating</div>
                </div>
                <div className="rounded-[16px] bg-emerald-50 p-3 text-center">
                  <div className="text-lg font-black text-ink-900">+3</div>
                  <div className="text-[11px] text-ink-500">Bookings / day</div>
                </div>
                <div className="rounded-[16px] bg-paper p-3 text-center ring-1 ring-line">
                  <div className="text-lg font-black text-ink-900">24h</div>
                  <div className="text-[11px] text-ink-500">Verification</div>
                </div>
              </div>
            </div>
          </Tilt3DCard>
        </div>
      </section>

      {/* Benefits */}
      <section className="container-x py-14">
        <SectionHeading eyebrow="Why join" title="Built for professionals" sub="The tools you need to turn skills into a steady stream of bookings." />
        <Stagger className="grid gap-4 md:grid-cols-2 lg:grid-cols-4" gap={0.08}>
          {PROVIDER_BENEFITS.map((b) => (
            <StaggerItem key={b.title}>
              <div className="group h-full rounded-[20px] bg-surface p-6 ring-1 ring-line transition-all duration-300 hover:-translate-y-1 hover:shadow-[0_20px_50px_-20px_rgba(16,20,18,0.15)]">
                <span className="mb-3 grid h-11 w-11 place-items-center rounded-[12px] bg-brand-50 text-brand-600 transition-colors group-hover:bg-brand-500 group-hover:text-white">
                  <CalendarCheck className="h-5 w-5" aria-hidden />
                </span>
                <h3 className="font-bold text-ink-900">{b.title}</h3>
                <p className="mt-1 text-sm leading-relaxed text-ink-500">{b.desc}</p>
              </div>
            </StaggerItem>
          ))}
        </Stagger>
      </section>

      {/* Categories */}
      <section className="border-y border-line bg-surface py-14">
        <div className="container-x">
          <SectionHeading eyebrow="Trades we support" title="Offer any local service" center />
          <div className="mx-auto flex max-w-3xl flex-wrap justify-center gap-2">
            {PROVIDER_CATEGORIES.map((c, i) => (
              <Reveal key={c} delay={i * 0.03}>
                <span className="inline-flex items-center gap-1.5 rounded-full bg-paper px-4 py-2 text-sm font-semibold text-ink-700 ring-1 ring-line">
                  <Check className="h-3.5 w-3.5 text-brand-500" aria-hidden />
                  {c}
                </span>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* How it works */}
      <section id="how" className="container-x py-14">
        <SectionHeading eyebrow="How it works" title="From application to first booking" />
        <div className="grid gap-4 md:grid-cols-4">
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

      {/* Apply */}
      <section id="apply" className="container-x py-14">
        <div className="grid gap-8 lg:grid-cols-2">
          <Reveal>
            <div className="rounded-[28px] bg-brand-600 p-8 text-white">
              <h3 className="font-display text-2xl font-bold">Why providers choose HUDumika</h3>
              <ul className="mt-6 space-y-4">
                {[
                  'Free to join — no upfront fees, no subscriptions',
                  'Transparent share: you see the rate before accepting',
                  'Verified badge builds trust and wins jobs',
                  'Weekly payouts to M-Pesa or bank with clear statements',
                  'In-app chat with customers and 24/7 provider support',
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
                <div className="text-xs font-bold tracking-widest text-white/60 uppercase">Provider app</div>
                <p className="mt-2 text-xs text-white/70">Accept bookings and manage your calendar on the go.</p>
                <span className="mt-3 inline-block rounded-full bg-white/10 px-4 py-2 text-xs font-semibold text-white ring-1 ring-white/15">
                  Store links coming soon
                </span>
              </div>
            </div>
          </Reveal>
          <Reveal delay={0.08}>
            <ProviderSignupForm />
          </Reveal>
        </div>
      </section>

      {/* FAQ */}
      <section className="border-y border-line bg-surface py-14">
        <div className="container-x grid gap-10 lg:grid-cols-2">
          <div>
            <SectionHeading eyebrow="Questions" title="Provider FAQ" />
            <p className="-mt-4 text-sm text-ink-500">
              More answers in the{' '}
              <Link to="/faq" className="font-semibold text-brand-600 hover:text-brand-700">
                full FAQ →
              </Link>
            </p>
          </div>
          <Accordion items={[...FAQ, ...PROVIDER_FAQ]} defaultOpen={null} />
        </div>
      </section>
    </div>
  )
}
