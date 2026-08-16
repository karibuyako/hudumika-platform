/* In-memory red-packets repository — mock-only until the contract ships the
 * red-packet resource (docs/CONTRACT-ADDITIONS.md #12, P6c): GET
 * /red-packets/me/received, POST /red-packets/{packetId}/claim,
 * POST /red-packets/me/share.
 *
 * Red packets are PROMOTIONAL: the platform funds them from marketing budget
 * (Meituan 红包 parity), never from a recipient's wallet — claiming credits
 * the wallet balance the same way a top-up does (WalletTransaction with
 * referenceType 'red_packet', contract type 'adjustment' — the same
 * contract-first trick as mock/wallet.ts topUp).
 */
import { ApiError } from '@/api/client';
import { uid } from '@/lib/format';
import { clone, getState, nowIso } from './mockState';
import type { RedPacket, RedPacketClaim, RedPacketCreateInput, RedPacketRepository } from '../index';

/** Module-local packet registry (mockState.ts stays untouched — same pattern
 * as the review seeds in mock/reviews.ts and the token registry in
 * mock/auth.ts). Two seeds: one claimable promotional packet (count 5, one
 * credit per claim) and one already claimed in full. */
let packets: RedPacket[] = [];

/** Per-user claim ledger: a packet can be claimed once per user (Meituan
 * red-packet rule); a second claim 409s. */
const claimedPacketIds = new Set<string>();

function ensureSeeds(): void {
  if (packets.length > 0) return;
  const now = Date.now();
  packets = [
    {
      id: 'rpk_promo_001',
      title: 'Hudumika Friday packet',
      totalTZS: 10000,
      claimedCount: 0,
      count: 5,
      claimed: false,
      expiresAt: new Date(now + 7 * 86400_000).toISOString(),
      shareCode: 'PK-7D2F',
    },
    {
      id: 'rpk_promo_002',
      title: 'Weekend deal packet',
      totalTZS: 5000,
      claimedCount: 2,
      count: 2,
      claimed: true,
      expiresAt: new Date(now + 2 * 86400_000).toISOString(),
    },
  ];
}

/** Tests re-seed the red-packets module between cases (resetMockState()
 * covers the shared wallet store; this clears the module-local registry +
 * claim ledger). */
export function resetMockRedPacketState(): void {
  packets = [];
  claimedPacketIds.clear();
}

/** Test hook — the module-local packet registry (same pattern as
 * reportedIssueIdsForTests in mock/wallet.ts). */
export function redPacketsForTests(): RedPacket[] {
  ensureSeeds();
  return clone(packets);
}

/** Demo/test hook — mark a packet as expired (the mock is the server:
 * expiry is normally server-authored at create time). */
export function expireRedPacketForTests(packetId: string): void {
  ensureSeeds();
  const packet = packets.find((p) => p.id === packetId);
  if (packet) packet.expiresAt = new Date(Date.now() - 3600_000).toISOString();
}

export class MockRedPacketRepository implements RedPacketRepository {
  async listReceived(): Promise<RedPacket[]> {
    ensureSeeds();
    return clone(packets);
  }

  async claim(packetId: string, _idempotencyKey: string): Promise<RedPacketClaim> {
    ensureSeeds();
    const packet = packets.find((p) => p.id === packetId);
    if (!packet) throw new ApiError(404, 'NOT_FOUND', `Red packet ${packetId} not found`);
    if (claimedPacketIds.has(packetId) || packet.claimed) {
      throw new ApiError(409, 'CONFLICT', 'You already claimed this red packet');
    }
    if (new Date(packet.expiresAt).getTime() < Date.now()) {
      throw new ApiError(422, 'VALIDATION_FAILED', 'This red packet has expired');
    }
    const creditedTZS = Math.floor(packet.totalTZS / packet.count);
    packet.claimedCount += 1;
    if (packet.claimedCount >= packet.count) packet.claimed = true;
    claimedPacketIds.add(packetId);
    const state = getState();
    state.wallet.totalTZS += creditedTZS;
    state.wallet.withdrawableTZS += creditedTZS;
    state.walletTransactions.unshift({
      id: uid('wtx'),
      type: 'adjustment',
      amountTZS: creditedTZS,
      balanceTZS: state.wallet.totalTZS,
      referenceType: 'red_packet',
      referenceId: packetId,
      createdAt: nowIso(),
    });
    return { id: uid('rpclaim'), creditedTZS };
  }

  async createSharePacket(input: RedPacketCreateInput, _idempotencyKey: string): Promise<RedPacket> {
    ensureSeeds();
    if (!Number.isInteger(input.amountTZS) || input.amountTZS < 1) {
      throw new ApiError(422, 'VALIDATION_FAILED', 'Packet amount must be a positive whole number of TZS');
    }
    if (!Number.isInteger(input.count) || input.count < 1 || input.count > 5) {
      throw new ApiError(422, 'VALIDATION_FAILED', 'Packet count must be between 1 and 5');
    }
    if (!Number.isInteger(input.expiresInHours) || input.expiresInHours < 1 || input.expiresInHours > 24 * 7) {
      throw new ApiError(422, 'VALIDATION_FAILED', 'Packet expiry must be between 1 and 168 hours');
    }
    const packet: RedPacket = {
      id: uid('rpk'),
      title: input.title?.trim() || 'Hudumika red packet',
      totalTZS: input.amountTZS,
      claimedCount: 0,
      count: input.count,
      claimed: false,
      expiresAt: new Date(Date.now() + input.expiresInHours * 3600_000).toISOString(),
      shareCode: `PK-${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
    };
    packets.unshift(packet);
    return clone(packet);
  }
}
