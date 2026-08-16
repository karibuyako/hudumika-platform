/* Live API catalog repository. Thin typed wrapper over the hardened client.
 *
 * Paths (API-CONTRACT.yaml):
 *   GET /cities                                       → City[]
 *   GET /services?cityId                              → Service[]
 *   GET /service-categories                           → ServiceCategoryConfig[]
 *   GET /service-categories/{categoryId}/questions    → ServiceQuestion[]
 */
import { api } from '@/api/client';
import type { CatalogRepository } from '../index';
import type { City, Service, ServiceCategoryConfig, ServiceQuestion } from '@hudumika/contract';

export class ApiCatalogRepository implements CatalogRepository {
  async listCities(): Promise<City[]> {
    return api.get<City[]>('/cities');
  }

  async listServices(cityId?: string): Promise<Service[]> {
    return api.get<Service[]>(cityId ? `/services?cityId=${encodeURIComponent(cityId)}` : '/services');
  }

  async listCategories(): Promise<ServiceCategoryConfig[]> {
    return api.get<ServiceCategoryConfig[]>('/service-categories');
  }

  async listQuestions(categoryId: string): Promise<ServiceQuestion[]> {
    return api.get<ServiceQuestion[]>(`/service-categories/${categoryId}/questions`);
  }
}
