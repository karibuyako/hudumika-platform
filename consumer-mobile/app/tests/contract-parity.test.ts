/* Contract-parity harness (auto-picked by tests/run.mjs).
 *
 * Machine-checks the consumer mock repositories against the GENERATED contract
 * package (packages/contract/src/generated) and the backend error registry
 * (backend/ERROR-CODES.md), per docs/TESTING.md §3:
 *
 *   (a) path parity — every URL the app's api repos call exists in the
 *                     contract; app-only paths live in an explicit, documented
 *                     allow-list (APP_ONLY_PATHS) that must stay tiny.
 *   (b) code parity — every ApiError code the mock repos throw exists in
 *                     backend/ERROR-CODES.md, the registry of record (the
 *                     OpenAPI YAML does not enumerate codes — only 11 `code:`
 *                     occurrences and no OTP_EXPIRED). Mock-only codes live in
 *                     an explicit, documented allow-list (MOCK_ONLY_CODES)
 *                     with a reason each — NO invented codes.
 *   (c) error shape — every ApiError carries {code, message, requestId}; the
 *                     client constructor synthesizes requestId when the
 *                     server envelope is absent (api/client.ts:18).
 *
 * Extraction is a deterministic static scan, so the harness has zero runtime
 * deps on the contract package:
 *   - App paths:    quoted/template literals starting with `/` in
 *                   src/repos/api/*.ts + src/api/client.ts (POST /auth/refresh
 *                   lives in the client, not a repo). Query tails (`?...`) and
 *                   non-param interpolations are dropped; `${param}` segments
 *                   (plain identifier or encodeURIComponent(id) immediately
 *                   after `/`) normalize to `{param}`.
 *   - Contract paths: same literal scan over the URL builders in
 *                   packages/contract/src/generated/endpoints/ (every .ts
 *                   file in all subdirectories; .msw.ts excluded — orval
 *                   emits the same paths there).
 *   - Mock codes:   first-two-argument parse of `new ApiError(<status>,
 *                   '<CODE>', ...)` over src/repos/mock/*.ts. Calls whose code
 *                   is a runtime expression can't be verified statically and
 *                   must be listed in DYNAMIC_ERROR_CALLS with a reason.
 *   - Backend codes: backtick-quoted `[A-Z][A-Z0-9_]*` tokens in
 *                   backend/ERROR-CODES.md.
 *
 * The allow-lists below are asserted EXACTLY (both directions), so silent
 * drift fails the suite. Sanity floors keep a broken scan from passing
 * vacuously. Test style mirrors the existing suites (node:test + assert).
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ApiError } from '@/api/client';
import { resetMockState, MOCK_PHONE } from '@/repos/mock/mockState';
import { MockAuthRepository } from '@/repos/mock/auth';
import { MockOrdersRepository } from '@/repos/mock/orders';

/* ---------- sources ---------- */

// The esbuild bundle lands in tests/.build/, so import.meta.url sits two
// levels below the app root. cwd is NOT used: node --test may be invoked from
// anywhere, and the app/ + repo layout is fixed (file: deps in package.json).
const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CONTRACT_ROOT = path.resolve(APP_ROOT, '..', '..', 'packages', 'contract');
const BACKEND_ROOT = path.resolve(APP_ROOT, '..', '..', 'backend');

function collectFiles(dir: string, suffix: string, exclude: (name: string) => boolean): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectFiles(full, suffix, exclude));
    else if (entry.name.endsWith(suffix) && !exclude(entry.name)) out.push(full);
  }
  return out.sort();
}

/* Lightweight literal scan. A quoted/template literal counts as a path when it
 * starts with `/` followed by a lowercase letter. Inside the literal:
 *   - a `?` at depth 0 ends the path (query tail);
 *   - a `${...}` whose body is a plain identifier (or encodeURIComponent(id))
 *     AND which directly follows `/` is a path parameter → `{param}`;
 *   - any other `${...}` (optional-query ternaries, trailing `qs` variables)
 *     ends the path — they only ever build the query string. */
