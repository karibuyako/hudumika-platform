/* In-memory catalog repository. Mirrors GET /cities, GET /services,
 * GET /service-categories and GET /service-categories/{id}/questions against
 * module state in mockState.ts. City filtering on services is a no-op in the
 * mock — public Service rows carry no city field in the contract.
 */
import { getState, clone } from './mockState';
import type { CatalogRepository } from '../index';
import type { City, Service, ServiceCategoryConfig, ServiceQuestion } from '@hudumika/contract';

export class MockCatalogRepository implements CatalogRepository {
  async listCities(): Promise<City[]> {
    return clone(getState().cities);
  }

  async listServices(_cityId?: string): Promise<Service[]> {
    return clone(getState().publicServices);
  }

  async listCategories(): Promise<ServiceCategoryConfig[]> {
    return clone(getState().categories);
  }

  async listQuestions(categoryId: string): Promise<ServiceQuestion[]> {
    return clone(getState().questions.get(categoryId) ?? []);
  }
}
