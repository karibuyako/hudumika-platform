
import { http } from 'msw';
import type { MerchantDevice, MerchantDeviceInput } from '@/api/types';
import { db, uid } from '@/mock/db';
import { emit } from '@/mock/events';
import { ApiHttpError, audit, json, ok, requirePerm, requireSession } from '@/mock/security';
import { h, readJson } from '@/mock/handlers/common';

const BASE = typeof location !== 'undefined' ? location.origin : 'http://localhost';

/** Device rows are scoped to the merchant server-side; responses strip it. */
type MerchantDeviceRow = MerchantDevice & { merchantId: string };

/** Raw JSON body — the shared `ok()` spreads objects, so array responses go through here. */
const raw = (body: unknown, status = 200) => Response.json(body, { status });

/** 204 — no body allowed. */
const noContent = () => new Response(null, { status: 204 });

const DEVICE_TYPES: readonly MerchantDevice['type'][] = ['printer', 'pos', 'kitchen_display', 'cashier_terminal'];
const DEVICE_STATUSES: readonly MerchantDevice['status'][] = ['online', 'offline', 'error', 'pairing'];
const PURPOSES: readonly MerchantDevice['purpose'][] = ['receipt', 'kitchen'];
const PAPER_SIZES: readonly MerchantDevice['paperSize'][] = ['58mm', '80mm'];

/** DELETE wrapper — same error filter as the shared `h` helpers in handlers/common.ts. */
function del(
  path: string,
  fn: (args: { request: Request; params: Record<string, string> }) => Promise<Response> | Response,
) {
  return http.delete(`${BASE}${path}`, async (info) => {
    try {
      return await fn({ request: info.request, params: (info.params ?? {}) as Record<string, string> });
    } catch (e) {
      if (e instanceof ApiHttpError) {
        return json(e.status, { error: { code: e.code, message: e.message, retriable: e.retriable, details: e.details } });
      }
      throw e;
    }
  });
}

/** Validate the client-supplied device fields (contract MerchantDevice minus id/status/lastSeenAt). */
function parseDeviceInput(body: Record<string, unknown>): MerchantDeviceInput {
  const type = DEVICE_TYPES.find((t) => t === body.type);
  if (!type) throw new ApiHttpError(400, 'INVALID_DEVICE_TYPE', 'type must be printer, pos, kitchen_display or cashier_terminal');
  const label = String(body.label ?? '').trim();
  if (!label) throw new ApiHttpError(400, 'LABEL_REQUIRED', 'label is required');
  if (label.length > 80) throw new ApiHttpError(400, 'LABEL_TOO_LONG', 'label must be 80 characters or fewer');
  const purpose = body.purpose === undefined ? 'receipt' : PURPOSES.find((p) => p === body.purpose);
  if (body.purpose !== undefined && !purpose) throw new ApiHttpError(400, 'INVALID_PURPOSE', 'purpose must be receipt or kitchen');
  const paperSize = body.paperSize === undefined ? '80mm' : PAPER_SIZES.find((p) => p === body.paperSize);
  if (body.paperSize !== undefined && !paperSize) throw new ApiHttpError(400, 'INVALID_PAPER_SIZE', 'paperSize must be 58mm or 80mm');
  let copies = 1;
  if (body.copies !== undefined) {
    copies = Number(body.copies);
    if (!Number.isInteger(copies) || copies < 1 || copies > 5) {
      throw new ApiHttpError(400, 'INVALID_COPIES', 'copies must be an integer between 1 and 5');
    }
  }
  const settings = body.settings === undefined ? undefined : (body.settings as Record<string, unknown>);
  return { type, label, purpose, paperSize, copies, settings };
}

export const deviceHandlers = [
  /* ---- Device registry (P6d, contract /devices) ---- */
  h.get('/api/devices', ({ request }) => {
    const session = requireSession(request);
    const list = db.table<MerchantDeviceRow>('devices').where((d) => d.merchantId === session.merchantId).sort((a, b) => a.label.localeCompare(b.label));
    return raw(list.map(({ merchantId: _m, ...d }) => d));
  }),

  h.post('/api/devices', async ({ request }) => {
    const session = requireSession(request);
    requirePerm(session, 'store:manage');
    const body = await readJson(request);
    const input = parseDeviceInput(body);
    const existing = db.table<MerchantDeviceRow>('devices').where(
      (d) => d.merchantId === session.merchantId && d.type === input.type && d.label.toLowerCase() === input.label.toLowerCase(),
    );
    if (existing.length) throw new ApiHttpError(409, 'DEVICE_EXISTS', 'A device with this type and label is already registered');
    const device: MerchantDeviceRow = {
      id: uid('dev'),
      merchantId: session.merchantId,
      ...input,
      status: 'pairing',
      lastSeenAt: null,
    };
    db.table<MerchantDeviceRow>('devices').insert(device);
    audit(session.merchantId, session.staffId, session.role, 'devices:register', 'device', device.id, `registered ${device.type} "${device.label}"`);
    emit({ type: 'devices.registered', device, at: Date.now() });
    return json(201, { id: device.id, type: device.type, label: device.label, purpose: device.purpose, paperSize: device.paperSize, copies: device.copies, status: device.status, settings: device.settings, lastSeenAt: device.lastSeenAt });
  }),

  h.patch('/api/devices/:id', async ({ request, params }) => {
    const session = requireSession(request);
    requirePerm(session, 'store:manage');
    const device = db.table<MerchantDeviceRow>('devices').find(String(params.id));
    if (!device || device.merchantId !== session.merchantId) throw new ApiHttpError(404, 'DEVICE_NOT_FOUND', 'Device not found');
    const body = await readJson(request);
    const input = parseDeviceInput(body);
    const clash = db.table<MerchantDeviceRow>('devices').where(
      (d) => d.id !== device.id && d.merchantId === session.merchantId && d.type === input.type && d.label.toLowerCase() === input.label.toLowerCase(),
    );
    if (clash.length) throw new ApiHttpError(409, 'DEVICE_EXISTS', 'A device with this type and label is already registered');
    const updated = db.table<MerchantDeviceRow>('devices').update(device.id, {
      type: input.type,
      label: input.label,
      purpose: input.purpose,
      paperSize: input.paperSize,
      copies: input.copies,
      settings: input.settings,
    })!;
    audit(session.merchantId, session.staffId, session.role, 'devices:update', 'device', device.id, `updated ${updated.type} "${updated.label}"`);
    emit({ type: 'devices.updated', device: updated, at: Date.now() });
    return ok({ id: updated.id, type: updated.type, label: updated.label, purpose: updated.purpose, paperSize: updated.paperSize, copies: updated.copies, status: updated.status, settings: updated.settings, lastSeenAt: updated.lastSeenAt });
  }),

  del('/api/devices/:id', ({ request, params }) => {
    const session = requireSession(request);
    requirePerm(session, 'store:manage');
    const device = db.table<MerchantDeviceRow>('devices').find(String(params.id));
    if (!device || device.merchantId !== session.merchantId) throw new ApiHttpError(404, 'DEVICE_NOT_FOUND', 'Device not found');
    db.table<MerchantDeviceRow>('devices').remove(device.id);
    audit(session.merchantId, session.staffId, session.role, 'devices:unregister', 'device', device.id, `unregistered ${device.type} "${device.label}"`);
    emit({ type: 'devices.unregistered', deviceId: device.id, at: Date.now() });
    return noContent();
  }),
];

/* Device statuses seeded/derived server-side (heartbeats) — the UI renders them read-only. */
export const DEVICE_STATUSES_ORDER: readonly MerchantDevice['status'][] = DEVICE_STATUSES;
