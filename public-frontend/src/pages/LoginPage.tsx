import { useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { ArrowLeft, Mail, Lock, Eye, EyeOff, Smartphone } from 'lucide-react'
import { motion } from 'framer-motion'
import { usePageMeta } from '@/hooks/usePageMeta'

export default function LoginPage() {
  usePageMeta('/login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPw, setShowPw] = useState(false)
  const [notice, setNotice] = useState(false)

  const onSubmit = (e: FormEvent) => {
    e.preventDefault()
    setNotice(true)
  }

  return (
    <section className="flex min-h-screen items-center justify-center bg-paper px-4 pt-28">
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
        className="w-full max-w-sm"
      >
        <Link
          to="/"
          className="mb-8 inline-flex items-center gap-2 text-sm font-medium text-ink-500 transition-colors hover:text-ink-900"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to home
        </Link>

        <div className="rounded-2xl border border-line bg-surface p-8 shadow-[0_30px_80px_-40px_rgba(16,20,18,0.3)]">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-ink-900">
            <span className="text-lg font-bold text-surface">H</span>
          </div>
          <h1 className="mt-5 font-display text-xl font-bold text-ink-900">Welcome back</h1>
          <p className="mt-1.5 text-sm text-ink-500">Sign in to your HUDumika account</p>

          <form onSubmit={onSubmit} className="mt-7 space-y-4">
            <div>
              <label className="mb-1.5 block text-xs font-medium text-ink-700">Email or phone</label>
              <div className="flex items-center gap-2 rounded-xl border border-line bg-paper px-3.5 py-2.5 transition-colors focus-within:border-brand-500/40">
                <Mail className="h-4 w-4 shrink-0 text-ink-300" />
                <input
                  type="text"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com or +255…"
                  className="w-full bg-transparent text-sm text-ink-900 outline-none placeholder:text-ink-300"
                />
              </div>
            </div>

            <div>
              <label className="mb-1.5 block text-xs font-medium text-ink-700">Password</label>
              <div className="flex items-center gap-2 rounded-xl border border-line bg-paper px-3.5 py-2.5 transition-colors focus-within:border-brand-500/40">
                <Lock className="h-4 w-4 shrink-0 text-ink-300" />
                <input
                  type={showPw ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Enter your password"
                  className="w-full bg-transparent text-sm text-ink-900 outline-none placeholder:text-ink-300"
                />
                <button
                  type="button"
                  onClick={() => setShowPw((v) => !v)}
                  className="shrink-0 text-ink-300 transition-colors hover:text-ink-700"
                  aria-label={showPw ? 'Hide password' : 'Show password'}
                >
                  {showPw ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>

            <div className="flex items-center justify-between text-xs">
              <label className="flex items-center gap-2 text-ink-500">
                <input type="checkbox" className="h-3.5 w-3.5 rounded border-line accent-brand-500" />
                Remember me
              </label>
              <button type="button" onClick={() => setNotice(true)} className="font-medium text-brand-600 transition-colors hover:text-brand-700">
                Forgot password?
              </button>
            </div>

            <button
              type="submit"
              className="w-full rounded-full bg-ink-900 py-2.5 text-sm font-semibold text-surface transition-colors hover:bg-brand-600"
            >
              Sign in
            </button>
          </form>

          {notice && (
            <motion.p
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              className="mt-4 rounded-xl bg-brand-50 p-3 text-center text-xs font-medium text-brand-600"
            >
              Authentication is coming soon — this is a preview build.
            </motion.p>
          )}

          <div className="mt-6 border-t border-line pt-5 text-center text-xs text-ink-500">
            <p>Use the app for one-tap sign in</p>
            <button
              type="button"
              disabled
              className="mt-2 inline-flex items-center gap-1.5 font-semibold text-brand-600 transition-colors hover:text-brand-700"
            >
              <Smartphone className="h-3.5 w-3.5" />
              Get the HUDumika app
            </button>
          </div>

          <div className="mt-5 text-center text-xs text-ink-500">
            Don't have an account?{' '}
            <button type="button" onClick={() => setNotice(true)} className="font-semibold text-brand-600 transition-colors hover:text-brand-700">
              Sign up
            </button>
          </div>
        </div>
      </motion.div>
    </section>
  )
}
