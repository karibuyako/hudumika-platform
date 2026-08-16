/* Live API certifications repository. Thin typed wrapper over the hardened client.
 *
 * Paths (API-CONTRACT.yaml):
 *   GET  /providers/me/certifications                    → Certification[]
 *   POST /providers/me/certifications                    → Certification
 *   PATCH /providers/me/certifications/{certificationId} → Certification
 */
import { api } from '@/api/client';
import type { CertificationsRepository } from '../index';
import type { Certification } from '@hudumika/contract';

export class ApiCertificationsRepository implements CertificationsRepository {
  async list(): Promise<Certification[]> {
    return api.get<Certification[]>('/providers/me/certifications');
  }

  async create(input: Certification): Promise<Certification> {
    return api.post<Certification>('/providers/me/certifications', input);
  }

  async update(certificationId: string, input: Partial<Certification>): Promise<Certification> {
    return api.patch<Certification>(`/providers/me/certifications/${certificationId}`, input);
  }
}
