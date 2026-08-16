/* Background location lifecycle control (ARCHITECTURE.md / SECURITY.md).
 *
 * Native-only: the task starts when the rider accepts a delivery and stops
 * when the last active delivery ends or the rider goes offline. Battery-aware:
 * Balanced accuracy, 10 s interval, pauses while stationary. The task itself
 * (defineTask) lives in src/lib/locationTask.ts at module scope.
 *
 * expo-location / expo-task-manager load lazily here so the node test runner
 * and web can import this module without a native module registry — on those
 * platforms the import throws and every function no-ops.
 */

import type { LocationTaskOptions } from 'expo-location';

const TASK_NAME = 'hudumika-rider-location';

type LocationModule = typeof import('expo-location');
type TaskManagerModule = typeof import('expo-task-manager');

let loaded: boolean | null = null;
let loc: LocationModule | null = null;
let taskManager: TaskManagerModule | null = null;

async function load(): Promise<{ loc: LocationModule; taskManager: TaskManagerModule } | null> {
  if (loaded !== null) return loc && taskManager ? { loc, taskManager } : null;
  loaded = true;
  try {
    const [a, b] = await Promise.all([import('expo-location'), import('expo-task-manager')]);
    if (typeof a.startLocationUpdatesAsync === 'function' && typeof b.defineTask === 'function') {
      loc = a as LocationModule;
      taskManager = b as TaskManagerModule;
      return { loc, taskManager };
    }
  } catch {
    /* not native — no-op */
  }
  loc = null;
  taskManager = null;
  return null;
}

export async function isBackgroundTrackingActive(): Promise<boolean> {
  const m = await load();
  if (!m) return false;
  try {
    return (await m.taskManager.isTaskRegisteredAsync(TASK_NAME)) === true;
  } catch {
    return false;
  }
}

export async function startBackgroundTracking(): Promise<boolean> {
  const m = await load();
  if (!m) return false;
  try {
    const { status } = await m.loc.requestForegroundPermissionsAsync();
    if (status !== 'granted') return false;
    const opts: LocationTaskOptions = {
      accuracy: m.loc.Accuracy.Balanced,
      timeInterval: 10000,
      distanceInterval: 50,
      pausesUpdatesAutomatically: true,
      showsBackgroundLocationIndicator: true,
      foregroundService: {
        notificationTitle: 'Hudumika Rider',
        notificationBody: 'Delivering — location sharing is active',
      },
    };
    await m.loc.startLocationUpdatesAsync(TASK_NAME, opts);
    return true;
  } catch {
    return false;
  }
}

export async function stopBackgroundTracking(): Promise<void> {
  const m = await load();
  if (!m) return;
  try {
    if (await m.taskManager.isTaskRegisteredAsync(TASK_NAME)) {
      await m.loc.stopLocationUpdatesAsync(TASK_NAME);
    }
  } catch {
    /* best-effort stop */
  }
}
