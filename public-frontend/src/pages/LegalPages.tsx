import { Link, useLocation } from 'react-router-dom'
import { ArrowLeft } from 'lucide-react'
import { LEGAL_DOCS } from '@/data/constants'
import { usePageMeta } from '@/hooks/usePageMeta'
import { Reveal } from '@/components/motion'

export default function LegalPages() {
  const { pathname } = useLocation()
  usePageMeta(pathname)
  const doc = LEGAL_DOCS[pathname.replace('/', '')] ?? LEGAL_DOCS.privacy

  return (
    <div className="pt-24">
      <section className="container-x max-w-3xl pt-10 pb-16 md:pt-14">
        <Link to="/" className="mb-8 inline-flex items-center gap-2 text-sm font-medium text-ink-500 transition-colors hover:text-ink-900">
          <ArrowLeft className="h-4 w-4" aria-hidden />
          Back to home
        </Link>

        <span className="text-xs font-semibold tracking-widest text-brand-500 uppercase">
          Legal · Updated {doc.updated}
        </span>
        <h1 className="mt-3 font-display text-3xl font-bold tracking-tight text-ink-900">{doc.title}</h1>
        <p className="mt-4 text-sm leading-relaxed text-ink-500">{doc.intro}</p>

        <div className="mt-10 space-y-8">
          {doc.sections.map((s, i) => (
            <Reveal key={s.h} delay={i * 0.04}>
              <div>
                <h2 className="text-base font-bold text-ink-900">{s.h}</h2>
                <p className="mt-2 text-sm leading-relaxed text-ink-500">{s.p}</p>
              </div>
            </Reveal>
          ))}
        </div>

        <div className="mt-12 rounded-[16px] border border-line bg-surface p-6 text-center text-xs text-ink-500">
          Questions about this policy?{' '}
          <Link to="/support" className="font-semibold text-brand-600 hover:text-brand-700">
            Contact our team →
          </Link>
        </div>
      </section>
    </div>
  )
}
