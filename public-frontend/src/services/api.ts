import { applyMerchant, listServices } from '@hudumika/contract'
import type { MerchantApplication, Service } from '@hudumika/contract'

/**
 * Contract-first API layer for the public marketing site.
 * Paths are relative per docs/API-BASE-CONVENTION.md — `API_BASE` is origin ("")
 * for web, the gateway terminates `/api/v1`.
 * Mocks are enabled via `VITE_USE_MOCKS !== 'false'` in dev (see src/main.tsx).
 */

function normalizeBusinessType(raw: unknown): MerchantApplication['businessType'] {
  const v = String(raw ?? '').toLowerCase()
  if (v === 'restaurant') return 'restaurant'
  if (v === 'shop') return 'shop'
  if (v === 'grocery' || v === 'groceries') return 'grocery'
  if (v === 'pharmacy') return 'pharmacy'
  if (v === 'retail' || v === 'shopping') return 'retail'
  if (v === 'tickets' || v === 'events') return 'tickets'
  return 'other'
}

function toMerchantApplication(payload: Record<string, unknown>): MerchantApplication {
  const businessName = String(
    payload.restaurant ?? payload.businessName ?? payload.name ?? payload.owner ?? 'Lead',
  ).trim() || 'Lead'

  const contactPhone = String(payload.phone ?? payload.contactPhone ?? '').trim()
  const contactEmailRaw = payload.email ?? payload.contactEmail
  const contactEmail = typeof contactEmailRaw === 'string' && contactEmailRaw.trim() ? contactEmailRaw.trim() : undefined

  const city = String(payload.city ?? 'Dar es Salaam').trim() || 'Dar es Salaam'

  const businessType = normalizeBusinessType(payload.businessType ?? payload.trade ?? payload.type)

  const descriptionRaw = payload.comment ?? payload.bio ?? payload.message ?? payload.description
  const description = typeof descriptionRaw === 'string' && descriptionRaw.trim() ? descriptionRaw.trim().slice(0, 2000) : undefined

  return {
    businessName,
    contactPhone,
    ...(contactEmail ? { contactEmail } : {}),
    city,
    businessType,
    ...(description ? { description } : {}),
  }
}

export async function submitLead(payload: Record<string, unknown>) {
  const application = toMerchantApplication(payload)
  const res = await applyMerchant(application)
  if (res.status !== 201) throw new Error('Lead submission failed')
  return res.data
}

export async function fetchServices(): Promise<Service[]> {
  const res = await listServices()
  if (res.status !== 200) throw new Error('Service catalog unavailable')
  return res.data
}
