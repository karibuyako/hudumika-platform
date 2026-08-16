/* In-memory certifications repository. Mirrors GET/POST /providers/me/certifications
 * and PATCH /providers/me/certifications/{id} against module state in
 * mockState.ts. New certifications start status 'pending'; renewing a
 * certification (new expiryDate / documentUrl / number) moves it back to
 * 'pending' until the platform verifies it again.
 */
import { ApiError } from '@/api/client';
import { getState, clone } from './mockState';
import { uid } from '@/lib/format';
import type { CertificationsRepository } from '../index';
import type { Certification } from '@hudumika/contract';

export class MockCertificationsRepository implements CertificationsRepository {
  async list(): Promise<Certification[]> {
    return clone(getState().certifications);
  }

  async create(input: Certification): Promise<Certification> {
    const state = getState();
    const cert: Certification = {
      ...clone(input),
      id: uid('cert'),
      verified: false,
      status: 'pending',
    };
    state.certifications.push(cert);
    return clone(cert);
  }

  async update(certificationId: string, input: Partial<Certification>): Promise<Certification> {
    const state = getState();
    const cert = state.certifications.find((c) => c.id === certificationId);
    if (!cert) throw new ApiError(404, 'CERTIFICATION_NOT_FOUND', `Certification ${certificationId} not found`);
    Object.assign(cert, clone(input), { id: certificationId });
    if (input.expiryDate !== undefined || input.documentUrl !== undefined || input.number !== undefined) {
      cert.status = 'pending';
      cert.verified = false;
    }
    return clone(cert);
  }
}