function scanPathLiterals(code: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < code.length; ) {
    const quote = code[i];
    if (quote !== '"' && quote !== "'" && quote !== '`') {
      i += 1;
      continue;
    }
    let j = i + 1;
    let lit = '';
    let brace = 0;
    while (j < code.length) {
      const c = code[j];
      if (brace > 0) {
        if (c === '{') brace += 1;
        else if (c === '}') brace -= 1;
        else if (c === '\\') j += 1;
        j += 1;
        continue;
      }
      if (c === quote || c === '?') break;
      if (c === '\\') {
        j += 2;
        continue;
      }
      if (c === '$' && code[j + 1] === '{') {
        const rest = code.slice(j + 2);
        // encodeURIComponent(...) first: a bare identifier would otherwise
        // swallow the function call up to the first `(`.
        const param = /^(encodeURIComponent\(\s*[A-Za-z_$][\w$]*\s*\)|[A-Za-z_$][\w$]*)/.exec(rest);
        if (param && lit.endsWith('/')) {
          lit += '{param}';
          j += 2 + param[0].length + 1;
          continue;
        }
        break; // query/conditional tail — never a path segment
      }
      lit += c;
      j += 1;
    }
    if (lit.startsWith('/') && /^[a-z]/.test(lit[1] ?? '')) out.push(lit);
    // Resume AFTER the closing quote / break char — never re-scan the literal
    // itself (re-scanning would swallow everything up to the next quote).
    i = j + 1;
  }
  return out;
}

const appApiFiles = [
  ...collectFiles(path.join(APP_ROOT, 'src', 'repos', 'api'), '.ts', () => false),
  path.join(APP_ROOT, 'src', 'api', 'client.ts'), // POST /auth/refresh lives here
];
const APP_PATHS = [...new Set(appApiFiles.flatMap((f) => scanPathLiterals(readFileSync(f, 'utf8'))))].sort();

const contractFiles = collectFiles(path.join(CONTRACT_ROOT, 'src', 'generated', 'endpoints'), '.ts', (n) => n.endsWith('.msw.ts'));
const CONTRACT_PATHS = new Set(contractFiles.flatMap((f) => scanPathLiterals(readFileSync(f, 'utf8'))));

/* ---------- error codes ---------- */

interface ScannedError {
  code: string;
  file: string;
  line: number;
}

interface DynamicError {
  file: string;
  line: number;
}

const API_ERROR_RE = /new\s+ApiError\s*\(/g;

function skipWs(code: string, i: number): number {
  while (i < code.length && /\s/.test(code[i] ?? '')) i += 1;
  return i;
}

function scanMockErrorCodes(files: string[]): { codes: ScannedError[]; dynamic: DynamicError[] } {
  const codes: ScannedError[] = [];
  const dynamic: DynamicError[] = [];
  for (const file of files) {
    const src = readFileSync(file, 'utf8');
    const lineOf = (idx: number) => src.slice(0, idx).split('\n').length;
    API_ERROR_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = API_ERROR_RE.exec(src))) {
      let j = skipWs(src, API_ERROR_RE.lastIndex);
      const status = /^(\d+)/.exec(src.slice(j));
      if (!status) {
        dynamic.push({ file, line: lineOf(j) });
        continue;
      }
      j = skipWs(src, j + status[1].length);
      if (src[j] !== ',') {
        dynamic.push({ file, line: lineOf(j) });
        continue;
      }
      j = skipWs(src, j + 1);
      const q = src[j];
      if (q !== "'" && q !== '"') {
        dynamic.push({ file, line: lineOf(j) });
        continue;
      }
      let k = j + 1;
      let code = '';
      while (k < src.length && src[k] !== q) {
        if (src[k] === '\\') {
          k += 2;
          continue;
        }
        code += src[k];
        k += 1;
      }
      codes.push({ code, file: path.basename(file), line: lineOf(j) });
    }
  }
  return { codes, dynamic };
}

function scanBackendCodes(): string[] {
  const md = readFileSync(path.join(BACKEND_ROOT, 'ERROR-CODES.md'), 'utf8');
  return [...md.matchAll(/`([A-Z][A-Z0-9_]{2,})`/g)].map((mm) => mm[1]);
}

const mockFiles = collectFiles(path.join(APP_ROOT, 'src', 'repos', 'mock'), '.ts', () => false);
const { codes: MOCK_ERRORS, dynamic: DYNAMIC_ERROR_CALLS } = scanMockErrorCodes(mockFiles);
const MOCK_CODES = [...new Set(MOCK_ERRORS.map((e) => e.code))].sort();
const BACKEND_CODES = new Set(scanBackendCodes());

/* ---------- documented allow-lists (asserted exact — no silent drift) ---------- */

