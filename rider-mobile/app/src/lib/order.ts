import type { OrderPriority, OrderStatus } from '@hudumika/contract';

import type { I18nKey } from '@/i18n';
import type { RiderAdvanceableStatus } from '@/repos';

export interface StatusMeta {
  label: string;
  tone: 'neutral' | 'danger' | 'success' | 'info' | 'warning';
}

const STATUS_META: Record<string, StatusMeta> = {
  rider_assigned: { label: 'Assigned', tone: 'info' },
  rider_arrived_pickup: { label: 'At pickup', tone: 'info' },
  picked_up: { label: 'Picked up', tone: 'warning' },
  delivering: { label: 'Delivering', tone: 'warning' },
  rider_arrived_dropoff: { label: 'At drop-off', tone: 'warning' },
  delivered: { label: 'Delivered', tone: 'success' },
  completed: { label: 'Completed', tone: 'success' },
  failed_delivery: { label: 'Failed delivery', tone: 'danger' },
  returning: { label: 'Returning', tone: 'warning' },
  timed_out: { label: 'Timed out', tone: 'neutral' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
  rescheduled: { label: 'Rescheduled', tone: 'neutral' },
};

export function statusMeta(status: OrderStatus): StatusMeta {
  return STATUS_META[status] ?? { label: status.replace(/_/g, ' '), tone: 'neutral' };
}

export interface AdvanceStep {
  status: OrderStatus;
  labelKey: I18nKey;
  next: RiderAdvanceableStatus;
}

export const ADVANCE_STEPS: AdvanceStep[] = [
  { status: 'rider_assigned', labelKey: 'orders.arrived', next: 'rider_arrived_pickup' },
  { status: 'rider_arrived_pickup', labelKey: 'orders.pickedUp', next: 'picked_up' },
  { status: 'picked_up', labelKey: 'orders.delivering', next: 'delivering' },
  { status: 'delivering', labelKey: 'orders.arrivedDropoff', next: 'rider_arrived_dropoff' },
];

export function advanceStepFor(status: OrderStatus): AdvanceStep | null {
  return ADVANCE_STEPS.find((s) => s.status === status) ?? null;
}

export function priorityMeta(
  priority: OrderPriority | undefined,
): { label: string; tone: 'warning' | 'danger' } | null {
  if (priority === 'express' || priority === 'vip') {
    return { label: priority.toUpperCase(), tone: priority === 'vip' ? 'danger' : 'warning' };
  }
  return null;
}

export function formatEta(minutes?: number | null): string | null {
  if (minutes === undefined || minutes === null || Number.isNaN(minutes)) return null;
  const m = Math.max(0, Math.round(minutes));
  const h = Math.floor(m / 60);
  return h > 0 && m % 60 > 0 ? `${h}h ${m % 60}m` : h > 0 ? `${h}h` : `${m} min`;
}

export function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}