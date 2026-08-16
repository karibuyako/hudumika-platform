/* Live API finance repository — GET /finance/invoices, GET /finance/invoices/{id},
 * GET /finance/invoices/{id}/download (contract listInvoices / getInvoice /
 * downloadInvoice — generated, READ-ONLY). */
import { api } from '@/api/client';
import type { DownloadInvoice200, Invoice } from '@hudumika/contract';
import type { FinanceRepository } from '../index';

export class ApiFinanceRepository implements FinanceRepository {
  async listInvoices(): Promise<Invoice[]> {
    return api.get<Invoice[]>('/finance/invoices');
  }

  async getInvoice(invoiceId: string): Promise<Invoice> {
    return api.get<Invoice>(`/finance/invoices/${invoiceId}`);
  }

  async downloadInvoice(invoiceId: string): Promise<DownloadInvoice200> {
    return api.get<DownloadInvoice200>(`/finance/invoices/${invoiceId}/download`);
  }
}
