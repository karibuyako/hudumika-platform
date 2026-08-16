import { Link } from 'react-router-dom'
import { ArrowLeft } from 'lucide-react'
import { IMG } from '@/data/constants'
import { usePageMeta } from '@/hooks/usePageMeta'
import { Reveal, SectionHeading } from '@/components/motion'

const MILESTONES = [
  { year: '2025', t: 'Founded in Dar es Salaam', d: 'HUDumika launches food delivery in Dar es Salaam with 50 partner restaurants.' },
  { year: '2025', t: 'Merchant & rider platforms', d: 'The merchant dashboard and rider app go live — 0% commission launch offer.' },
  { year: '2026', t: 'Home services arrive', d: 'Plumbers, electricians and cleaners join the platform — book a pro in minutes.' },
  { year: '2026', t: '8 cities and growing', d: 'Arusha, Dodoma, Mwanza, Zanzibar, Mbeya, Tanga and Morogoro join the network.' },
]

const VALUES = [
  { t: 'Customers first', d: 'Every decision starts with the person waiting at the door.' },
  { t: 'Partners thrive', d: 'Transparent commission — your success is our success.' },
  { t: 'Riders & pros respected', d: 'Fair pay, safety, and dignity for the people who move the city.' },
  { t: 'Local always', d: 'Swahili-first, Tanzania-built, and proud of it.' },
]

export default function AboutPage() {
  usePageMeta('/about')

  return (
    <div className="pt-24">
      <section className="container-x pt-10 pb-14 md:pt-14">
        <Link to="/" className="mb-8 inline-flex items-center gap-2 text-sm font-medium text-ink-500 transition-colors hover:text-ink-900">
          <ArrowLeft className="h-4 w-4" aria-hidden />
          Back to home
        </Link>

        <div className="mx-auto max-w-2xl text-center">
          <span className="text-xs font-semibold tracking-widest text-brand-500 uppercase">About us</span>
          <h1 className="mt-3 font-display text-3xl font-bold tracking-tight text-ink-900 md:text-4xl">
            Your city, <span className="bg-gradient-to-r from-brand-600 to-emerald-600 bg-clip-text text-transparent">delivered and done</span>
          </h1>
          <p className="mt-4 text-sm leading-relaxed text-ink-500 md:text-base">
            HUDumika is a Tanzanian platform built in Dar es Salaam. We connect local restaurants,
            shops and skilled professionals with the people around them — food, groceries, home
            services and more, delivered by riders who know their streets best.
          </p>
        </div>

        <Reveal className="mx-auto mt-12 max-w-3xl">
          <div className="overflow-hidden rounded-[24px] ring-1 ring-line">
            <img src={IMG.team} alt="The HUDumika team and partners" loading="lazy" className="aspect-[16/8] w-full object-cover" />
          </div>
        </Reveal>

        <div className="mx-auto mt-12 max-w-3xl">
          <SectionHeading eyebrow="Our story" title="Milestones" />
          <div className="space-y-4">
            {MILESTONES.map((m, i) => (
              <Reveal key={m.t} delay={i * 0.05}>
                <div className="flex gap-5 rounded-[20px] border border-line bg-surface p-6">
                  <div className="shrink-0 rounded-xl bg-brand-50 px-3 py-1.5 text-xs font-black text-brand-600">{m.year}</div>
                  <div>
                    <h3 className="text-sm font-bold text-ink-900">{m.t}</h3>
                    <p className="mt-1 text-sm leading-relaxed text-ink-500">{m.d}</p>
                  </div>
                </div>
              </Reveal>
            ))}
          </div>
        </div>

        <div className="mx-auto mt-14 max-w-3xl">
          <SectionHeading eyebrow="What we believe" title="Our values" center />
          <div className="grid gap-4 sm:grid-cols-2">
            {VALUES.map((v, i) => (
              <Reveal key={v.t} delay={i * 0.06}>
                <div className="h-full rounded-[20px] border border-line bg-surface p-6">
                  <h3 className="text-sm font-bold text-ink-900">{v.t}</h3>
                  <p className="mt-1.5 text-xs leading-relaxed text-ink-500">{v.d}</p>
                </div>
              </Reveal>
            ))}
          </div>
        </div>

        <Reveal className="mx-auto mt-14 max-w-3xl">
          <div className="rounded-[24px] bg-ink-900 p-8 text-center">
            <h2 className="font-display text-xl font-bold text-white">Come say hello</h2>
            <p className="mt-2 text-sm text-white/60">Questions, partnerships or press? We'd love to hear from you.</p>
            <div className="mt-5 flex flex-wrap justify-center gap-3">
              <Link to="/support" className="rounded-full bg-surface px-6 py-3 text-sm font-bold text-ink-900 transition hover:bg-white">
                Contact us
              </Link>
              <Link to="/csr" className="rounded-full bg-white/10 px-6 py-3 text-sm font-bold text-white ring-1 ring-white/15 transition hover:bg-white/15">
                Our community
              </Link>
            </div>
          </div>
        </Reveal>
      </section>
    </div>
  )
}
