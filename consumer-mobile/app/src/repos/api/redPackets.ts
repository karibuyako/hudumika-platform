/* Live API red-packets repository — mock-only-until-adopted paths
 * (docs/CONTRACT-ADDITIONS.md #12): POST /red-packets/me/share,
 * GET /red-packets/me/received, POST /red-packets/{packetId}/claim.
 *
 * The consumer contract exposes NO red-packet resource yet (P6c), so a live
 * backend that has not adopted the paths fails these calls — the red-packets
 * screen renders its error/retry state against it, the same degrade path as
 * the other app-only surfaces (disputes, payments mutations, push tokens).
 */
import { api } from '@/api/client';
import type { RedPacket, RedPacketClaim, RedPacketCreateInput, RedPacketRepository } from '../index';

export class ApiRedPacketRepository implements RedPacketRepository {
  async listReceived(): Promise<RedPacket[]> {
    return api.get<RedPacket[]>('/red-packets/me/received');
  }

  async claim(packetId: string, idempotencyKey: string): Promise<RedPacketClaim> {
    return api.post<RedPacketClaim>(`/red-packets/${packetId}/claim`, {}, { idempotencyKey });
  }

  async createSharePacket(input: RedPacketCreateInput, idempotencyKey: string): Promise<RedPacket> {
    return api.post<RedPacket>('/red-packets/me/share', input, { idempotencyKey });
  }
}
