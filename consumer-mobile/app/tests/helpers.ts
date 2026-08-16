/* Shared test helpers for the per-milestone suites (tests/m{1,3,4,5,6,7}-*.test.ts).
 * Bundled per-file by tests/run.mjs (esbuild resolves these imports). */
import assert from 'node:assert/strict';
import { ApiError } from '@/api/client';
import { resetMockState, MOCK_PHONE } from '@/repos/mock/mockState';
import { MockAuthRepository, resetMockAuthState } from '@/repos/mock/auth';

export { resetMockState, resetMockAuthState, MOCK_PHONE };

export const auth = new MockAuthRepository();

export async function rejectsApiError(promise: Promise<unknown>, status: number, code?: string): Promise<ApiError> {
  let caught: unknown;
  try {
    await promise;
  } catch (e) {
    caught = e;
  }
  assert.ok(caught instanceof ApiError, `expected ApiError, got ${String(caught)}`);
  assert.equal(caught.status, status);
  if (code) assert.equal(caught.code, code);
  return caught as ApiError;
}

export async function loginAsDemo(): Promise<void> {
  const req = await auth.requestOtp(MOCK_PHONE, 'login');
  await auth.verifyOtp(req.requestId, req.debugCode ?? '', 'login');
}
