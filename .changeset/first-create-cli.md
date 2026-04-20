---
"@dashcommerce/create": minor
---

Initial release — scaffold a new DashCommerce project with `npm create @dashcommerce@latest`.

- Interactive prompts for project directory, template, dependency install, and git init
- `--template <name>` flag for non-interactive overrides (default: `starter`)
- Template downloads via `giget` from the `emdashCommerce/starter` flat repo
- Detects the invoking package manager (bun/pnpm/yarn/npm) and runs install with it
- Prints Stripe setup + `bun run dev` next steps on success
