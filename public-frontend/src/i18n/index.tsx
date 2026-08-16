import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { DICTIONARIES, type Language, type MessageKey } from './dictionaries'

type I18nCtx = {
  lang: Language
  setLang: (lang: Language) => void
  t: (key: MessageKey, vars?: Record<string, string>) => string
}

const Ctx = createContext<I18nCtx | null>(null)

const LANG_KEY = 'hudumika.lang'

const LANGS: Language[] = ['en', 'sw', 'ar', 'fr']

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLang] = useState<Language>(() => {
    const saved = typeof localStorage !== 'undefined' ? localStorage.getItem(LANG_KEY) : null
    return LANGS.includes(saved as Language) ? (saved as Language) : 'en'
  })

  useEffect(() => {
    localStorage.setItem(LANG_KEY, lang)
    document.documentElement.lang = lang
    document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr'
  }, [lang])

  const t = (key: MessageKey, vars?: Record<string, string>) => {
    let text = DICTIONARIES[lang][key]
    if (vars) {
      for (const [k, v] of Object.entries(vars)) {
        text = text.replace(`{${k}}`, v)
      }
    }
    return text
  }

  return <Ctx.Provider value={{ lang, setLang, t }}>{children}</Ctx.Provider>
}

export function useI18n() {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useI18n must be used within I18nProvider')
  return ctx
}
