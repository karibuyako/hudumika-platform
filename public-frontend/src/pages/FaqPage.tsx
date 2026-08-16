import { Link } from 'react-router-dom'
import { ArrowLeft } from 'lucide-react'
import { FAQ_GROUPS } from '@/data/constants'
import { usePageMeta } from '@/hooks/usePageMeta'
import { Accordion } from '@/components/Accordion'

export default function FaqPage() {
  usePageMeta('/faq')

  return (
    <div className="pt-24">
      <section className="container-x pt-10 pb-14 md:pt-14">
        <Link
          to="/"
          className="mb-8 inline-flex items-center gap-2 text-sm font-medium text-ink-500 transition-colors hover:text-ink-900"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden />
          Back to home
        </Link>
        <div className="max-w-2xl">
          <span className="text-xs font-semibold tracking-widest text-brand-500 uppercase">Help centre</span>
          <h1 className="mt-3 font-display text-3xl font-bold tracking-tight text-ink-900 md:text-4xl">
            Frequently asked questions
          </h1>
          <p className="mt-3 text-sm leading-relaxed text-ink-500">
            Payments, refunds, orders, home-service bookings, delivery and safety — the answers
            you need, fast. Can't find yours?{' '}
            <Link to="/support" className="font-semibold text-brand-600 hover:text-brand-700">
              Contact support →
            </Link>
          </p>
        </div>

        <div className="mt-10 grid gap-5 lg:grid-cols-2">
          {FAQ_GROUPS.map((g) => (
            <Accordion key={g.title} title={g.title} items={g.items} defaultOpen={null} />
          ))}
        </div>
      </section>
    </div>
  )
}
