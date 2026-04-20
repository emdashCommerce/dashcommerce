# @dashcommerce/create

## 0.2.0

### Minor Changes

- [#9](https://github.com/emdashCommerce/dashcommerce/pull/9) [`c3418af`](https://github.com/emdashCommerce/dashcommerce/commit/c3418afe5517f6ee1b7baf8f8df02faecb0ecd03) Thanks [@cavewebs](https://github.com/cavewebs)! - Initial release — scaffold a new DashCommerce project with `npm create @dashcommerce@latest`.

  - Interactive prompts for project directory, template, dependency install, and git init
  - `--template <name>` flag for non-interactive overrides (default: `starter`)
  - Template downloads via `giget` from the `emdashCommerce/starter` flat repo
  - Detects the invoking package manager (bun/pnpm/yarn/npm) and runs install with it
  - Prints Stripe setup + `bun run dev` next steps on success
