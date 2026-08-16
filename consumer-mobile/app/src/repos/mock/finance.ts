/* In-memory finance repository — GET /finance/invoices, GET
 * /finance/invoices/{id}, GET /finance/invoices/{id}/download (contract
 * listInvoices / getInvoice / downloadInvoice — generated, READ-ONLY).
 *
 * Seeds are module-local (the invoice list belongs to the finance surface,
 * not the shared order/booking state): three invoices for the demo customer —
 * one issued VAT invoice for a seeded order, one paid invoice for a seeded
 * booking, one requested invoice. The invoice seeds reference the real
 * order/booking ids (ord_active_001 / bk_active_001) through the contract's
 * free-form buyerDetails map: the Invoice model carries no orderId/bookingId,
 * so the reference rides buyerDetails (mock-only until the contract ships a
 * reference field — the screen renders it as the card's reference label).
 *
 * downloadInvoice returns the contract DownloadInvoice200 shape
 * ({downloadUrl, expiresInSeconds}); production serves a signed PDF URL, the
 * mock serves a stub document URL.
 */
import { ApiError } from '@/api/client';
import { clone } from './mockState';
import type { DownloadInvoice200, Invoice } from '@hudumika/contract';
import type { FinanceRepository } from '../index';

/** Stub document URL — production serves real signed PDFs via the contract
 * DownloadInvoice200.downloadUrl; the mock keeps the same shape. */
function stubDownloadUrl(number: string): string {
  return `https://cdn.hudumika.co.tz/invoices/${number}.pdf`;
}

/** Seeded invoices — newest first (listInvoices returns them as-is). */
const SEEDED_INVOICES: Invoice[] = [
  {
    id: 'inv_001',
    number: 'INV-2026-0142',
    amountTZS: 27300,
    kind: 'vat',
    taxRateBps: 1800,
    taxAmountTZS: 4169,
    taxId: 'TZ-104-229-877',
    status: 'issued',
    buyerDetails: { name: 'Demo Customer', phone: '+255700000000', orderId: 'ord_active_001' },
    periodFrom: '2026-08-01',
    periodTo: '2026-08-31',
    createdAt: '2026-08-14T09:30:00.000Z',
    issuedAt: '2026-08-14T09:31:00.000Z',
  },
  {
    id: 'inv_002',
    number: 'INV-2026-0103',
    amountTZS: 65000,
    kind: 'standard',
    taxRateBps: null,
    taxAmountTZS: null,
    taxId: null,
    status: 'paid',
    buyerDetails: { name: 'Demo Customer', phone: '+255700000000', bookingId: 'bk_active_001' },
    periodFrom: null,
    periodTo: null,
    createdAt: '2026-07-28T15:05:00.000Z',
    issuedAt: '2026-07-28T15:06:00.000Z',
  },
  {
    id: 'inv_003',
    number: 'INV-2026-0089',
    amountTZS: 12300,
    kind: 'vat',
    taxRateBps: 1800,
    taxAmountTZS: 1877,
    taxId: 'TZ-104-229-877',
    status: 'requested',
    buyerDetails: { name: 'Demo Customer', phone: '+255700000000' },
    periodFrom: '2026-06-01',
    periodTo: '2026-06-30',
    createdAt: '2026-07-02T11:20:00.000Z',
    issuedAt: null,
  },
];

function findSeed(invoiceId: string): Invoice {
  const seed = SEEDED_INVOICES.find((i) => i.id === invoiceId);
  if (!seed) throw new ApiError(404, 'INVOICE_NOT_FOUND', `Invoice ${invoiceId} not found`);
  return seed;
}

export class MockFinanceRepository implements FinanceRepository {
  async listInvoices(): Promise<Invoice[]> {
    return clone(SEEDED_INVOICES);
  }

  async getInvoice(invoiceId: string): Promise<Invoice> {
    return clone(findSeed(invoiceId));
  }

  async downloadInvoice(invoiceId: string): Promise<DownloadInvoice200> {
    const seed = findSeed(invoiceId);
    return clone({ downloadUrl: stubDownloadUrl(seed.number), expiresInSeconds: 900 });
  }
}
