import { Suspense, lazy, useEffect } from 'react'
import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom'
import { CityProvider } from '@/context/city'
import { I18nProvider } from '@/i18n'
import { Header } from '@/components/Header'
import { Footer } from '@/components/Footer'
import { CookieConsent } from '@/components/CookieConsent'
import { BackToTop } from '@/components/BackToTop'
import { CitySelector } from '@/components/CitySelector'

const HomePage = lazy(() => import('@/pages/HomePage'))
const ServicesPage = lazy(() => import('@/pages/ServicesPage'))
const ConsumerPage = lazy(() => import('@/pages/ConsumerPage'))
const MerchantPage = lazy(() => import('@/pages/MerchantPage'))
const ProviderPage = lazy(() => import('@/pages/ProviderPage'))
const RiderPage = lazy(() => import('@/pages/RiderPage'))
const FaqPage = lazy(() => import('@/pages/FaqPage'))
const SupportPage = lazy(() => import('@/pages/SupportPage'))
const CsrPage = lazy(() => import('@/pages/CsrPage'))
const AboutPage = lazy(() => import('@/pages/AboutPage'))
const LoginPage = lazy(() => import('@/pages/LoginPage'))
const LegalPages = lazy(() => import('@/pages/LegalPages'))
const DownloadPage = lazy(() => import('@/pages/DownloadPage'))

function ScrollToTop() {
  const { pathname } = useLocation()
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior })
  }, [pathname])
  return null
}

export default function App() {
  return (
    <BrowserRouter>
      <I18nProvider>
        <CityProvider>
        <ScrollToTop />
        <div className="min-h-screen bg-paper font-body text-ink-900">
          <a href="#main-content" className="skip-link">
            Skip to main content
          </a>
          <Header />
          <main id="main-content">
            <Suspense
              fallback={
                <div className="grid min-h-[60vh] place-items-center">
                  <div className="flex items-center gap-3">
                    <span className="h-5 w-5 animate-spin rounded-full border-2 border-brand-500 border-t-transparent" />
                    <span className="text-sm font-medium text-ink-500">Loading…</span>
                  </div>
                </div>
              }
            >
              <Routes>
                <Route path="/" element={<HomePage />} />
                <Route path="/services" element={<ServicesPage />} />
                <Route path="/consumer" element={<ConsumerPage />} />
                <Route path="/merchant" element={<MerchantPage />} />
                <Route path="/provider" element={<ProviderPage />} />
                <Route path="/rider" element={<RiderPage />} />
                <Route path="/faq" element={<FaqPage />} />
                <Route path="/support" element={<SupportPage />} />
                <Route path="/csr" element={<CsrPage />} />
                <Route path="/about" element={<AboutPage />} />
                <Route path="/login" element={<LoginPage />} />
                <Route path="/download" element={<DownloadPage />} />
                <Route path="/privacy" element={<LegalPages />} />
                <Route path="/terms" element={<LegalPages />} />
                <Route path="/cookies" element={<LegalPages />} />
                <Route path="*" element={<Navigate to="/" replace />} />
              </Routes>
            </Suspense>
          </main>
          <Footer />
          <CookieConsent />
          <BackToTop />
          <CitySelector />
        </div>
      </CityProvider>
      </I18nProvider>
    </BrowserRouter>
  )
}
