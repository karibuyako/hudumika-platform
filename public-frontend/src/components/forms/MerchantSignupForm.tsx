import { useState, type FormEvent } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { CheckCircle2 } from 'lucide-react'
import { CITIES } from '@/data/constants'
import { submitLead } from '@/services/api'
import { Field, inputCls } from './Field'

type Form = {
  restaurant: string
  owner: string
  phone: string
  email: string
  city: string
  businessType: string
  outlets: string
  comment: string
}

const EMPTY: Form = {
  restaurant: '',
  owner: '',
  phone: '',
  email: '',
  city: '',
  businessType: '',
  outlets: '1',
  comment: '',
}

const PHONE_RE = /^(\+255|0)(7|6)[0-9]{8}$/
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function MerchantSignupForm() {
  const [form, setForm] = useState<Form>(EMPTY)
  const [errors, setErrors] = useState<Partial<Record<keyof Form, string>>>({})
  const [done, setDone] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  const set = (k: keyof Form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }))

  const validate = () => {
    const errs: Partial<Record<keyof Form, string>> = {}
    if (!form.restaurant.trim()) errs.restaurant = 'Restaurant name is required'
    if (!form.owner.trim()) errs.owner = 'Owner name is required'
    if (!form.phone.trim()) errs.phone = 'Phone number is required'
    else if (!PHONE_RE.test(form.phone.trim())) errs.phone = 'Use format +255 7xx xxx xxx'
    if (!form.email.trim()) errs.email = 'Email is required'
    else if (!EMAIL_RE.test(form.email.trim())) errs.email = 'Enter a valid email address'
    if (!form.city) errs.city = 'Select a city'
    if (!form.businessType) errs.businessType = 'Select a business type'
    const outlets = parseInt(form.outlets)
    if (isNaN(outlets) || outlets < 1) errs.outlets = 'At least 1 outlet'
    return errs
  }

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault()
    const errs = validate()
    setErrors(errs)
    if (Object.keys(errs).length > 0) return
    setSubmitting(true)
    try {
      await submitLead({ type: 'merchant', ...form })
    } catch {
      setErrors({ restaurant: 'We could not submit this application. Please try again.' })
      setSubmitting(false)
      return
    }
    setSubmitting(false)
    setDone(true)
  }

  return (
    <div className="rounded-[28px] bg-surface p-6 shadow-xl shadow-brand-700/5 ring-1 ring-line sm:p-8">
      <AnimatePresence mode="wait">
        {!done ? (
          <motion.div key="form" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <h3 className="text-2xl font-black text-ink-900">Register your business</h3>
            <p className="mt-1 text-sm text-ink-500">
              Approved in 24 hours — our team brings the onboarding and a free tablet.
            </p>
            <form onSubmit={onSubmit} className="mt-6 grid gap-4" noValidate>
              <Field label="Restaurant name *" error={errors.restaurant}>
                <input
                  className={inputCls(errors.restaurant)}
                  placeholder="Mama Asha Pilau"
                  value={form.restaurant}
                  onChange={set('restaurant')}
                  aria-invalid={!!errors.restaurant}
                />
              </Field>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Owner name *" error={errors.owner}>
                  <input
                    className={inputCls(errors.owner)}
                    placeholder="Asha Hassan"
                    value={form.owner}
                    onChange={set('owner')}
                    aria-invalid={!!errors.owner}
                  />
                </Field>
                <Field label="Phone *" error={errors.phone}>
                  <input
                    className={inputCls(errors.phone)}
                    placeholder="+255 7xx xxx xxx"
                    inputMode="tel"
                    value={form.phone}
                    onChange={set('phone')}
                    aria-invalid={!!errors.phone}
                  />
                </Field>
              </div>
              <Field label="Email *" error={errors.email}>
                <input
                  className={inputCls(errors.email)}
                  placeholder="business email"
                  type="email"
                  value={form.email}
                  onChange={set('email')}
                  aria-invalid={!!errors.email}
                />
              </Field>
              <div className="grid gap-4 sm:grid-cols-3">
                <Field label="City *" error={errors.city}>
                  <select className={inputCls(errors.city)} value={form.city} onChange={set('city')} aria-invalid={!!errors.city}>
                    <option value="">Select city</option>
                    {CITIES.map((c) => (
                      <option key={c.id} value={c.name}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Business type *" error={errors.businessType}>
                  <select
                    className={inputCls(errors.businessType)}
                    value={form.businessType}
                    onChange={set('businessType')}
                    aria-invalid={!!errors.businessType}
                  >
                    <option value="">Select type</option>
                    {['Restaurant', 'Grocery', 'Pharmacy', 'Other'].map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Outlets *" error={errors.outlets}>
                  <input
                    className={inputCls(errors.outlets)}
                    type="number"
                    min={1}
                    value={form.outlets}
                    onChange={set('outlets')}
                    aria-invalid={!!errors.outlets}
                  />
                </Field>
              </div>
              <Field label="Comment (optional)">
                <textarea
                  className={inputCls()}
                  rows={3}
                  placeholder="Tell us about your menu, hours or specialities…"
                  value={form.comment}
                  onChange={set('comment')}
                />
              </Field>
              <button
                type="submit"
                className="mt-2 w-full rounded-full bg-brand-500 py-4 text-sm font-black text-white shadow-lg shadow-brand-500/20 transition hover:brightness-105"
              >
                {submitting ? 'Submitting…' : 'Submit Application →'}
              </button>
              <p className="text-center text-xs text-ink-300">
                Free onboarding · No upfront fees · Cancel anytime
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
              Our merchant team will call <span className="font-semibold text-ink-900">{form.owner}</span>{' '}
              within 24 hours to complete onboarding.
            </p>
            <button
              onClick={() => {
                setForm(EMPTY)
                setDone(false)
              }}
              className="mt-6 rounded-full bg-paper px-6 py-3 text-sm font-bold text-ink-900 ring-1 ring-line transition hover:bg-line"
            >
              Register another branch
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
