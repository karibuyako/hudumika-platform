import { useState, type FormEvent } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { CheckCircle2 } from 'lucide-react'
import { CITIES, PROVIDER_CATEGORIES } from '@/data/constants'
import { submitLead } from '@/services/api'
import { cn } from '@/utils/cn'
import { Field, inputCls } from './Field'

type Form = {
  name: string
  phone: string
  city: string
  trade: string
  experience: string
  bio: string
}

const EMPTY: Form = { name: '', phone: '', city: '', trade: '', experience: '', bio: '' }
const PHONE_RE = /^(\+255|0)(7|6)[0-9]{8}$/

export function ProviderSignupForm() {
  const [form, setForm] = useState<Form>(EMPTY)
  const [errors, setErrors] = useState<Partial<Record<keyof Form, string>>>({})
  const [done, setDone] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  const set =
    (k: keyof Form) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
      setForm((f) => ({ ...f, [k]: e.target.value }))

  const validate = () => {
    const errs: Partial<Record<keyof Form, string>> = {}
    if (!form.name.trim()) errs.name = 'Full name is required'
    if (!form.phone.trim()) errs.phone = 'Phone number is required'
    else if (!PHONE_RE.test(form.phone.trim())) errs.phone = 'Use format +255 7xx xxx xxx'
    if (!form.city) errs.city = 'Select a city'
    if (!form.trade) errs.trade = 'Select your trade'
    if (!form.experience) errs.experience = 'Select experience'
    return errs
  }

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault()
    const errs = validate()
    setErrors(errs)
    if (Object.keys(errs).length > 0) return
    setSubmitting(true)
    try {
      await submitLead({ type: 'provider', ...form })
    } catch {
      setErrors({ name: 'We could not submit this application. Please try again.' })
      setSubmitting(false)
      return
    }
    setSubmitting(false)
    setDone(true)
  }

  return (
    <div className="rounded-[28px] bg-white p-6 shadow-xl shadow-black/5 ring-1 ring-line sm:p-8">
      <AnimatePresence mode="wait">
        {!done ? (
          <motion.div key="form" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <h3 className="text-2xl font-black text-ink-900">Apply in 3 minutes</h3>
            <p className="mt-1 text-sm text-ink-500">
              Tell us about your trade — our team calls within 24 hours to complete verification.
            </p>
            <form onSubmit={onSubmit} className="mt-6 grid gap-4" noValidate>
              <Field label="Full name *" error={errors.name}>
                <input
                  className={inputCls(errors.name)}
                  placeholder="Juma Hassan"
                  value={form.name}
                  onChange={set('name')}
                />
              </Field>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Phone *" error={errors.phone}>
                  <input
                    className={inputCls(errors.phone)}
                    placeholder="+255 7xx xxx xxx"
                    inputMode="tel"
                    value={form.phone}
                    onChange={set('phone')}
                  />
                </Field>
                <Field label="City *" error={errors.city}>
                  <select className={inputCls(errors.city)} value={form.city} onChange={set('city')}>
                    <option value="">Select city</option>
                    {CITIES.map((c) => (
                      <option key={c.id} value={c.name}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Trade *" error={errors.trade}>
                  <select className={inputCls(errors.trade)} value={form.trade} onChange={set('trade')}>
                    <option value="">Select trade</option>
                    {PROVIDER_CATEGORIES.map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Experience *" error={errors.experience}>
                  <select className={inputCls(errors.experience)} value={form.experience} onChange={set('experience')}>
                    <option value="">Select experience</option>
                    {['Less than 1 year', '1-3 years', '3-5 years', '5+ years'].map((x) => (
                      <option key={x} value={x}>
                        {x}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>
              <Field label="About your work (optional)" hint="A short bio customers will see on your profile.">
                <textarea
                  className={cn(inputCls(), 'resize-none')}
                  rows={3}
                  placeholder="e.g. Licensed electrician, 5 years experience, same-day service…"
                  value={form.bio}
                  onChange={set('bio')}
                />
              </Field>
              <button
                type="submit"
                className="mt-2 w-full rounded-full bg-brand-500 py-4 text-sm font-black text-white shadow-lg shadow-brand-500/20 transition hover:brightness-105"
              >
                {submitting ? 'Submitting…' : 'Submit Application →'}
              </button>
              <p className="text-center text-xs text-ink-500">
                Free to join · No upfront fees · Cancel anytime
              </p>
            </form>
          </motion.div>
        ) : (
          <motion.div
            key="success"
            initial={{ opacity: 0, scale: 0.96 }}
            animate={{ opacity: 1, scale: 1 }}
            className="py-10 text-center"
          >
            <motion.div
              initial={{ scale: 0 }}
              animate={{ scale: 1 }}
              transition={{ type: 'spring', stiffness: 300, damping: 18, delay: 0.1 }}
              className="mx-auto grid h-16 w-16 place-items-center rounded-full bg-brand-500 text-white"
            >
              <CheckCircle2 className="h-8 w-8" />
            </motion.div>
            <h3 className="mt-4 text-2xl font-black text-ink-900">Asante! Application received</h3>
            <p className="mt-2 text-sm text-ink-500">
              Our provider team will call <span className="font-semibold text-ink-900">{form.name}</span>{' '}
              within 24 hours to complete verification.
            </p>
            <button
              onClick={() => {
                setForm(EMPTY)
                setDone(false)
              }}
              className="mt-6 rounded-full bg-paper px-6 py-3 text-sm font-bold text-ink-900 ring-1 ring-line transition hover:bg-line"
            >
              Submit another application
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