/* App paths with NO contract match. Every entry needs a reason; this list
 * must stay small:
 * - '/auth/social' — POST social login (ApiAuthRepository.socialLogin in
 *   src/repos/api/auth.ts). The consumer contract exposes NO OAuth/social
 *   surface (grep of the generated endpoints: only /auth/request-otp |
 *   verify-otp | refresh | logout | change-password), so the social-login
 *   flow is mock-only-until-adopted (OPERATIONS-COVERAGE #10,
 *   docs/CONTRACT-ADDITIONS.md #19); the mock simulates the exchange.
 * - '/auth/social' — POST /auth/social (ApiAuthRepository.socialLogin in
 *   src/repos/api/auth.ts). The consumer contract has no oauth/social/google
 *   paths under /auth (docs/CONTRACT-ADDITIONS.md #19), so the social-login
 *   surface is mock-only-until-adopted (parity harness allow-list).
 * - '/disputes' — POST create a consumer dispute (ApiDisputesRepository.raise
 *   in src/repos/api/disputes.ts). The consumer contract exposes NO dispute
 *   endpoints (grep of the generated endpoints: only admin voucher-dispute
 *   tooling under /admin/vouchers/verify exists), so the customer dispute
 *   surface is mock-only-until-adopted (docs/CONTRACT-ADDITIONS.md #8).
 * - '/disputes/me' — GET my disputes (ApiDisputesRepository.list, same file).
 *   Same mock-only-until-adopted path (docs/CONTRACT-ADDITIONS.md #8).
 * - '/favorites/lists' — GET my favorites lists + POST create a list
 *   (ApiFavoritesRepository.listLists/createList in src/repos/api/favorites.ts),
 *   '/favorites/lists/{param}' — DELETE /favorites/lists/{id} (deleteList),
 *   '/favorites/lists/{param}/merchants' — POST add a favorite merchant to a
 *   list (addToList), and '/favorites/lists/{param}/merchants/{param}' —
 *   DELETE remove a merchant from a list (removeFromList). The consumer
 *   contract exposes NO favorites-lists resource (OPERATIONS-COVERAGE #120
 *   "Organize favorites" PLANNED; grep of the generated endpoints: only
 *   /favorites + /favorites/{merchantId} exist), so the favorites-lists
 *   surface is mock-only-until-adopted (docs/CONTRACT-ADDITIONS.md #14).
 * - '/group-orders' — POST /group-orders (ApiGroupOrdersRepository.create in
 *   src/repos/api/groupOrders.ts), '/group-orders/{param}' — GET
 *   /group-orders/{id} (get), '/group-orders/{param}/items' — POST addItem +
 *   DELETE removeItem, and '/group-orders/{param}/finalize' — POST finalize.
 *   The consumer contract has NO shared-cart/group-ordering surface
 *   (Meituan 拼单 parity, docs/CONTRACT-ADDITIONS.md #11), so all four paths
 *   are mock-only-until-adopted.
 * - '/lists' — GET /lists (curated 必吃榜 lists, ApiListsRepository.listCurated
 *   in src/repos/api/lists.ts) and '/lists/{param}' — GET /lists/{id}
 *   (getCurated). The consumer contract exposes NO Lists resource
 *   (docs/CONTRACT-ADDITIONS.md #14), so both paths are mock-only-until-
 *   adopted; the mock serves the seed the home rail renders from
 *   src/lib/lists.ts.
 * - '/marketing/live-deals/{param}/chat' — GET/POST the live-deal broadcast
 *   chat (ApiMarketingRepository in src/repos/api/marketing.ts). The contract
 *   ships only the sessions zone (GET /marketing/live-deals) — the chat
 *   surface is mock-only-until-adopted (docs/CONTRACT-ADDITIONS.md #13).
 * - '/marketing/live-deals/{param}/chat' — GET fetchLiveChat + POST
 *   postLiveChat (both in src/repos/api/marketing.ts; the harness is
 *   method-agnostic, so the one literal covers both). The contract exposes
 *   only the live-deals list (GET /marketing/live-deals) — the live broadcast
 *   chat surface is mock-only-until-adopted
 *   (docs/CONTRACT-ADDITIONS.md #23): the broadcast screen
 *   (src/app/live/[sessionId].tsx) renders its error/retry state against a
 *   live backend that has not shipped the paths.
 * - '/providers/{param}' — GET /providers/{id} (provider detail, called by
 *   ApiProvidersRepository.get in src/repos/api/providers.ts:26). The
 *   generated contract exposes only the provider list (/providers) and the
 *   /providers/me surface — the single-provider GET is not in the OpenAPI
 *   spec yet, so the mock implements it as an app-only extension
 *   (mock/providers.ts). Flagged for contract backfill.
 * - '/providers/me/preferred' — GET my preferred providers
 *   (ApiProvidersRepository.listPreferred) and '/providers/{param}/preference'
 *   — PUT /providers/{id}/preference (ApiProvidersRepository.setPreferred,
 *   both in src/repos/api/providers.ts). OPERATIONS-COVERAGE #140 "Set
 *   preferred providers" is PLANNED as a contract addition and the consumer
 *   contract exposes NO preference surface (grep of the generated endpoints:
 *   only rider availability carries "preferred"), so both paths are
 *   mock-only-until-adopted (docs/CONTRACT-ADDITIONS.md #21); the services
 *   tab hides the preferred section and the provider screen hides the toggle
 *   against a live backend that has not shipped them.
 * - '/payments/methods/{param}' — DELETE /payments/methods/{methodId}
 *   (ApiPaymentsRepository.removePaymentMethod) and
 *   '/payments/methods/{param}/default' — PUT
 *   /payments/methods/{methodId}/default (ApiPaymentsRepository.
 *   setDefaultPaymentMethod). The contract declares only GET /payments/methods;
 *   the mutations are mock-only-until-adopted (docs/CONTRACT-ADDITIONS.md #7).
 *   The bare POST /payments/methods needs NO entry — the harness is
 *   method-agnostic and the contract already declares the same literal path.
 * - '/providers/me/preferred' — GET the preferred-provider list
 *   (ApiProvidersRepository in src/repos/api/providers.ts) and
 *   '/providers/{param}/preference' — PUT the preferred toggle. The consumer
 *   contract exposes no preferred-provider surface (docs/CONTRACT-ADDITIONS.md
 *   #19), so both paths are mock-only-until-adopted.
 * - '/push/tokens' — POST /push/tokens (ApiAuthRepository.registerPushToken)
 *   and '/push/tokens/{param}' — DELETE /push/tokens/{token}
 *   (ApiAuthRepository.unregisterPushToken). The consumer contract has no
 *   push-token endpoint at all (docs/CONTRACT-ADDITIONS.md #2);
 *   src/lib/push.ts catches failures and keeps the device-local SecureStore
 *   write as the fallback, so a live backend that has not adopted the paths
 *   degrades silently.
 * - '/red-packets/me/received' — GET my received red packets,
 *   '/red-packets/me/share' — POST create a promotional shareable packet,
 *   and '/red-packets/{param}/claim' — POST claim a packet (all three in
 *   src/repos/api/redPackets.ts). The consumer contract exposes NO red-packet
 *   resource (P6c, grep of the generated endpoints: nothing under
 *   /red-packets), so the red-packet surface is mock-only-until-adopted
 *   (docs/CONTRACT-ADDITIONS.md #12); the wallet/red-packets screens render
 *   their error/retry states against a live backend that has not adopted the
 *   paths.
 * - '/loyalty/redemptions' — POST redeem points for a reward
 *   (ApiMembershipsRepository.redeemPoints in src/repos/api/memberships.ts).
 *   The consumer contract exposes only GET /memberships/me, POST /check-in
 *   and GET /loyalty-transactions — no redemption mutation and no reward
 *   catalog (OPERATIONS-COVERAGE #111 is PLANNED), so the redemption surface
 *   is mock-only-until-adopted (docs/CONTRACT-ADDITIONS.md #16); the
 *   membership screen falls back to its error/retry states against a live
 *   backend that has not shipped the path.
 * - '/splits' — POST create a split plan (ApiSplitPaymentsRepository.
 *   createSplit in src/repos/api/splits.ts), '/splits/{param}' — GET the
 *   split (getSplit), '/splits/{param}/pay' — POST pay my share (payMyShare),
 *   and '/splits/{param}/complete' — POST complete the split (completeSplit).
 *   The consumer contract exposes NO split-payment surface (grep of the
 *   generated endpoints: nothing under /splits; the blueprint marks split
 *   payments PLANNED), so all four paths are mock-only-until-adopted
 *   (docs/CONTRACT-ADDITIONS.md #22).
 * - '/home/recommendations' — GET personalized recommendations
 *   (ApiHomeRepository.getRecommendations in src/repos/api/home.ts). The
 *   generated GetConsumerHome200 carries NO recommendations field (verified —
 *   generatedAt/location/categories/merchants/providers/promotions/groupBuys/
 *   recentOrders/unreadCount/membership only) and the contract has no
 *   /home/recommendations endpoint (MASTER-BLUEPRINT §5 personalization is
 *   PLANNED v3), so the surface is mock-only-until-adopted
 *   (docs/CONTRACT-ADDITIONS.md #25). The home rail is consent-gated on the
 *   'personalization' purpose: without consent no request fires at all; with
 *   consent a live backend that has not adopted the path errors the section
 *   into its error/retry state.
 *
 * - '/auth/2fa/verify' — POST verify a 2FA code for a sensitive action
 *   (ApiAuthRepository.verifyTwoFactor in src/repos/api/auth.ts). The
 *   consumer contract exposes NO 2FA surface (OPERATIONS-COVERAGE #9 PLANNED;
 *   grep of the generated endpoints finds no 2fa/mfa/totp paths), so the
 *   two-factor flow is mock-only-until-adopted
 *   (docs/CONTRACT-ADDITIONS.md #23).
 * - '/users/me/2fa' — GET 2FA status (getTwoFactorStatus), POST enable
 *   (enableTwoFactor) and DELETE disable (disableTwoFactor) — one literal
 *   covers all three (the harness is method-agnostic; all in
 *   src/repos/api/auth.ts). Same mock-only-until-adopted reason as
 *   '/auth/2fa/verify' (docs/CONTRACT-ADDITIONS.md #23); the security screen
 *   renders its error/retry state against a live backend that has not shipped
 *   the paths.
 * - '/coupons/suggest' — POST the best applicable wallet coupon for a cart
 *   (ApiCouponsRepository.suggestForCart in src/repos/api/coupons.ts, SMART
 *   COUPONS, MASTER-BLUEPRINT §16). The consumer contract exposes only
 *   GET /coupons/me + POST /coupons/{couponId}/claim (grep of the generated
 *   endpoints: nothing under /coupons/suggest), so the suggestion surface is
 *   mock-first (docs/CONTRACT-ADDITIONS.md #26); the mock ranks the wallet
 *   coupons by discount vs minimum spend, and the checkout hides the advisory
 *   suggestion chip against a live backend that has not shipped the path.
 * - '/dine-in/orders/{param}/splits' — POST splitBill + GET getSplit +
 *   POST payMyShare (all in src/repos/api/dineIn.ts; the harness is
 *   method-agnostic, so the one literal covers all three). The consumer
 *   contract exposes NO dine-in split surface (DINE-IN.md marks split-bill
 *   PLANNED; grep of the generated endpoints: nothing under /dine-in/orders
 *   except the bill paths), so the split-bill surface is mock-only-until-
 *   adopted (docs/CONTRACT-ADDITIONS.md #25); a live backend that has not
 *   shipped the path 404s/405s and the split sheet/summary fall back to their
 *   error/retry states.
 * - '/orders/{param}/tracking-share' — POST create a view-only tracking share
 *   link (ApiOrdersRepository.createTrackingShare in src/repos/api/orders.ts)
 *   and '/tracking-share/{param}' — GET resolve a share token to its order id
 *   (ApiOrdersRepository.resolveTrackingShare, same file). OPERATIONS-COVERAGE
 *   #77 "Share live location — trip-share pattern" is PLANNED and the
 *   consumer contract exposes NO tracking-share surface (grep of the
 *   generated endpoints: nothing under /tracking-share), so both paths are
 *   mock-only-until-adopted (docs/CONTRACT-ADDITIONS.md #27); the api repo
 *   maps resolve 404 → null so a live backend that has not shipped the path
 *   keeps the recipient screen in its "Tracking unavailable" state.
 *
 * NOTE: the booking document GETs (GET /bookings/{id}/invoice|warranty|
 * proof-of-service, src/repos/api/bookings.ts) need NO entry here — the
 * harness is method-agnostic and the contract already declares the same
 * literal paths for the POST issue endpoints (issueServiceInvoice /
 * submitProofOfService / warranty issue). The GETs are mock-only-until-
 * adopted (docs/CONTRACT-ADDITIONS.md #9); the api repo maps 404 → null so a
 * live backend that has not shipped the customer GETs degrades to the
 * coming-soon cards instead of erroring.
 *
 * NOTE: the shipment paths (GET /shipments, GET /shipments/{shipmentId},
 * src/repos/api/shipments.ts) need NO entry — the contract already declares
 * listShipments/getShipment (generated endpoints/orders/orders.ts).
 *
 * NOTE: the mock-only-until-adopted mutation paths in src/repos/api/payments.ts
 * and src/repos/api/auth.ts are ordered BEFORE the payments.ts
 * `id: pm_${m.method}` template literal — the static scanner terminates at a
 * non-path `${...}` interpolation (m.method does not end the literal with a
 * path segment), so literals AFTER that template never enter APP_PATHS. They
 * are listed above and stay scannable.
 *
 * NOTE: the points-accrual getters (MembershipsRepository.earningsFor /
 * earningsForReview, src/repos/api/memberships.ts) need NO entries — the live
 * repo returns null WITHOUT calling any URL (mock-only until the contract
 * ships per-order/per-review earnings — docs/CONTRACT-ADDITIONS.md #28), so
 * nothing new enters APP_PATHS. The order-detail / review-success earn pills
 * render only from the mock's recorded awards. */
