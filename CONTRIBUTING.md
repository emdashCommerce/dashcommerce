# Contributing to DashCommerce

DashCommerce is pre-1.0, so the surface is still shifting. Small, focused PRs are welcome. For a large feature or a new payment provider, open an issue first using the templates so it can be aligned with the roadmap in [`CHANGELOG.md`](./CHANGELOG.md) before code is written.

If you are reporting a security issue, do not open a public issue. See [`SECURITY.md`](./SECURITY.md).

## Before you start

- Search existing [issues](https://github.com/emdashCommerce/dashcommerce/issues) and [discussions](https://github.com/emdashCommerce/dashcommerce/discussions).
- Read the README's **Current Release** table for the supported version and EmDash peer range. Do not assume a version from this file; it changes.
- DashCommerce Lite and `@dashcommerce/core` are alternatives. Each runs its own cart, checkout, orders and Stripe webhook. Do not install both.

## Setup

The repository is a Bun workspace. CI uses Bun `1.4.3` and Node `22` for Astro; a recent Bun is enough locally.

```sh
bun install
bun run typecheck
bun run build
bun test
```

For development:

```sh
bun run dev                       # all packages
cd packages/core && bun run dev   # core, tsdown --watch
cd packages/starter && bun run dev # starter storefront on :4321
```

`bun install` also builds core through the root `postinstall` script.

## Changesets

Every package code change needs a changeset:

```sh
bun run changeset
```

Choose the affected package and a bump type. Docs, templates and repository configuration do not need one. A provider package's first release is a minor bump.

## Tests and CI

Run the same checks locally before opening a PR:

```sh
bun run typecheck
bun run build
bun test
bun run --cwd packages/lite validate
bun run --cwd packages/lite typecheck
bun run --cwd packages/lite test
```

CI also runs the Lite bundle and sandbox tests and an EmDash compatibility matrix (0.37.0 and 1.1–1.6). See [`.github/workflows/ci.yml`](./.github/workflows/ci.yml) for the exact jobs. Changes to core must pass the matrix, not only the current EmDash version.

Tests should cover the behaviour you changed, not only the happy path. For checkout, webhook or refund changes, exercise the real core routes where the existing suites do.

## Payment provider packages

A provider is a package under `packages/<provider>` that implements core's `PaymentProvider` interface. It must:

- register itself on import with `registerPaymentProvider`;
- document `allowedHosts`, the webhook URL and its credential fields in its README;
- declare `credentialFields`, `webhookHeaders`, `checkConnection` and the `capabilities` it actually supports;
- run its tests against core's real checkout and webhook routes, not only its own client;
- ship with a minor changeset and, in the PR, test-mode evidence for checkout, a real webhook delivery and a refund.

Do not put provider-specific code in `@dashcommerce/core`. The README's **For provider authors** section lists the contract; existing providers in `packages/` are the reference.

## Code style

- Biome formats and lints the repository:

  ```sh
  bun run format
  bun run lint
  ```

- TypeScript everywhere. Prefer the existing patterns in the package you are changing over new abstractions.
- Keep public behaviour documented in the README or the package README.
- Never commit API keys, webhook secrets, `.env` files or customer data. Use test-mode keys.

## Commits and PRs

- Use conventional commit subjects, for example `fix(core): …`, `feat(paystack): …`, `docs: …`.
- Keep a PR to one concern. Large features should be split into reviewable pieces.
- Link the issue or discussion in the PR description.
- Use the [pull request template](./.github/PULL_REQUEST_TEMPLATE.md) and fill in the tests, changeset and provider checklist where they apply.
- Reviewers may ask for the EmDash compatibility matrix or a test-mode run; the CI results are part of the review.

## Code of conduct

Participation is covered by [`CODE_OF_CONDUCT.md`](./CODE_OF_CONDUCT.md).
