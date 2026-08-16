import { Link } from 'react-router-dom'
import { MapPin, Phone } from 'lucide-react'
import { BrandMark } from './BrandMark'
import { Stagger, StaggerItem } from './motion'
import { useI18n } from '@/i18n'
import { COMPANY_LOCATION, PUBLIC_CONTACT } from '@/config/publicConfig'

const SEO_CITIES = ['Dar es Salaam', 'Arusha', 'Dodoma', 'Mwanza', 'Zanzibar', 'Mbeya', 'Tanga', 'Morogoro']
const SEO_SERVICES = ['Plumbers', 'Electricians', 'House Cleaning', 'Appliance Repair', 'Laundry', 'Moving', 'Painting', 'Carpentry']

export function Footer() {
  const { t } = useI18n()

  const columns = [
    {
      title: t('footer.col.services'),
      links: [
        { label: t('footer.link.foodDelivery'), to: '/services?category=food' },
        { label: t('footer.link.homeServices'), to: '/services?category=home' },
        { label: t('footer.link.groceries'), to: '/services?category=groceries' },
        { label: t('footer.link.pharmacy'), to: '/services?category=pharmacy' },
        { label: t('footer.link.beauty'), to: '/services?category=beauty' },
        { label: t('footer.link.repairs'), to: '/services?category=repairs' },
      ],
    },
    {
      title: t('footer.col.partner'),
      links: [
        { label: t('footer.link.becomeMerchant'), to: '/merchant' },
        { label: t('footer.link.offerServices'), to: '/provider' },
        { label: t('footer.link.becomeRider'), to: '/rider' },
        { label: t('footer.link.merchantLogin'), to: '/login' },
      ],
    },
    {
      title: t('footer.col.company'),
      links: [
        { label: t('footer.link.about'), to: '/about' },
        { label: t('footer.link.community'), to: '/csr' },
        { label: t('footer.link.careers'), to: '/about' },
      ],
    },
    {
      title: t('footer.col.support'),
      links: [
        { label: t('footer.link.faq'), to: '/faq' },
        { label: t('footer.link.contact'), to: '/support' },
        { label: t('footer.link.privacy'), to: '/privacy' },
        { label: t('footer.link.terms'), to: '/terms' },
        { label: t('footer.link.cookies'), to: '/cookies' },
      ],
    },
  ]

  return (
    <footer className="mt-20 bg-ink-900 text-white">
      <div className="container-x py-14">
        <div className="grid gap-10 md:grid-cols-2 lg:grid-cols-5">
          <div className="lg:col-span-2">
            <BrandMark dark />
            <p className="mt-4 max-w-sm text-sm leading-relaxed text-white/60">
              {t('footer.tagline')}
            </p>
            <div className="mt-5 flex flex-wrap gap-2">
              {['M-Pesa', 'Tigo Pesa', 'Airtel Money', 'Visa · Mastercard'].map((p) => (
                <span
                  key={p}
                  className="rounded-full bg-white/10 px-3 py-1.5 text-xs font-semibold ring-1 ring-white/10"
                >
                  {p}
                </span>
              ))}
            </div>
          </div>

          <Stagger className="grid grid-cols-2 gap-8 sm:grid-cols-4 lg:col-span-3" gap={0.05}>
            {columns.map((col) => (
              <StaggerItem key={col.title}>
                <div className="text-xs font-semibold tracking-widest text-white/40 uppercase">
                  {col.title}
                </div>
                <ul className="mt-4 space-y-0.5">
                  {col.links.map((l) => (
                    <li key={l.label}>
                      <Link
                        to={l.to}
                        className="inline-block py-1.5 text-sm text-white/60 transition-colors hover:text-white"
                      >
                        {l.label}
                      </Link>
                    </li>
                  ))}
                </ul>
              </StaggerItem>
            ))}
          </Stagger>
        </div>

        {/* SEO block */}
        <div className="mt-12 border-t border-white/10 pt-8">
          <div className="grid gap-6 lg:grid-cols-2">
            <div>
              <div className="text-[11px] font-bold tracking-widest text-white/40 uppercase">
                {t('footer.seo.cities')}
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                {SEO_CITIES.map((c) => (
                  <Link
                    key={c}
                    to="/services"
                    className="rounded-full bg-white/5 px-3 py-1.5 text-xs font-medium text-white/60 ring-1 ring-white/10 transition hover:bg-white/10 hover:text-white"
                  >
                    {c}
                  </Link>
                ))}
              </div>
            </div>
            <div>
              <div className="text-[11px] font-bold tracking-widest text-white/40 uppercase">
                {t('footer.seo.services')}
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                {SEO_SERVICES.map((c) => (
                  <Link
                    key={c}
                    to="/services?category=home"
                    className="rounded-full bg-white/5 px-3 py-1.5 text-xs font-medium text-white/60 ring-1 ring-white/10 transition hover:bg-white/10 hover:text-white"
                  >
                    {c}
                  </Link>
                ))}
              </div>
            </div>
          </div>
        </div>

        <div className="mt-10 flex flex-col items-center justify-between gap-4 border-t border-white/10 pt-6 text-xs text-white/40 sm:flex-row">
          <div className="flex items-center gap-1.5">
            <MapPin className="h-3 w-3" aria-hidden />
            {COMPANY_LOCATION || t('footer.locationComing')}
          </div>
          <div>&copy; {new Date().getFullYear()} HUDumika. {t('footer.rights')}</div>
          {PUBLIC_CONTACT.consumer.phone ? (
            <a href={`tel:${PUBLIC_CONTACT.consumer.phone.replace(/\s/g, '')}`} className="flex items-center gap-1.5 py-1.5 text-white/50 transition hover:text-white">
              <Phone className="h-3 w-3" aria-hidden />
              {PUBLIC_CONTACT.consumer.phone}
            </a>
          ) : (
            <span className="flex items-center gap-1.5 py-1.5 text-white/50">
              <Phone className="h-3 w-3" aria-hidden />
              {t('footer.supportComing')}
            </span>
          )}
        </div>
      </div>
    </footer>
  )
}