const APP_ONLY_PATHS: string[] = ['/auth/2fa/verify', '/auth/social', '/coupons/suggest', '/dine-in/orders/{param}/splits', '/disputes', '/disputes/me', '/favorites/lists', '/favorites/lists/{param}', '/favorites/lists/{param}/merchants', '/favorites/lists/{param}/merchants/{param}', '/group-orders', '/group-orders/{param}', '/group-orders/{param}/finalize', '/group-orders/{param}/items', '/home/recommendations', '/lists', '/lists/{param}', '/loyalty/redemptions', '/marketing/live-deals/{param}/chat', '/orders/{param}/tracking-share', '/payments/methods/{param}', '/payments/methods/{param}/default', '/providers/{param}', '/providers/me/preferred', '/providers/{param}/preference', '/push/tokens', '/push/tokens/{param}', '/red-packets/me/received', '/red-packets/me/share', '/red-packets/{param}/claim', '/splits', '/splits/{param}', '/splits/{param}/complete', '/splits/{param}/pay', '/tracking-share/{param}', '/users/me/2fa'];

/* Mock-only ApiError codes (no match in backend/ERROR-CODES.md). Every entry
 * needs a reason; currently empty — including OTP_EXPIRED, which IS listed in
 * the Auth section of backend/ERROR-CODES.md (mock/auth.ts:95 throws it for an
 * expired request; the UI asks for a fresh code). */
