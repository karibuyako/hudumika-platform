import { Smartphone, Store, Download } from 'lucide-react'
import { cn } from '@/utils/cn'
import { APP_LINKS, type AppLinks } from '@/config/appLinks'
import { AppBadge } from './AppBadge'

export type AppInfo = {
  id: keyof AppLinks
  name: string
  audience: string
  description: string
  accent: string
}

export function AppDownloadPanel({
  apps,
  dark,
  className,
}: {
  apps: AppInfo[]
  dark?: boolean
  className?: string
}) {
  return (
    <div className={cn('rounded-[28px] p-8 md:p-10', dark ? 'bg-ink-900 text-white' : 'bg-ink-900 text-white', className)}>
      <div className="flex flex-col gap-8 lg:flex-row lg:items-start lg:justify-between">
        <div className="max-w-md">
          <span
            className={cn(
              'inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs font-semibold',
              'bg-brand-500/20 text-brand-50',
            )}
          >
            <Smartphone className="h-3.5 w-3.5" aria-hidden />
            Get the app
          </span>
          <h2 className="mt-4 font-display text-2xl font-bold md:text-3xl">
            One account, every app
          </h2>
          <p className="mt-3 text-sm leading-relaxed text-white/60">
            Download the app for your role — order and book as a customer, manage your business as
            a merchant or provider, or earn as a rider.
          </p>
        </div>

        <div className="grid gap-3 sm:grid-cols-2 lg:min-w-[420px]">
          {apps.map((app) => (
            <div key={app.id} className="rounded-[20px] bg-white/5 p-5 ring-1 ring-white/10 backdrop-blur">
              <div className="flex items-center gap-2.5">
                <span className={cn('grid h-9 w-9 place-items-center rounded-xl', app.accent)}>
                  <Store className="h-4 w-4 text-white" aria-hidden />
                </span>
                <div>
                  <div className="text-sm font-bold">{app.name}</div>
                  <div className="text-[11px] text-white/50">{app.audience}</div>
                </div>
              </div>
              <p className="mt-3 text-xs leading-relaxed text-white/60">{app.description}</p>
              <div className="mt-4 flex flex-wrap gap-2">
                {APP_LINKS[app.id].apk && (
                  <a
                    href={APP_LINKS[app.id].apk}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1.5 rounded-full bg-brand-500 px-3 py-1.5 text-[11px] font-semibold text-white transition hover:bg-brand-600"
                  >
                    <Download className="h-3.5 w-3.5" aria-hidden />
                    Download APK
                  </a>
                )}
                <AppBadge store="ios" href={APP_LINKS[app.id].ios} dark className="px-3 py-1.5 text-[11px]" />
                {!APP_LINKS[app.id].apk && (
                  <AppBadge store="android" href={APP_LINKS[app.id].android} dark className="px-3 py-1.5 text-[11px]" />
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
