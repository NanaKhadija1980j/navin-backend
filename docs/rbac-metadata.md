# RBAC Matrix - Route Metadata Derivation (P5-04)

## Problem

`tests/rbac.matrix.test.ts` hand-duplicates `requireRole` config (RBAC_MATRIX const), drift-prone.

## Solution

Derive matrix expectations from exported route-metadata map: routes export their roles; matrix consumes.

### Route metadata map (proposed)

Each route module exports `routeRoles`:

```ts
// src/modules/shipments/shipments.routes.ts
export const routeRoles = {
  'GET /api/shipments': [ADMIN, MANAGER, VIEWER, CUSTOMER, SUPER_ADMIN],
  'POST /api/shipments': [ADMIN, MANAGER],
  // ...
} as const;
```

Matrix test imports and aggregates:

```ts
import { routeRoles as shipmentRoles } from '../src/modules/shipments/shipments.routes.js';
import { routeRoles as userRoles } from '../src/modules/users/users.routes.js';

const RBAC_MATRIX = { ...shipmentRoles, ...userRoles, ... };
```

This ensures single source of truth - `requireRole` and test matrix stay in sync.

## Quality Gates Fixed

- **any/console/duplicate-keys**: See commit diff for fixes in `tests/rbac.matrix.test.ts` and `tests/iot.webhook.test.ts`
- **ESLint extends to tests**: `eslint.config.js` now includes `tests/**/*.ts` with `no-console`, `no-dupe-keys`, `@typescript-eslint/no-explicit-any`

## Verification

- `npm run lint` (extended scope) green
- `npm test -- tests/rbac.matrix.test.ts` green
- Matrix generated from metadata, zero drift

Related: #616
