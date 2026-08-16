import { useState, type FormEvent } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { CheckCircle2 } from 'lucide-react'
import { CITIES } from '@/data/constants'
import { submitLead } from '@/services/api'
import { cn } from '@/utils/cn'
import { Field, inputCls } from './Field'

type Form = {
  name: string
  phone: string
  city: string
  vehicle: string
  availability: string
  referral: string
}

const EMPTY: Form = {
  name: '',
  phone: '',
  city: '',
  vehicle: '',
  availability: '',
  referral: '',
}

const VEHICLES = ['Boda (Piki)', 'Bicycle', 'Gari / Bajaji']
const PHONE_RE = /^(\+255|0)(7|6)[0-9]{8}$/

export function RiderSignupForm() {
  const [form, setForm] = useState<Form>(EMPTY)
  const [errors, setErrors] = useState<Partial<Record<keyof Form, string>>>({})
  const [done, setDone] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  const set = (k: keyof Form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }))

  const validate = () => {
    const errs: Partial<Record<keyof Form, string>> = {}
    if (!form.name.trim()) errs.name = 'Full name is required'
    if (!form.phone.trim()) errs.phone = 'Phone number is required'
    else if (!PHONE_RE.test(form.phone.trim())) errs.phone = 'Use format +255 7xx xxx xxx'
    if (!form.city) errs.city = 'Select a city'
    if (!form.vehicle) errs.vehicle = 'Select your vehicle'
    if (!form.availability) errs.availability = 'Select availability'
    return errs
  }

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault()
    const errs = validate()
    setErrors(errs)
    if (Object.keys(errs).length > 0) return
    setSubmitting(true)
    try {
      await submitLead({ type: 'rider', ...form })
    } catch {
      setErrors({ name: 'We could not submit this application. Please try again.' })
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
            <h3 className="text-2xl font-black text-ink-900">Apply in 2 minutes</h3>
            <p className="mt-1 text-sm text-ink-500">
              Fill your details — our team calls within 24 hours.
            </p>
            <form onSubmit={onSubmit} className="mt-6 grid gap-4" noValidate>
              <Field label="Full name *" error={errors.name}>
                <input
                  className={inputCls(errors.name)}
                  placeholder="Juma Hassan"
                  value={form.name}
                  onChange={set('name')}
                  aria-invalid={!!errors.name}
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
                    aria-invalid={!!errors.phone}
                  />
                </Field>
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
              </div>
              <Field label="Vehicle *" error={errors.vehicle}>
                <div className="grid grid-cols-3 gap-2">
                  {VEHICLES.map((v) => (
                    <label
                      key={v}
                      className={cn(
                        'cursor-pointer rounded-[14px] bg-paper p-3 text-center text-sm font-bold ring-1 ring-line transition',
                        form.vehicle === v
                          ? 'bg-ink-900 text-white ring-ink-900'
                          : 'ring-line hover:ring-brand-400',
                      )}
                    >
                      <input
                        type="radio"
                        name="vehicle"
                        className="sr-only"
                        checked={form.vehicle === v}
                        onChange={() => setForm((f) => ({ ...f, vehicle: v }))}
                      />
                      {v}
                    </label>
                  ))}
                </div>
              </Field>
              <Field label="Availability *" error={errors.availability}>
                <select
                  className={inputCls(errors.availability)}
                  value={form.availability}
                  onChange={set('availability')}
                  aria-invalid={!!errors.availability}
                >
                  <option value="">Select availability</option>
                  {['Full-time', 'Part-time', 'Weekends only'].map((a) => (
                    <option key={a} value={a}>
                      {a}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Referral code (optional)">
                <input
                  className={inputCls()}
                  placeholder="HUD-XXXX"
                  value={form.referral}
                  onChange={set('referral')}
                />
              </Field>
              <button
                type="submit"
                className="mt-2 w-full rounded-full bg-ink-900 py-4 text-sm font-black text-white shadow-lg transition hover:bg-black"
              >
                {submitting ? 'Submitting…' : 'Submit Application →'}
              </button>
              <p className="text-center text-xs text-ink-300">
                By applying you agree to the HUDumika Rider Terms & Privacy.
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
              className="mx-auto grid h-16 w-16 place-items-center rounded-full bg-emerald-500 text-white"
            >
              <CheckCircle2 className="h-8 w-8" />
            </motion.div>
            <h3 className="mt-4 text-2xl font-black text-ink-900">Hongera! Application received</h3>
            <p className="mt-2 text-sm text-ink-500">
              Our onboarding team will call{' '}
              <span className="font-semibold text-ink-900">{form.name}</span> within 24 hours. Check
              your phone for SMS verification.
            </p>
            <button
              onClick={() => {
                setForm(EMPTY)
                setDone(false)
              }}
              className="mt-6 rounded-full bg-paper px-6 py-3 text-sm font-bold text-ink-900 ring-1 ring-line transition hover:bg-line"
            >
              Submit another
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