const MOCK_ONLY_CODES: string[] = [];

/* `new ApiError(` calls whose code is a runtime variable/expression — the
 * scanner cannot verify them statically. Each entry needs a reason:
 * payments.ts:150 rethrows the code passed to simulatePaymentFailure()
 * (mockState.ts:931); the contract suite drives it with PAYMENT_PROVIDER_ERROR
 * and PAYMENT_SIGNATURE_INVALID, both listed in backend/ERROR-CODES.md.
 * splits.ts:185 does the same in payMyShare (mock/splits.ts) — the split
 * pay path mirrors the intent confirm provider-outage behavior verbatim.
 * dineIn.ts:212 does the same in MockDineInRepository.payMyShare
 * (mock/dineIn.ts) — the dine-in split pay path reuses the identical
 * simulatePaymentFailure seam (same codes as payments/splits above). */
const DYNAMIC_CODE_ALLOW_LIST: DynamicError[] = [
  { file: 'dineIn.ts', line: 212 },
  { file: 'payments.ts', line: 150 },
  { file: 'splits.ts', line: 185 },
];

/* Sanity floors — if these fail, the scan broke, not the parity. */
const MIN_APP_PATHS = 60;
const MIN_CONTRACT_PATHS = 200;
const MIN_MOCK_ERRORS = 50;
const MIN_BACKEND_CODES = 100;

