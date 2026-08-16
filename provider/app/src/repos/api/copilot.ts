/* Live API copilot repository. Thin typed wrapper over the hardened client.
 *
 * Paths (API-CONTRACT.yaml):
 *   POST /providers/me/copilot → ProviderCopilot200
 */
import { api } from '@/api/client';
import type { CopilotRepository } from '../index';
import type { CopilotRequest, CopilotRequestAction, ProviderCopilot200 } from '@hudumika/contract';

export class ApiCopilotRepository implements CopilotRepository {
  async ask(action: string, input: { bookingId?: string; jobSummary?: string; historyMonths?: number }): Promise<ProviderCopilot200> {
    const body: CopilotRequest = {
      action: action as CopilotRequestAction,
      bookingId: input.bookingId ?? null,
      jobSummary: input.jobSummary ?? null,
      ...(input.historyMonths !== undefined ? { historyMonths: input.historyMonths } : {}),
    };
    return api.post<ProviderCopilot200>('/providers/me/copilot', body);
  }
}
