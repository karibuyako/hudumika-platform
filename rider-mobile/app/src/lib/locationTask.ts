/* Background location task definition.
 *
 * defineTask must run at module scope (expo-task-manager requires it at app
 * launch so a background relaunch can execute the task). This module is only
 * imported by the app shell (src/app/_layout.tsx) — never by stores or tests,
 * which use the lazy wrappers in src/lib/location.ts instead.
 *
 * Each sample reports via POST /riders/me/location; LOCATION_RATE_LIMITED
 * (429) backs off silently — the next interval retries.
 */
import { defineTask } from 'expo-task-manager';
import type { TaskManagerError } from 'expo-task-manager';

import { ApiError } from '@/api/client';
import { getRiderRepository } from '@/repos';

export const LOCATION_TASK_NAME = 'hudumika-rider-location';

/** Task data shape for location tasks: a batch of samples. */
interface LocationTaskData {
  locations?: { coords: { latitude: number; longitude: number } }[];
}

defineTask(LOCATION_TASK_NAME, async ({ data, error }: { data: LocationTaskData; error: TaskManagerError | null }) => {
  if (error) return;
  const location = data?.locations?.[0];
  if (!location) return;
  try {
    await getRiderRepository().reportLocation(location.coords.latitude, location.coords.longitude);
  } catch (e) {
    if (e instanceof ApiError && e.status === 429) {
      // LOCATION_RATE_LIMITED — silent back off; next interval retries.
      return;
    }
    // Diagnostic surface until crash monitoring ships (DEPLOYMENT.md) — no tokens/PII.
    const code = e instanceof ApiError ? e.code : 'LOCATION_REPORT_FAILED';
    const requestId = e instanceof ApiError ? (e.requestId ?? '') : '';
    console.warn(`[location] report failed code=${code}${requestId ? ` requestId=${requestId}` : ''}`);
  }
});
