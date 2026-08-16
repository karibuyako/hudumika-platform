import type { BookingStatus } from '@hudumika/contract';

import { Pill } from '@/components/ui';
import { statusMeta } from '@/lib/booking';

/** Status pill for the provider booking machine — maps 1:1 to contract enum values. */
export function StatusPill({ status, label }: { status: BookingStatus; label?: string }) {
  const meta = statusMeta(status);
  return <Pill label={(label ?? meta.label).toUpperCase()} tone={meta.tone} />;
}
