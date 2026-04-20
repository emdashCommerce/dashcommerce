# @dashcommerce/create

Scaffold a new [DashCommerce](https://dashcommerce.dev) project.

```sh
npm create @dashcommerce@latest
# or
npm create @dashcommerce@latest my-shop
# or
npm create @dashcommerce@latest my-shop -- --template starter
```

Works with `bun create`, `pnpm create`, and `yarn create` too — whichever package manager you invoke with is the one used to install the scaffolded project's dependencies.

## Templates

| Name | What you get |
|---|---|
| `starter` | Full Astro commerce site — 6 demo products, Stripe checkout, blog, subscriptions, admin. Mirrored from [`emdashCommerce/starter`](https://github.com/emdashCommerce/starter). |

More templates will be added as standalone flat repos ship; the CLI picks them up automatically.

## What it does

1. Prompts for a project directory + template
2. Downloads the template via [`giget`](https://github.com/unjs/giget) (fast, no git clone)
3. Runs `install` with your package manager
4. `git init` + initial commit
5. Prints the Stripe + dev-server next steps

## License

MIT — see the monorepo [LICENSE](https://github.com/emdashCommerce/dashcommerce/blob/main/LICENSE).
