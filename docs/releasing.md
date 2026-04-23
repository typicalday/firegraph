# Releasing

Firegraph uses [release-please](https://github.com/googleapis/release-please) for
version management and automated npm publishing. Releases are driven entirely
from `main`'s conventional-commit history — there is no `npm version`
ceremony.

## How a release happens

1. **PRs land on `main` with conventional-commit messages** (already enforced
   by `commitlint` + `husky`). `feat:` → minor bump, `fix:` → patch bump,
   `feat!:` or `BREAKING CHANGE:` → minor bump while we're still pre-1.0.
2. The `release-please` GitHub Actions workflow runs on every push to `main`.
   It reads commits since the last release and opens (or updates) a **Release
   PR** titled `chore(main): release X.Y.Z`. That PR bumps `package.json`,
   updates `CHANGELOG.md`, and shows exactly what will ship.
3. A maintainer reviews and merges the Release PR. On merge, the workflow:
   - Creates a git tag `vX.Y.Z`.
   - Creates a GitHub Release with the generated changelog.
   - Runs `pnpm publish --access public` against npm.

No changes ship to npm until the Release PR is merged, so the pipeline is
gated: you can stack many PRs into a single release.

## One-time setup

### `NPM_TOKEN` repo secret

Create an npm access token with publish permission on `@typicalday/firegraph`
and add it as a repo secret named `NPM_TOKEN`:

1. `npm login` (if needed)
2. <https://www.npmjs.com/settings/typicalday/tokens> → **Generate New Token**
   → **Automation** (CI-safe; bypasses 2FA). Max expiration is 90 days —
   rotate when it nears expiry.
3. In GitHub: **Settings → Secrets and variables → Actions → New repository
   secret** → name `NPM_TOKEN`, paste the token.

### Actions permissions

In **Settings → Actions → General → Workflow permissions**:

- Select **Read and write permissions**.
- Check **Allow GitHub Actions to create and approve pull requests** (needed
  so release-please can open the Release PR).

## Overriding the next version

Release-please infers the next version from commit messages. To force a
specific bump, either:

- Amend the Release PR description with `Release-As: 1.0.0` before merging
  (release-please reads this magic string), or
- Include `Release-As: 1.0.0` in a regular commit message on `main`.

## Configuration

- [`release-please-config.json`](../release-please-config.json) — package
  config. `bump-minor-pre-major: true` keeps us on the 0.x.y minor track
  where `feat:` drives minor bumps.
- [`.release-please-manifest.json`](../.release-please-manifest.json) —
  current released version (source of truth for release-please state).

## CI

The `ci` workflow runs on every PR and every push to `main`:

- `lint` — ESLint + Prettier + TypeScript
- `unit` — `pnpm test:unit`
- `integration` — boots the Firestore emulator and runs `pnpm test:emulator:integration`
- `build` — `pnpm build` (sanity check that the published artifacts compile)

All four must pass before a PR can be merged into `main`.