beforeEach(() => resetMockState());

async function rejectsApiError(promise: Promise<unknown>, status: number, code?: string): Promise<ApiError> {
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

/* ---------- (a) path parity ---------- */

test('parity (a): every app URL has a contract path, and the app-only allow-list is exact', () => {
  const missing = APP_PATHS.filter((p) => !CONTRACT_PATHS.has(p));
  const allow = [...APP_ONLY_PATHS].sort();
  assert.deepEqual(missing, allow, `app paths with no contract match: ${JSON.stringify(missing)}`);
  assert.deepEqual(APP_PATHS, [...new Set(APP_PATHS)], 'app path inventory must not contain duplicates');
});

/* ---------- (b) error-code parity ---------- */

test('parity (b): every mock ApiError code exists in backend/ERROR-CODES.md — no invented codes', () => {
  const invented = MOCK_CODES.filter((c) => !BACKEND_CODES.has(c));
  assert.deepEqual(
    invented,
    [...MOCK_ONLY_CODES].sort(),
    `mock codes missing from ERROR-CODES.md: ${JSON.stringify(invented)}`,
  );
});

test('parity (b): every literal mock code is a well-formed stable code', () => {
  for (const e of MOCK_ERRORS) {
    assert.match(e.code, /^[A-Z][A-Z0-9_]{2,}$/, `${e.file}:${e.line} code ${JSON.stringify(e.code)}`);
  }
});

test('parity (b): dynamic-code ApiError calls are exactly the documented set', () => {
  const normalized = DYNAMIC_ERROR_CALLS.map((d) => ({ file: path.basename(d.file), line: d.line }));
  assert.deepEqual(normalized, DYNAMIC_CODE_ALLOW_LIST, `unexpected dynamic-code calls: ${JSON.stringify(normalized)}`);
});

/* ---------- (c) error shape ---------- */

test('parity (c): ApiError exposes the {code, message, requestId} envelope', () => {
  const e = new ApiError(422, 'VALIDATION_FAILED', 'nope', false, undefined, 'req_server_1');
  assert.ok(e instanceof Error);
  assert.equal(e.status, 422);
  assert.equal(e.code, 'VALIDATION_FAILED');
  assert.equal(e.message, 'nope');
  assert.equal(e.requestId, 'req_server_1');
  assert.equal(typeof e.retriable, 'boolean');
  // Without a server envelope the client synthesizes one (api/client.ts:18).
  const synthesized = new ApiError(0, 'NETWORK_ERROR', 'down');
  assert.match(synthesized.requestId, /^req_/);
});

test('parity (c): errors thrown by the mock repos carry a generated requestId', async () => {
  const auth = new MockAuthRepository();
  const orders = new MockOrdersRepository();

  const req = await auth.requestOtp(MOCK_PHONE, 'login');
  const otpErr = await rejectsApiError(auth.verifyOtp(req.requestId, '000000', 'login'), 401, 'OTP_INVALID');
  assert.ok(otpErr.message.length > 0);
  assert.match(otpErr.requestId, /^req_/, 'mock-thrown ApiError must have a requestId');

  const notFound = await rejectsApiError(orders.get('ord_nope'), 404, 'ORDER_NOT_FOUND');
  assert.ok(notFound.message.length > 0);
  assert.match(notFound.requestId, /^req_/, 'mock-thrown ApiError must have a requestId');
});

/* ---------- scan integrity ---------- */

test('parity: scan sanity floors (a broken scan must never pass vacuously)', () => {
  assert.ok(APP_PATHS.length >= MIN_APP_PATHS, `app paths scanned: ${APP_PATHS.length}`);
  assert.ok(CONTRACT_PATHS.size >= MIN_CONTRACT_PATHS, `contract paths scanned: ${CONTRACT_PATHS.size}`);
  assert.ok(MOCK_ERRORS.length >= MIN_MOCK_ERRORS, `mock ApiError calls scanned: ${MOCK_ERRORS.length}`);
  assert.ok(BACKEND_CODES.size >= MIN_BACKEND_CODES, `backend codes scanned: ${BACKEND_CODES.size}`);
});

test('parity: report', () => {
  const invented = MOCK_CODES.filter((c) => !BACKEND_CODES.has(c));
  const missingPaths = APP_PATHS.filter((p) => !CONTRACT_PATHS.has(p));
  console.log(
    [
      `app paths: ${APP_PATHS.length} (allow-list: ${APP_ONLY_PATHS.length})`,
      `contract paths: ${CONTRACT_PATHS.size}`,
      `mock error codes: ${MOCK_CODES.length} (allow-list: ${MOCK_ONLY_CODES.length}, dynamic: ${DYNAMIC_ERROR_CALLS.length})`,
      `backend codes: ${BACKEND_CODES.size}`,
      `unmatched app paths: ${missingPaths.length}`,
      `invented mock codes: ${invented.length}`,
    ].join('\n'),
  );
});
