import { Link } from 'react-router-dom'
import { ArrowLeft, Phone, Mail, Clock3, Headset, Store, Wrench, Truck } from 'lucide-react'
import { SUPPORT_TRACKS } from '@/data/constants'
import { usePageMeta } from '@/hooks/usePageMeta'
import { Reveal, Stagger, StaggerItem } from '@/components/motion'
import { FeedbackForm } from '@/components/forms/FeedbackForm'
import { PUBLIC_CONTACT } from '@/config/publicConfig'

const TRACK_ICONS: Record<string, typeof Headset> = {
  consumer: Headset,
  merchant: Store,
  provider: Wrench,
  rider: Truck,
}

export default function SupportPage() {
  usePageMeta('/support')

  return (
    <div className="pt-24">
      <section className="container-x pt-10 pb-14 md:pt-14">
        <Link to="/" className="mb-8 inline-flex items-center gap-2 text-sm font-medium text-ink-500 transition-colors hover:text-ink-900">
          <ArrowLeft className="h-4 w-4" aria-hidden />
          Back to home
        </Link>
        <div className="max-w-2xl">
          <span className="text-xs font-semibold tracking-widest text-brand-500 uppercase">Contact us</span>
          <h1 className="mt-3 font-display text-3xl font-bold tracking-tight text-ink-900 md:text-4xl">
            We're here to help
          </h1>
          <p className="mt-3 text-sm leading-relaxed text-ink-500">
            Pick the right track for fast help — consumer, merchant, provider, or rider. Every
            team has a dedicated hotline.
          </p>
        </div>

        <Stagger className="mt-10 grid gap-5 sm:grid-cols-2 lg:grid-cols-4" gap={0.08}>
          {SUPPORT_TRACKS.map((t) => {
            const Icon = TRACK_ICONS[t.id] ?? Headset
            const contact = PUBLIC_CONTACT[t.id]
            return (
              <StaggerItem key={t.id}>
                <div className="flex h-full flex-col rounded-[20px] border border-line bg-surface p-6 transition-all duration-300 hover:shadow-[0_20px_50px_-20px_rgba(16,20,18,0.15)]">
                  <span className="grid h-11 w-11 place-items-center rounded-[12px] bg-brand-50 text-brand-600">
                    <Icon className="h-5 w-5" aria-hidden />
                  </span>
                  <h2 className="mt-4 font-display text-lg font-bold text-ink-900">{t.title}</h2>
                  <ul className="mt-3 flex-1 space-y-1.5">
                    {t.points.map((p) => (
                      <li key={p} className="text-xs text-ink-500">
                        · {p}
                      </li>
                    ))}
                  </ul>
                  <div className="mt-5 space-y-2.5 border-t border-line pt-4 text-sm">
                    {contact.phone ? (
                      <a href={`tel:${contact.phone.replace(/\s/g, '')}`} className="flex items-center gap-2 font-bold text-ink-900 transition-colors hover:text-brand-600">
                        <Phone className="h-4 w-4 text-brand-500" aria-hidden />
                        {contact.phone}
                      </a>
                    ) : (
                      <span className="flex items-center gap-2 font-bold text-ink-500">
                        <Phone className="h-4 w-4 text-brand-500" aria-hidden />
                        Phone support coming soon
                      </span>
                    )}
                    <div className="flex items-center gap-2 text-xs text-ink-500">
                      <Clock3 className="h-4 w-4 text-ink-300" aria-hidden />
                      {t.hours}
                    </div>
                    {contact.email ? (
                      <a href={`mailto:${contact.email}`} className="flex items-center gap-2 text-xs text-ink-500 transition-colors hover:text-ink-900">
                        <Mail className="h-4 w-4 text-ink-300" aria-hidden />
                        {contact.email}
                      </a>
                    ) : (
                      <span className="flex items-center gap-2 text-xs text-ink-500">
                        <Mail className="h-4 w-4 text-ink-300" aria-hidden />
                        Email support coming soon
                      </span>
                    )}
                  </div>
                </div>
              </StaggerItem>
            )
          })}
        </Stagger>

        <div className="mt-6 rounded-[16px] border border-line bg-paper p-5 text-center text-xs text-ink-500">
          All support lines operate in English and Swahili.{' '}
          <Link to="/faq" className="font-semibold text-brand-600 hover:text-brand-700">
            Check the FAQ first →
          </Link>
        </div>

        <div className="mx-auto mt-14 max-w-xl">
          <Reveal>
            <div className="mb-6 text-center">
              <span className="text-xs font-semibold tracking-widest text-brand-500 uppercase">Feedback</span>
              <h2 className="mt-2 font-display text-2xl font-bold text-ink-900">Tell us what you think</h2>
            </div>
            <FeedbackForm />
          </Reveal>
        </div>
      </section>
    </div>
  )
}
