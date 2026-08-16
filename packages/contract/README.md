# @hudumika/contract

Generated TypeScript client, model types, and mock handlers — single source of truth is `backend/API-CONTRACT.yaml` (OpenAPI 3.1, 464 paths / 249 schemas), owned by the backend team (Team 6).

## Exports

| Entry | Contents | Use |
| --- | --- | --- |
| `@hudumika/contract` | Typed fetch clients per endpoint tag + all model types | Every app (web + RN) |
| `@hudumika/contract/mocks` | MSW request handlers (browser dev only) | Web apps with MSW |
| `@hudumika/contract/fixtures` | Pure-data fixture factories (faker only, **no msw import**) | React Native mock repositories |

## Installing

The package is published to GitHub Packages when the platform repo exists. Consumers need:

`.npmrc` (repo root of your app):

```ini
@hudumika:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
```

where `GITHUB_TOKEN` is a token with `read:packages` scope.

Until the registry is live, install from the monorepo workspace:

```sh
npm install   # at the Hudumika Platform root — symlinks the package
```

## Required consumer tsconfig flags

The package ships raw TypeScript (no build step):

```json
{
  "compilerOptions": {
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "skipLibCheck": true,
    "noEmit": true
  }
}
```

- Vite apps: works out of the box.
- Expo/React Native: `allowImportingTsExtensions` is default in Expo SDK 50+; add the other flags if missing.

## Mock switching convention

**Global switch (web):** `VITE_USE_MOCKS !== 'false'` in dev enables `@hudumika/contract/mocks` via MSW; production builds never load them.

**Per-endpoint switch:** keep a module-level map in your app:

```ts
import { adminListOrders } from '@hudumika/contract'
import { getAdminListOrdersMockHandler } from '@hudumika/contract/mocks'

const USE_MOCKS: Record<string, boolean> = { orders: import.meta.env.VITE_MOCK_ORDERS !== 'false', home: true }

export async function listOrders() {
  return USE_MOCKS.orders ? getAdminListOrdersMockHandler() : adminListOrders()
}
```

Flip one module to the live API as Team 6 delivers it — never delete the mock, keep both paths.

**React Native:** MSW is browser-only. Use `@hudumika/contract/fixtures` behind a repository interface — see `docs/MOBILE-MOCK-PATTERN.md` at the platform root.

## Versioning

- Every contract change is a patch bump (`0.x.y`) and a `CHANGELOG.md` entry, authored by Team 6.
- Apps pin exact versions (`"@hudumika/contract": "0.2.0"`), upgrade deliberately after reading the changelog.
- Breaking contract changes bump the minor (`0.2.0` → `0.3.0`) and require a team-wide note.

## Regenerating (Team 6 only)

```sh
npm run generate:contract   # at the platform root — orval reads orval.config.ts
npm run build:contract      # regenerate + typecheck
```

Commit the generated output. Publish: `npm run publish:contract` (platform root) — requires GitHub Packages auth.
