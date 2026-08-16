/* In-memory copilot repository. Mirrors POST /providers/me/copilot/ask against
 * module state in mockState.ts.
 *
 * Canned, rule-based responses keyed by action (explain_job, suggest_quote,
 * recommend_materials, generate_message, summarize_history, plus a generic
 * fallback for the remaining actions) — always with suggestions. Unknown
 * actions throw 422 COPILOT_INVALID_ACTION and the service-level flag
 * copilotAvailable gates everything with 503 COPILOT_UNAVAILABLE.
 */
import { ApiError } from '@/api/client';
import { getState, clone } from './mockState';
import type { CopilotRepository } from '../index';
import type { ProviderCopilot200, ProviderCopilot200Action } from '@hudumika/contract';

const COPILOT_ACTIONS: ProviderCopilot200Action[] = [
  'explain_job',
  'diagnose_photos',
  'suggest_quote',
  'recommend_materials',
  'generate_message',
  'summarize_history',
  'schedule_optimization',
  'predict_travel_time',
  'detect_suspicious_completion',
];

export class MockCopilotRepository implements CopilotRepository {
  async ask(action: string, input: { bookingId?: string; jobSummary?: string; historyMonths?: number }): Promise<ProviderCopilot200> {
    const state = getState();
    if (!state.copilotAvailable) {
      throw new ApiError(503, 'COPILOT_UNAVAILABLE', 'Copilot is currently unavailable');
    }
    if (!COPILOT_ACTIONS.includes(action as ProviderCopilot200Action)) {
      throw new ApiError(422, 'COPILOT_INVALID_ACTION', `Unknown copilot action: ${action}`);
    }
    const serviceName = (serviceId: string) => state.services.find((s) => s.id === serviceId)?.name ?? 'service';
    const booking = input.bookingId ? state.bookings.find((b) => b.id === input.bookingId) : undefined;

    let result = '';
    let suggestions: string[] = [];
    switch (action as ProviderCopilot200Action) {
      case 'explain_job':
        result = booking
          ? `Job ${booking.id} is currently '${booking.status}'. Service: ${serviceName(booking.serviceId)}, scheduled for ${booking.scheduledFor}.${booking.description ? ` Note: ${booking.description}.` : ''}`
          : 'Pick a job from your list and I will break down what to expect before you arrive.';
        suggestions = ['Accept the job early for a better match score', 'Review the customer photos before leaving', 'Confirm the schedule slot with the customer'];
        break;
      case 'suggest_quote':
        result = 'Suggested labor: TZS 30,000–45,000 based on similar jobs in your area';
        suggestions = ['Check the customer questionnaire answers', 'Add trip fee of TZS 5,000', 'Quote valid for 24 hours'];
        break;
      case 'recommend_materials':
        result = 'Common materials for this trade: tap washers (TZS 1,500), PVC pipe (TZS 8,500/m), sealant tape (TZS 2,000), socket outlets (TZS 12,000)';
        suggestions = ['Verify stock in your inventory', 'Order replacements before the job', 'Add parts to the invoice as used'];
        break;
      case 'generate_message':
        result = `Hello! This is ${state.profile.name} from ${state.profile.trade}. I am on my way and will arrive shortly.`;
        suggestions = ['Add the arrival window to the message', 'Ask about parking or access', 'Confirm the exact address'];
        break;
      case 'summarize_history':
        result = `${state.bookings.filter((b) => ['completed', 'settled', 'warranty'].includes(b.status)).length} jobs completed in the last 3 months with an average rating of ${state.profile.rating}. Top trade: ${state.profile.trade}.`;
        suggestions = ['Focus on repeat customers', 'Re-book customers with 5-star history', 'Raise your base rate for high-demand trades'];
        break;
      case 'diagnose_photos':
        result = 'Based on the photos, this looks like a standard repair job. Expect about 60 minutes on site.';
        suggestions = ['Request an extra photo if the fault is unclear', 'Check whether parts are covered by warranty', 'Prepare the quote before arriving'];
        break;
      case 'schedule_optimization':
        result = 'Your busiest window is 10:00–14:00. Consider clustering jobs in the same area to cut travel time.';
        suggestions = ['Group Kinondoni jobs together', 'Leave a 30-minute buffer between visits', 'Offer early-morning slots for offices'];
        break;
      case 'predict_travel_time':
        result = 'Estimated travel time to the job is 15–20 minutes in typical traffic.';
        suggestions = ['Leave 10 minutes earlier during rush hour', 'Use the customer landmark for navigation', 'Confirm parking ahead of time'];
        break;
      case 'detect_suspicious_completion':
        result = 'No suspicious patterns detected. Proof of service and GPS stamp match the booking location.';
        suggestions = ['Keep collecting proof on every job', 'Use the in-app payment link only', 'Report off-platform payment requests'];
        break;
      default:
        result = 'Here is a summary based on your recent activity.';
        suggestions = ['Ask me to explain a specific job', 'Ask me to suggest a quote', 'Ask me to recommend materials'];
    }
    return clone({ action: action as ProviderCopilot200Action, result, suggestions });
  }
}
