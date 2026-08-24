# Releasing

Releases are driven by [changesets](https://github.com/changesets/changesets) with
independent versions per package, published to npm via
[trusted publishing](https://docs.npmjs.com/trusted-publishers) (OIDC + provenance).
There is **no `NPM_TOKEN` secret anywhere** and nothing to rotate.

## The automated flow

1. A PR that changes published behaviour includes a changeset (`pnpm changeset`).
   The changeset-bot comments on every PR whether one is present.
2. Merging to `main` makes `release.yml` open (or update) a
   `chore(release): version packages` PR. `changeset version` bumps versions and
   writes `CHANGELOG.md` entries via `@changesets/changelog-github` (PR links and
   author credits).
3. Merging the version PR publishes every changed package to npm
   (`scripts/release.mjs`), pushes the `<name>@<version>` git tags, and creates a
   GitHub Release per package with the changelog section as notes.

### Why `scripts/release.mjs` instead of `changeset publish`

`changeset publish` on CLI v2 shells out to `pnpm publish` when it detects pnpm,
which historically did not reliably support OIDC
([pnpm/pnpm#9812](https://github.com/pnpm/pnpm/issues/9812)). Publishing through the
npm CLI directly keeps the OIDC + provenance path exactly the one npm documents.
pnpm ≥ 11.1.3 publishes natively with OIDC, and changesets CLI v3 (Aug 2026) uses
it — once we migrate to `@changesets/cli` v3 + `changesets/action` v2, this script
can be retired.

## One-time repository setup

- Repository must be **public** (npm generates provenance only for public repos).
- Settings → Actions → General → _Workflow permissions_: enable
  **Allow GitHub Actions to create and approve pull requests**.
- Every package's `repository.url` must match `Uplab/uplab-vendure-plugins`
  exactly (case-sensitive) — provenance verification compares them.

### GitHub App for the version PR (recommended)

PRs created with the default `GITHUB_TOKEN` never trigger CI, so the version PR
would sit without checks. Fix: a repo-owned GitHub App.

1. Create a GitHub App (org **Uplab** → Settings → Developer settings → GitHub
   Apps): no webhook, repository permissions **Contents: Read and write** and
   **Pull requests: Read and write**. Install it on `uplab-vendure-plugins`.
2. In the repo: variable `RELEASE_BOT_CLIENT_ID` = the App's Client ID, secret
   `RELEASE_BOT_PRIVATE_KEY` = a generated private key (PEM).
3. `release.yml` picks them up automatically; until then it falls back to
   `GITHUB_TOKEN` (releases still work, the version PR just shows no checks).

## Bootstrapping a new package

npm only lets you attach a trusted publisher to a package that already exists, so
the **first version of every package is published by hand**, once:

1. `pnpm changeset version` (or merge the version PR) so the package has its
   release version; commit the result.
2. `pnpm build`, then in the package directory `npm publish --access public`
   (requires `npm login` + 2FA; this first publish carries no provenance — expected).
3. On npmjs.com open `https://www.npmjs.com/package/<name>/access` →
   _Trusted Publisher_ → _GitHub Actions_: organization `Uplab`, repository
   `uplab-vendure-plugins`, workflow filename `release.yml`, environment empty.
   npm does not validate these fields — a typo only shows up as a failed publish.
   (Configs created after May 2026 must also explicitly allow `npm publish`.)
4. Same page → _Publishing access_: **Require two-factor authentication and
   disallow tokens**, so OIDC is the only way to publish.
5. `pnpm exec changeset tag && git push --tags`.

From then on every release of that package is automated.

## Previews

Every PR gets installable preview builds via [pkg.pr.new](https://pkg.pr.new)
(no npm involved): `npm i https://pkg.pr.new/Uplab/uplab-vendure-plugins/<pkg>@<pr>`.

## Manual escape hatches

- `node scripts/release.mjs --dry-run` — what would be published right now.
- `pnpm changeset status --verbose` — planned bumps from pending changesets.
- An empty changeset (`pnpm changeset add --empty`) documents a deliberate
  no-release change.
