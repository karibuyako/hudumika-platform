import { Link } from 'react-router-dom'
import { ArrowLeft, Download, Store, Wrench, Truck, Smartphone, Apple } from 'lucide-react'
import { motion } from 'framer-motion'
import { Reveal } from '@/components/motion'
import { APP_LINKS, type AppLinks } from '@/config/appLinks'
import { usePageMeta } from '@/hooks/usePageMeta'
import { cn } from '@/utils/cn'

type AppEntry = {
  id: keyof AppLinks
  name: string
  audience: string
  description: string
  Icon: typeof Store
  accent: string
}

const APPS: AppEntry[] = [
  {
    id: 'customer',
    name: 'HUDumika Customer',
    audience: 'For everyone',
    description: 'Order food, book home services, send packages, and pay — all in one app.',
    Icon: Smartphone,
    accent: 'bg-brand-500',
  },
  {
    id: 'merchant',
    name: 'HUDumika Merchant',
    audience: 'Restaurants & shops',
    description: 'Manage your storefront, menus, orders, and payouts in real time.',
    Icon: Store,
    accent: 'bg-brand-600',
  },
  {
    id: 'provider',
    name: 'HUDumika Provider',
    audience: 'Skilled professionals',
    description: 'Offer your services, manage jobs, and grow your earnings.',
    Icon: Wrench,
    accent: 'bg-brand-700',
  },
  {
    id: 'rider',
    name: 'HUDumika Rider',
    audience: 'Delivery partners',
    description: 'Accept delivery jobs, track earnings, and get paid fast.',
    Icon: Truck,
    accent: 'bg-brand-800',
  },
]

export default function DownloadPage() {
  usePageMeta('/download')
  return (
    <div className="pt-24">
      <section className="relative overflow-hidden bg-paper pt-10 pb-14 md:pt-14">
        <div className="absolute inset-0 opacity-[0.035]">
          <div className="absolute inset-0 bg-[radial-gradient(70%_50%_at_50%_0%,var(--color-brand-500),transparent_65%)]" />
        </div>
        <div className="container-x relative">
          <Link
            to="/"
            className="mb-8 inline-flex items-center gap-2 text-sm font-medium text-ink-500 transition-colors hover:text-ink-900"
          >
            <ArrowLeft className="h-4 w-4" />
            Back to home
          </Link>
          <div className="mx-auto max-w-2xl text-center">
            <motion.span
              initial={{ opacity: 0, y: 14 }}
              animate={{ opacity: 1, y: 0 }}
              className="inline-flex items-center gap-2 rounded-full border border-brand-500/20 bg-surface px-3.5 py-1.5 text-xs font-semibold text-ink-900 shadow-sm"
            >
              <Download className="h-3 w-3 text-brand-500" />
              Free Android download
            </motion.span>
            <motion.h1
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.08 }}
              className="mt-5 font-display text-3xl font-bold tracking-tight text-ink-900 md:text-4xl"
            >
              Get the{' '}
              <span className="bg-gradient-to-r from-brand-600 to-brand-500 bg-clip-text text-transparent">
                HUDumika
              </span>{' '}
              apps
            </motion.h1>
            <motion.p
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.16 }}
              className="mt-3 text-sm leading-relaxed text-ink-500 md:text-base"
            >
              Download the Android app for your role below. iOS apps are coming soon to the App Store.
            </motion.p>
          </div>
        </div>
      </section>

      <section className="container-x py-12 md:py-16">
        <div className="grid gap-5 sm:grid-cols-2">
          {APPS.map((app, i) => {
            const apk = APP_LINKS[app.id].apk
            return (
              <Reveal key={app.id} delay={(i % 2) * 0.06}>
                <div className="flex h-full flex-col rounded-3xl border border-line bg-surface p-6 transition-all hover:border-brand-500/20 hover:shadow-[0_20px_50px_-20px_rgba(16,20,18,0.25)]">
                  <div className="flex items-center gap-3">
                    <span className={cn('grid h-12 w-12 place-items-center rounded-2xl text-white', app.accent)}>
                      <app.Icon className="h-6 w-6" aria-hidden />
                    </span>
                    <div>
                      <div className="text-base font-bold text-ink-900">{app.name}</div>
                      <div className="text-xs text-ink-500">{app.audience}</div>
                    </div>
                  </div>
                  <p className="mt-4 flex-1 text-sm leading-relaxed text-ink-500">{app.description}</p>
                  <div className="mt-5 flex flex-wrap items-center gap-3">
                    <a
                      href={apk}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-2 rounded-full bg-brand-600 px-5 py-3 text-sm font-semibold text-white transition hover:bg-brand-700"
                    >
                      <Download className="h-4 w-4" aria-hidden />
                      Download APK
                    </a>
                    <span className="inline-flex items-center gap-1.5 rounded-full border border-line px-3 py-2 text-xs font-medium text-ink-400">
                      <Apple className="h-3.5 w-3.5" aria-hidden />
                      iOS coming soon
                    </span>
                  </div>
                </div>
              </Reveal>
            )
          })}
        </div>

        <Reveal className="mt-12">
          <div className="rounded-3xl border border-line bg-paper p-6 md:p-8">
            <h3 className="font-display text-lg font-bold text-ink-900">How to install the APK</h3>
            <ol className="mt-4 grid gap-3 text-sm text-ink-600 md:grid-cols-3">
              <li className="rounded-2xl bg-surface p-4 ring-1 ring-line">
                <span className="font-display text-sm font-bold text-brand-600">1</span>
                <p className="mt-2">Tap <strong>Download APK</strong> and wait for the file to finish downloading.</p>
              </li>
              <li className="rounded-2xl bg-surface p-4 ring-1 ring-line">
                <span className="font-display text-sm font-bold text-brand-600">2</span>
                <p className="mt-2">
                  Open the file. If prompted, allow <strong>Install from unknown sources</strong>.
                </p>
              </li>
              <li className="rounded-2xl bg-surface p-4 ring-1 ring-line">
                <span className="font-display text-sm font-bold text-brand-600">3</span>
                <p className="mt-2">Tap <strong>Install</strong> and sign in with your HUDumika account.</p>
              </li>
            </ol>
          </div>
        </Reveal>
      </section>
    </div>
  )
}
