import { Link } from 'react-router-dom'
import { ArrowLeft, ShieldCheck, HeartHandshake, GraduationCap, Heart } from 'lucide-react'
import { IMG } from '@/data/constants'
import { usePageMeta } from '@/hooks/usePageMeta'
import { Reveal, SectionHeading } from '@/components/motion'

const PILLARS = [
  { icon: ShieldCheck, t: 'Safety first', d: 'Every rider gets insurance, safety training and a starter kit — helmet, hot bag, and reflective jacket.' },
  { icon: HeartHandshake, t: 'Fair earnings', d: 'Transparent fares, daily payouts, and bonuses that reward consistency — never hidden deductions.' },
  { icon: GraduationCap, t: 'Training & growth', d: 'Free onboarding training, safe-riding courses, and career paths from rider to fleet supervisor.' },
]

const STORIES = [
  { title: 'Rider community fund', text: 'A collective fund that supports riders and their families during emergencies — from hospital bills to school fees.', tag: 'Impact' },
  { title: 'Road safety campaign', text: 'In partnership with local authorities, we run monthly safe-riding workshops across all 8 cities.', tag: 'Safety' },
  { title: 'Supporting local markets', text: 'Small grocers, family restaurants and independent tradespeople reach 10x more customers through the platform — money stays in the community.', tag: 'Community' },
]

export default function CsrPage() {
  usePageMeta('/csr')

  return (
    <div className="pt-24">
      <section className="relative overflow-hidden bg-ink-900 pb-16 pt-10 md:pt-14">
        <div className="absolute inset-0 bg-[radial-gradient(60%_50%_at_50%_0%,rgba(26,92,68,0.5),transparent_65%)]" aria-hidden />
        <div className="container-x relative">
          <Link to="/" className="mb-8 inline-flex items-center gap-2 text-sm font-medium text-white/60 transition-colors hover:text-white">
            <ArrowLeft className="h-4 w-4" aria-hidden />
            Back to home
          </Link>
          <div className="max-w-2xl">
            <span className="inline-flex items-center gap-2 rounded-full bg-white/10 px-3.5 py-1.5 text-xs font-semibold text-white/80 ring-1 ring-white/15 backdrop-blur">
              <Heart className="h-3.5 w-3.5 text-accent" aria-hidden />
              Our community
            </span>
            <h1 className="mt-5 font-display text-3xl font-bold tracking-tight text-white md:text-4xl">
              We invest in our riders, pros and communities
            </h1>
            <p className="mt-4 text-sm leading-relaxed text-white/70">
              HUDumika's success is Tanzania's success. That's why we put riders' welfare, road
              safety, and local businesses at the centre of everything we build.
            </p>
          </div>
        </div>
      </section>

      <section className="container-x py-14 md:py-20">
        <SectionHeading eyebrow="How we care" title="Three commitments" center />
        <div className="grid gap-5 md:grid-cols-3">
          {PILLARS.map((p, i) => {
            const Icon = p.icon
            return (
              <Reveal key={p.t} delay={i * 0.08}>
                <div className="group h-full rounded-[20px] bg-surface p-7 ring-1 ring-line transition-all duration-300 hover:-translate-y-1 hover:shadow-[0_20px_50px_-20px_rgba(16,20,18,0.15)]">
                  <span className="mb-4 grid h-12 w-12 place-items-center rounded-[12px] bg-brand-50 text-brand-600 transition-colors group-hover:bg-brand-500 group-hover:text-white">
                    <Icon className="h-5 w-5" aria-hidden />
                  </span>
                  <h3 className="font-display text-lg font-bold text-ink-900">{p.t}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-ink-500">{p.d}</p>
                </div>
              </Reveal>
            )
          })}
        </div>
      </section>

      <section className="border-y border-line bg-surface py-14 md:py-20">
        <div className="container-x">
          <SectionHeading eyebrow="Stories" title="Community in action" />
          <div className="grid gap-5 md:grid-cols-3">
            {STORIES.map((s, i) => (
              <Reveal key={s.title} delay={i * 0.08}>
                <div className="flex h-full flex-col rounded-[20px] border border-line bg-paper p-7">
                  <span className="inline-flex self-start rounded-full bg-brand-50 px-3 py-1 text-[10px] font-bold tracking-widest text-brand-600 uppercase">
                    {s.tag}
                  </span>
                  <h3 className="mt-4 font-display text-lg font-bold text-ink-900">{s.title}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-ink-500">{s.text}</p>
                </div>
              </Reveal>
            ))}
          </div>

          <Reveal className="mt-12">
            <div className="grid items-center gap-6 overflow-hidden rounded-[24px] bg-ink-900 lg:grid-cols-2">
              <div className="p-8 md:p-10">
                <h2 className="font-display text-2xl font-bold text-white md:text-3xl">Want to be part of it?</h2>
                <p className="mt-3 max-w-md text-sm text-white/60">
                  Join riders and service providers across Tanzania who help people every day.
                </p>
                <div className="mt-6 flex flex-wrap gap-3">
                  <Link to="/rider" className="rounded-full bg-surface px-6 py-3 text-sm font-bold text-ink-900 transition hover:bg-white">
                    Become a rider
                  </Link>
                  <Link to="/provider" className="rounded-full bg-white/10 px-6 py-3 text-sm font-bold text-white ring-1 ring-white/15 transition hover:bg-white/15">
                    Offer services
                  </Link>
                </div>
              </div>
              <div className="hidden h-full lg:block">
                <img src={IMG.heroRider} alt="HUDumika rider in the city" loading="lazy" className="h-full w-full object-cover" />
              </div>
            </div>
          </Reveal>
        </div>
      </section>
    </div>
  )
}
