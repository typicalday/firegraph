---
paths:
  - 'tests/**/*'
---

# Testing

## Test Types

- **Unit tests** (`tests/unit/`): Pure logic, no Firestore. Mock `GraphReader` for traverse tests.
- **Integration tests** (`tests/integration/`): Real Firestore emulator. Each test gets a unique collection path via `uniqueCollectionPath()`.
- **Pipeline integration tests** (`tests/integration-pipeline/`): Real Enterprise Firestore. Tests `createGraphClient` with `queryMode: 'pipeline'`. Requires `PIPELINE_TEST_PROJECT` and `PIPELINE_TEST_DATABASE` env vars. Run via `pnpm test:pipeline:integration`.
- **Pipeline research tests** (`tests/pipeline/`): Exploratory tests validating raw Pipeline API capabilities (not firegraph integration). Marked for removal once Pipeline exits Preview.

## Setup

- `tests/integration/setup.ts` initializes `@google-cloud/firestore` against `127.0.0.1:8188`.
- `tests/helpers/fixtures.ts` has `tourData`, `departureData`, `riderData`, etc.

## Commands

```bash
pnpm test:unit          # vitest on tests/unit/
pnpm test:emulator      # starts emulator, runs full suite, stops emulator
pnpm test:emulator:unit # emulator + unit tests only
pnpm test:emulator:integration  # emulator + integration tests only
pnpm emulator:start     # manual emulator start (demo-firegraph, port 8188)
pnpm emulator:stop      # kill emulator
```
