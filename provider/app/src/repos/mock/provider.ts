/* In-memory provider profile repository. Mirrors GET /providers/me,
 * POST /providers/me/application, PATCH /providers/me and
 * GET /providers/me/capabilities against module state in mockState.ts.
 *
 * The profile is seeded verification 'approved' so the app unlocks all tabs;
 * apply() flattens the onboarding payload into the profile, sets verification
 * 'pending' and schedules the mock platform decision (default 'approved', see
 * verificationDecision in mockState) — the demo makes onboarding feel real.
 * ProviderPrivate has no city field, so the application city/serviceArea is
 * stored in serviceAreas.
 */
import { getState, clone, scheduleVerificationDecision } from './mockState';
import type { ProviderRepository } from '../index';
import type { ListProviderCapabilities200, ProviderApplication, ProviderPrivate, ProviderUpdate } from '@hudumika/contract';

const DECISION_DELAY_MS = 8000;

export class MockProviderRepository implements ProviderRepository {
  async getProfile(): Promise<ProviderPrivate> {
    return clone(getState().profile);
  }

  async apply(payload: ProviderApplication): Promise<{ status: 'submitted' | 'under_review' }> {
    const state = getState();
    state.profile.name = payload.name;
    state.profile.trade = payload.trade;
    state.profile.serviceAreas = payload.serviceArea ? [payload.serviceArea] : [payload.city];
    if (payload.bio) state.profile.bio = payload.bio;
    state.profile.verification = 'pending';
    // Platform review (mock decision) — approval unlocks the tabs.
    scheduleVerificationDecision(DECISION_DELAY_MS);
    return { status: 'submitted' };
  }

  async updateProfile(patch: ProviderUpdate): Promise<ProviderPrivate> {
    const state = getState();
    Object.assign(state.profile, patch);
    // Resubmit loop: changes_requested → back into document review.
    if (state.profile.verification === 'changes_requested') {
      state.profile.verification = 'documents_review';
    }
    return clone(state.profile);
  }

  async getCapabilities(): Promise<ListProviderCapabilities200> {
    return { capabilities: clone(getState().capabilities) };
  }
}
