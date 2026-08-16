/* In-memory providers repository — GET /services, /providers, /providers/{id}. */
import { getState, clone } from './mockState';
import type { ProvidersRepository } from '../index';
import type { ProviderPublic, ServiceCategoryConfig, ServiceQuestion } from '@hudumika/contract';
import { ApiError } from '@/api/client';

const SERVICE_CATEGORIES: ServiceCategoryConfig[] = [
  { id: 'svc_001', name: 'Plumbing', pricingModel: 'hourly', defaultDurationMinutes: 60, cancellationRules: 'Free cancellation up to 2 hours before the slot' },
  { id: 'svc_002', name: 'Electrical', pricingModel: 'hourly', defaultDurationMinutes: 60, cancellationRules: 'Free cancellation up to 2 hours before the slot' },
  { id: 'svc_003', name: 'Cleaning', pricingModel: 'quote', defaultDurationMinutes: 120, cancellationRules: 'Free cancellation up to 2 hours before the slot' },
];

/* Deterministic questionnaire per service category (GET /service-categories/{id}/questions).
 * Types come from ServiceQuestionType — only contract enum values. */
const SERVICE_QUESTIONS_BY_CATEGORY: Record<string, ServiceQuestion[]> = {
  svc_001: [
    { key: 'issue', label: 'What is the problem?', type: 'single_choice', required: true, options: ['Leak', 'Blockage', 'Other'] },
    { key: 'location', label: 'Where is it located?', type: 'single_choice', options: ['Kitchen', 'Bathroom', 'Outdoor', 'Other'] },
    { key: 'photos', label: 'Photos of the problem', type: 'photo', required: true },
    { key: 'urgency', label: 'How urgent is this?', type: 'single_choice', options: ['Emergency', 'Today', 'Scheduled'] },
  ],
  svc_002: [
    { key: 'issue', label: 'What is the problem?', type: 'single_choice', required: true, options: ['No power', 'Circuit breaker trips', 'Faulty appliance', 'Other'] },
    { key: 'urgency', label: 'How urgent is this?', type: 'single_choice', options: ['Emergency', 'Today', 'Scheduled'] },
  ],
  svc_003: [
    { key: 'scope', label: 'Which areas need cleaning?', type: 'multi_choice', required: true, options: ['Kitchen', 'Bathroom', 'Bedrooms', 'Living room'] },
    { key: 'urgency', label: 'How urgent is this?', type: 'single_choice', options: ['Today', 'Tomorrow', 'This week'] },
  ],
};

export class MockProvidersRepository implements ProvidersRepository {
  async listServices(params?: { cityId?: string; category?: string }): Promise<ServiceCategoryConfig[]> {
    let list = SERVICE_CATEGORIES;
    if (params?.category) list = list.filter((s) => s.name.toLowerCase() === (params.category as string).toLowerCase());
    return clone(list);
  }

  async getQuestions(serviceCategoryId: string): Promise<ServiceQuestion[]> {
    const known = SERVICE_CATEGORIES.some((s) => s.id === serviceCategoryId);
    if (!known) throw new ApiError(404, 'SERVICE_NOT_FOUND', `Service category ${serviceCategoryId} not found`);
    return clone(SERVICE_QUESTIONS_BY_CATEGORY[serviceCategoryId] ?? []);
  }

  async list(params?: { cityId?: string; trade?: string; cursor?: string; limit?: number }): Promise<ProviderPublic[]> {
    const state = getState();
    let list = state.home.providers ?? [];
    if (params?.trade) list = list.filter((p) => p.trade.toLowerCase().includes((params.trade as string).toLowerCase()));
    const offset = params?.cursor ? Number(params.cursor) : 0;
    const limit = params?.limit ?? 20;
    return clone(list.slice(offset, offset + limit));
  }

  async get(providerId: string): Promise<ProviderPublic> {
    const provider = (getState().home.providers ?? []).find((p) => p.id === providerId);
    if (!provider) throw new ApiError(404, 'NOT_FOUND', `Provider ${providerId} not found`);
    return clone(provider);
  }

  /* Mock-only preferred-provider registry (OPERATIONS-COVERAGE #140 "Set
   * preferred providers" PLANNED, docs/CONTRACT-ADDITIONS.md #21): the
   * consumer contract exposes no preference surface (grep of the generated
   * endpoints — only rider availability carries "preferred"), so the
   * registry is module-local (mockState.ts untouched), the same "the mock
   * is the server" pattern as mock/auth.ts. resetMockState() covers
   * mockState only; tests call resetMockPreferredProvidersState() between
   * cases. Seeded once with the first seeded provider — the fixture
   * provider ids are seed-deterministic UUIDs (not stable literals), so the
   * seed resolves lazily against state.home.providers. */
  async listPreferred(): Promise<ProviderPublic[]> {
    seedPreferred();
    const providers = getState().home.providers ?? [];
    return clone(providers.filter((p) => preferredProviderIds.has(p.id)));
  }

  /* PUT /providers/{providerId}/preference — unknown provider → 404
   * NOT_FOUND; the set semantics make the mutation idempotent per key
   * (replaying a key never double-applies). */
  async setPreferred(providerId: string, preferred: boolean, _idempotencyKey: string): Promise<ProviderPublic> {
    seedPreferred();
    const provider = (getState().home.providers ?? []).find((p) => p.id === providerId);
    if (!provider) throw new ApiError(404, 'NOT_FOUND', `Provider ${providerId} not found`);
    if (preferred) preferredProviderIds.add(providerId);
    else preferredProviderIds.delete(providerId);
    return clone(provider);
  }
}

const preferredProviderIds = new Set<string>();
let preferredSeeded = false;

function seedPreferred(): void {
  if (preferredSeeded) return;
  preferredSeeded = true;
  const first = (getState().home.providers ?? [])[0];
  if (first) preferredProviderIds.add(first.id);
}

/** Tests re-seed the preferred-provider registry between cases (resetMockState()
 * covers mockState only — same pattern as mock/auth.ts). */
export function resetMockPreferredProvidersState(): void {
  preferredProviderIds.clear();
  preferredSeeded = false;
}
