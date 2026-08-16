import { useState, type FormEvent } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { CheckCircle2 } from 'lucide-react'
import { Field, inputCls } from './Field'
import { submitLead } from '@/services/api'

type Form = { name: string; email: string; topic: string; message: string }
const EMPTY: Form = { name: '', email: '', topic: '', message: '' }
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function FeedbackForm() {
  const [form, setForm] = useState<Form>(EMPTY)
  const [errors, setErrors] = useState<Partial<Record<keyof Form, string>>>({})
  const [done, setDone] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  const set =
    (k: keyof Form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
      setForm((f) => ({ ...f, [k]: e.target.value }))

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault()
    const errs: Partial<Record<keyof Form, string>> = {}
    if (!form.name.trim()) errs.name = 'Name is required'
    if (!form.email.trim()) errs.email = 'Email is required'
    else if (!EMAIL_RE.test(form.email.trim())) errs.email = 'Enter a valid email'
    if (!form.topic) errs.topic = 'Select a topic'
    if (!form.message.trim() || form.message.trim().length < 10)
      errs.message = 'Message must be at least 10 characters'
    setErrors(errs)
    if (Object.keys(errs).length > 0) return
    setSubmitting(true)
    try {
      await submitLead({ type: 'feedback', ...form })
    } catch {
      setErrors({ message: 'We could not send this message. Please try again.' })
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
            <h3 className="text-2xl font-black text-ink-900">Send us feedback</h3>
            <p className="mt-1 text-sm text-ink-500">We reply within one business day.</p>
            <form onSubmit={onSubmit} className="mt-6 grid gap-4" noValidate>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Name *" error={errors.name}>
                  <input
                    className={inputCls(errors.name)}
                    placeholder="Your name"
                    value={form.name}
                    onChange={set('name')}
                    aria-invalid={!!errors.name}
                  />
                </Field>
                <Field label="Email *" error={errors.email}>
                  <input
                    className={inputCls(errors.email)}
                    placeholder="you@example.com"
                    type="email"
                    value={form.email}
                    onChange={set('email')}
                    aria-invalid={!!errors.email}
                  />
                </Field>
              </div>
              <Field label="Topic *" error={errors.topic}>
                <select
                  className={inputCls(errors.topic)}
                  value={form.topic}
                  onChange={set('topic')}
                  aria-invalid={!!errors.topic}
                >
                  <option value="">Select topic</option>
                  {['Order', 'Merchant', 'Rider', 'Other'].map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Message *" error={errors.message}>
                <textarea
                  className={inputCls(errors.message)}
                  rows={4}
                  placeholder="Tell us what happened…"
                  value={form.message}
                  onChange={set('message')}
                  aria-invalid={!!errors.message}
                />
              </Field>
              <button
                type="submit"
                className="mt-2 w-full rounded-full bg-ink-900 py-4 text-sm font-black text-white transition hover:bg-black"
              >
                {submitting ? 'Sending…' : 'Send Feedback →'}
              </button>
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
            <h3 className="mt-4 text-2xl font-black text-ink-900">Asante! Message received</h3>
            <p className="mt-2 text-sm text-ink-500">
              We have your note and will reply to <span className="font-semibold">{form.email}</span>{' '}
              within one business day.
            </p>
            <button
              onClick={() => {
                setForm(EMPTY)
                setDone(false)
              }}
              className="mt-6 rounded-full bg-paper px-6 py-3 text-sm font-bold text-ink-900 ring-1 ring-line transition hover:bg-line"
            >
              Send another
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
