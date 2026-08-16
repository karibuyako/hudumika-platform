# @hudumika/tokens

Shared design tokens (Hudumika green palette, typography, spacing, radius, shadows, motion) for the Hudumika platform — one source of truth for web and Expo apps.

## Usage — web apps (Vite/Tailwind)

```ts
import '@hudumika/tokens/tokens.css'; // :root custom properties
import { palette, color, spacing, radius, typography } from '@hudumika/tokens';
```

## Usage — Expo / React Native apps

```ts
import { color, spacing, radius, typography } from '@hudumika/tokens';
```

## Authority

The reference zip (`build-meituan-inspired-website (18).zip`) and its `src/index.css` `@theme` block are the single source of truth for token names and values. `DESIGN-SYSTEM.md` is synced to it by a separate agent; when in doubt, diff against the zip, never the other way around.
