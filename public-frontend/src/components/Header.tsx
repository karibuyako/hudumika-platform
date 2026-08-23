import { useState, useEffect, useRef } from 'react'
import { Link, NavLink, useLocation } from 'react-router-dom'
import { AnimatePresence, motion } from 'framer-motion'
import { MapPin, ChevronDown, LogIn, Store, Wrench, Truck, HelpCircle, Menu, X, Languages, Download } from 'lucide-react'
import { cn } from '@/utils/cn'
import { useCity } from '@/context/city'
import { useI18n } from '@/i18n'
import { SERVICE_GROUPS, SERVICE_ICONS } from '@/data/constants'
import { ScrollProgress } from './motion'
import { PromoStrip } from './PromoStrip'
import { BrandMark } from './BrandMark'

type MenuId = 'services' | 'partner' | 'rider' | null

function useOutsideClose(ref: React.RefObject<HTMLElement | null>, onClose: () => void) {
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [ref, onClose])
}

export function Header() {
  const { cityName, setCityOpen } = useCity()
  const { t, lang, setLang } = useI18n()
  const [scrolled, setScrolled] = useState(false)
  const [mobileOpen, setMobileOpen] = useState(false)
  const [openMenu, setOpenMenu] = useState<MenuId>(null)
  const [langOpen, setLangOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const mobileBtnRef = useRef<HTMLButtonElement>(null)
  const location = useLocation()

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 20)
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  useEffect(() => {
    setMobileOpen(false)
    setOpenMenu(null)
  }, [location.pathname])

  useOutsideClose(menuRef, () => setOpenMenu(null))

  const closeMobile = () => {
    setMobileOpen(false)
    mobileBtnRef.current?.focus()
  }

  const dropdown = (id: Exclude<MenuId, null>) => {
    if (id === 'services') {
      return (
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 8 }}
          transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
          className="absolute top-full left-1/2 z-50 mt-3 w-[560px] -translate-x-1/2 overflow-hidden rounded-[20px] border border-line bg-surface shadow-[0_30px_80px_-30px_rgba(16,20,18,0.3)]"
        >
          <div className="grid grid-cols-2 gap-1 p-3">
            {SERVICE_GROUPS.slice(0, 8).map((s) => {
              const Icon = SERVICE_ICONS[s.id] ?? Store
              return (
                <Link
                  key={s.id}
                  to={`/services?category=${s.id}`}
                  className="flex items-center gap-3 rounded-[14px] px-3 py-2.5 transition hover:bg-paper"
                >
                  <span className="grid h-9 w-9 shrink-0 place-items-center rounded-[10px] bg-brand-50 text-brand-600">
                    <Icon className="h-4 w-4" />
                  </span>
                  <span>
                    <span className="block text-sm font-semibold text-ink-900">{s.label}</span>
                    <span className="block text-[11px] text-ink-500">{s.tagline}</span>
                  </span>
                </Link>
              )
            })}
          </div>
          <Link
            to="/services"
            className="flex items-center justify-between border-t border-line bg-paper px-4 py-3 text-sm font-bold text-brand-600 transition hover:text-brand-700"
          >
            Browse all services
            <span aria-hidden>→</span>
          </Link>
        </motion.div>
      )
    }
    const isMerchant = id === 'partner'
    return (
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: 8 }}
        transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
        className="absolute top-full left-1/2 z-50 mt-3 w-80 -translate-x-1/2 overflow-hidden rounded-[20px] border border-line bg-surface shadow-[0_30px_80px_-30px_rgba(16,20,18,0.3)]"
      >
        <div className="p-3">
          {isMerchant ? (
            <Link to="/merchant" className="flex items-start gap-3 rounded-[14px] p-3 transition hover:bg-paper">
              <span className="grid h-10 w-10 shrink-0 place-items-center rounded-[12px] bg-brand-50 text-brand-600">
                <Store className="h-5 w-5" />
              </span>
              <span>
                <span className="block text-sm font-bold text-ink-900">{t('header.becomeMerchant')}</span>
                <span className="mt-0.5 block text-xs leading-relaxed text-ink-500">
                  {t('header.becomeMerchantDesc')}
                </span>
              </span>
            </Link>
          ) : (
            <Link to="/provider" className="flex items-start gap-3 rounded-[14px] p-3 transition hover:bg-paper">
              <span className="grid h-10 w-10 shrink-0 place-items-center rounded-[12px] bg-brand-50 text-brand-600">
                <Wrench className="h-5 w-5" />
              </span>
              <span>
                <span className="block text-sm font-bold text-ink-900">{t('header.offerServices')}</span>
                <span className="mt-0.5 block text-xs leading-relaxed text-ink-500">
                  {t('header.offerServicesDesc')}
                </span>
              </span>
            </Link>
          )}
          <Link
            to={isMerchant ? '/merchant' : '/provider'}
            className="flex items-center justify-between rounded-xl px-3 py-2.5 text-sm font-semibold text-ink-900 transition hover:bg-paper"
          >
            {isMerchant ? t('header.becomePartner') : t('header.becomeProvider')}
            <span className="text-brand-500" aria-hidden>
              →
            </span>
          </Link>
        </div>
      </motion.div>
    )
  }

  const menuBtn = (id: Exclude<MenuId, null>, label: string, Icon: typeof Store) => (
    <div className="relative">
      <button
        onClick={() => setOpenMenu(openMenu === id ? null : id)}
        className={cn(
          'flex items-center gap-1 rounded-full px-3.5 py-2 text-sm font-medium transition-colors',
          openMenu === id ? 'bg-brand-50 text-ink-900' : 'text-ink-700 hover:bg-brand-50 hover:text-ink-900',
        )}
        aria-expanded={openMenu === id}
        aria-haspopup="menu"
      >
        <Icon className="h-4 w-4" aria-hidden />
        {label}
        <ChevronDown
          className={cn('h-3 w-3 text-ink-300 transition-transform', openMenu === id && 'rotate-180')}
          aria-hidden
        />
      </button>
      <AnimatePresence>{openMenu === id && dropdown(id)}</AnimatePresence>
    </div>
  )

  const LANGS: Array<{ id: 'en' | 'sw' | 'ar' | 'fr'; label: string }> = [
    { id: 'en', label: t('lang.en') },
    { id: 'sw', label: t('lang.sw') },
    { id: 'ar', label: t('lang.ar') },
    { id: 'fr', label: t('lang.fr') },
  ]

  const langMenu = (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 8 }}
      transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
      className="absolute top-full right-0 z-50 mt-3 w-44 overflow-hidden rounded-[16px] border border-line bg-surface shadow-[0_30px_80px_-30px_rgba(16,20,18,0.3)]"
    >
      <div className="p-2">
        {LANGS.map((l) => (
          <button
            key={l.id}
            onClick={() => {
              setLang(l.id)
              setLangOpen(false)
            }}
            className={cn(
              'flex w-full items-center justify-between rounded-xl px-3 py-2 text-sm font-semibold transition-colors',
              lang === l.id ? 'bg-brand-50 text-brand-600' : 'text-ink-700 hover:bg-paper',
            )}
          >
            {l.label}
            {lang === l.id && <span className="h-1.5 w-1.5 rounded-full bg-brand-500" aria-hidden />}
          </button>
        ))}
      </div>
    </motion.div>
  )

  return (
    <>
      <ScrollProgress />
      <div className="fixed inset-x-0 top-0 z-50">
        <PromoStrip />
        <header
          className={cn(
            'transition-all duration-300',
            scrolled
              ? 'border-b border-line bg-surface/90 shadow-[0_1px_2px_rgba(16,20,18,0.04)] backdrop-blur-md'
              : 'bg-transparent',
          )}
        >
          <div className="container-x flex h-16 items-center justify-between gap-3">
            <BrandMark />

            <nav className="hidden items-center gap-1 xl:flex" ref={menuRef} aria-label="Main">
              <Link
                to="/consumer"
                className="rounded-full px-3.5 py-2 text-sm font-medium text-ink-700 transition-colors hover:bg-brand-50 hover:text-ink-900"
              >
                {t('header.order')}
              </Link>
              {menuBtn('services', t('header.services'), Store)}
              {menuBtn('partner', t('header.partner'), Store)}
              <Link
                to="/rider"
                className="flex items-center gap-1 rounded-full px-3.5 py-2 text-sm font-medium text-ink-700 transition-colors hover:bg-brand-50 hover:text-ink-900"
              >
                <Truck className="h-4 w-4" aria-hidden />
                {t('header.deliver')}
              </Link>
              <NavLink
                to="/faq"
                className={({ isActive }) =>
                  cn(
                    'flex items-center gap-1 rounded-full px-3.5 py-2 text-sm font-medium transition-colors',
                    isActive ? 'bg-brand-50 text-ink-900' : 'text-ink-700 hover:bg-brand-50 hover:text-ink-900',
                  )
                }
              >
                <HelpCircle className="h-4 w-4" aria-hidden />
                {t('header.help')}
              </NavLink>
              <NavLink
                to="/download"
                className={({ isActive }) =>
                  cn(
                    'flex items-center gap-1 rounded-full px-3.5 py-2 text-sm font-medium transition-colors',
                    isActive ? 'bg-brand-50 text-ink-900' : 'text-ink-700 hover:bg-brand-50 hover:text-ink-900',
                  )
                }
              >
                <Download className="h-4 w-4" aria-hidden />
                Download
              </NavLink>
            </nav>

            <div className="flex items-center gap-2">
              <div className="relative">
                <button
                  onClick={() => setLangOpen((v) => !v)}
                  className="hidden items-center gap-1.5 rounded-full border border-line bg-surface px-3 py-2 text-xs font-bold text-ink-700 transition-colors hover:border-brand-500/30 hover:text-ink-900 md:flex"
                  aria-expanded={langOpen}
                  aria-haspopup="menu"
                  aria-label={t('header.language')}
                >
                  <Languages className="h-3.5 w-3.5 text-brand-500" aria-hidden />
                  {lang.toUpperCase()}
                  <ChevronDown
                    className={cn('h-3 w-3 text-ink-300 transition-transform', langOpen && 'rotate-180')}
                    aria-hidden
                  />
                </button>
                <AnimatePresence>{langOpen && langMenu}</AnimatePresence>
              </div>

              <button
                onClick={() => setCityOpen(true)}
                className="hidden items-center gap-1.5 rounded-full border border-line bg-surface px-3 py-2 text-xs font-medium text-ink-700 transition-colors hover:border-brand-500/30 md:flex"
              >
                <MapPin className="h-3 w-3 text-brand-500" aria-hidden />
                {cityName}
                <ChevronDown className="h-3 w-3 text-ink-300" aria-hidden />
              </button>

              <Link
                to="/login"
                className="hidden items-center gap-1.5 text-sm font-medium text-ink-700 transition-colors hover:text-ink-900 md:flex"
              >
                <LogIn className="h-4 w-4" aria-hidden />
                {t('header.logIn')}
              </Link>

              <Link
                to="/download"
                className="hidden rounded-full bg-ink-900 px-5 py-2.5 text-sm font-semibold text-surface transition-all hover:bg-brand-600 sm:inline-block"
              >
                {t('header.getApp')}
              </Link>

              <button
                ref={mobileBtnRef}
                onClick={() => setMobileOpen((v) => !v)}
                className="flex h-10 w-10 items-center justify-center rounded-full border border-line text-ink-700 transition-colors hover:border-ink-300 xl:hidden"
                aria-label={t('header.menu')}
                aria-expanded={mobileOpen}
                aria-controls="mobile-nav"
              >
                {mobileOpen ? <X className="h-4 w-4" aria-hidden /> : <Menu className="h-4 w-4" aria-hidden />}
              </button>
            </div>
          </div>

          <AnimatePresence>
            {mobileOpen && (
              <motion.div
                id="mobile-nav"
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
                transition={{ duration: 0.25 }}
                className="overflow-hidden border-b border-line bg-surface xl:hidden"
              >
                <div className="container-x max-h-[calc(100dvh-7rem)] space-y-1 overflow-y-auto py-4">
                  <button
                    onClick={() => {
                      setCityOpen(true)
                      setMobileOpen(false)
                    }}
                    className="flex w-full items-center gap-2 rounded-lg px-3 py-3 text-sm font-medium text-ink-700 transition-colors hover:bg-brand-50"
                  >
                    <MapPin className="h-4 w-4 text-brand-500" aria-hidden />
                    {cityName}
                  </button>
                  {[
                    { label: t('header.mobile.orderFood'), to: '/consumer', Icon: Store },
                    { label: t('header.mobile.allServices'), to: '/services', Icon: Store },
                    { label: t('header.becomeMerchant'), to: '/merchant', Icon: Store },
                    { label: t('header.offerServices'), to: '/provider', Icon: Wrench },
                    { label: t('header.mobile.deliver'), to: '/rider', Icon: Truck },
                    { label: t('header.mobile.help'), to: '/faq', Icon: HelpCircle },
                    { label: 'Download apps', to: '/download', Icon: Download },
                  ].map((l) => (
                    <Link
                      key={l.to}
                      to={l.to}
                      className="flex items-center gap-2.5 rounded-lg px-3 py-3 text-sm font-medium text-ink-700 transition-colors hover:bg-brand-50"
                    >
                      <l.Icon className="h-4 w-4 text-ink-500" aria-hidden />
                      {l.label}
                    </Link>
                  ))}
                  <Link
                    to="/login"
                    className="flex items-center gap-2.5 rounded-lg px-3 py-3 text-sm font-medium text-ink-700 transition-colors hover:bg-brand-50"
                  >
                    <LogIn className="h-4 w-4 text-ink-500" aria-hidden />
                    {t('header.logIn')}
                  </Link>
                  <Link
                    to="/services"
                    onClick={closeMobile}
                    className="mt-2 block rounded-full bg-ink-900 px-5 py-3 text-center text-sm font-semibold text-surface"
                  >
                    {t('header.getApp')}
                  </Link>
                  <div className="mt-1 border-t border-line pt-3">
                    <div className="flex items-center gap-2 px-3 pb-2 text-[11px] font-bold tracking-widest text-ink-300 uppercase">
                      <Languages className="h-3.5 w-3.5" aria-hidden />
                      {t('header.language')}
                    </div>
                    <div className="flex flex-wrap gap-2 px-3">
                      {LANGS.map((l) => (
                        <button
                          key={l.id}
                          onClick={() => {
                            setLang(l.id)
                            setMobileOpen(false)
                          }}
                          className={cn(
                            'rounded-full px-4 py-2 text-xs font-bold ring-1 transition',
                            lang === l.id
                              ? 'bg-ink-900 text-white ring-ink-900'
                              : 'bg-surface text-ink-700 ring-line hover:bg-paper',
                          )}
                        >
                          {l.label}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </header>
      </div>
    </>
  )
}
