# Publishing DashCommerce Lite to the EmDash plugin registry

This package is registry-only. It is `private` in `package.json`, so npm and
`changeset publish` skip it. It publishes as slug `dashcommerce-lite` from
the `dashcommerce.bsky.social` Atmosphere account, pinned in
`emdash-plugin.jsonc` as `did:plc:yakxzbkuhphkc5eepv7p4wrc`.

## Its own listing and plugin id

Lite is a new listing with its own slug and plugin id, `dashcommerce-lite`.
It does not reuse `dashcommerce`, which is the native plugin's id
(`@dashcommerce/core`) and the slug of the existing "DashCommerce Setup"
listing.

- The slug is the plugin id on a site, so it sets the route prefix
  (`/_emdash/api/plugins/dashcommerce-lite/`), the admin pages and the
  storage namespace. A different id means Lite can never collide with an
  installed native plugin.
- Lite and core are still alternatives. Do not install both on one site:
  each runs its own cart, checkout, orders and Stripe webhook.
- The "DashCommerce Setup" listing (slug `dashcommerce`, 0.1.0, a static
  page with install steps for the native plugin, built from
  `packages/registry-setup`, which is in git history) is not touched by
  Lite releases. Sites that installed it do not get Lite as an update.
- The first publish creates the `dashcommerce-lite` package profile from
  `emdash-plugin.jsonc` (name, description, keywords, license, author,
  security contact, and the `sections` copy in `listing/`). The first
  release is 0.2.0, the version in `package.json`.
- Versioning: Lite is in the changesets workspace, so a Lite changeset
  bumps `package.json` through the Version Packages PR. 0.2.0 has never
  been published, so the changesets from #55 and #56 were folded into the
  0.2.0 entry of `CHANGELOG.md` instead of making the first release
  0.2.1. Add a changeset again for changes after 0.2.0.
- The trust contract: `content:read`, `network:request` to
  `api.stripe.com`, and four storage collections (`orders`, `carts`,
  `stock`, `stripe_events`). Sites approve it on install.
- Releases are immutable. Every publish needs a new `version` in
  `package.json`. Bump the minor (0.x) or major (1.x and later) whenever
  `capabilities`, `allowedHosts` or `storage` change.

## Steps

Run from the repo root after `bun install`. The CLI is pinned to
`@emdash-cms/plugin-cli@0.13.4` as a dev dependency.

```sh
cd packages/lite

# Checks
bun run validate
bun run typecheck
bun run test
bun run test:sandbox
bun run bundle && bun run size
tar tzf dist/dashcommerce-lite-0.2.0.tar.gz

# Sign in (opens the Bluesky sign-in page in the browser)
bunx emdash-plugin login dashcommerce.bsky.social

# Confirm the active session is did:plc:yakxzbkuhphkc5eepv7p4wrc
bunx emdash-plugin whoami

# Build, upload to the account's PDS, and write the release record
bunx emdash-plugin publish

# Follow the listing checks until the release is public
bunx emdash-plugin info dashcommerce.bsky.social dashcommerce-lite --version 0.2.0 --watch
```

Then confirm the new listing shows the profile from the manifest:

```sh
bunx emdash-plugin info dashcommerce.bsky.social dashcommerce-lite
```

- Name: DashCommerce Lite
- Description: Sell products from your EmDash content: a cart, Stripe
  Checkout, stock tracking, refunds, tax and shipping, and an orders
  admin. (128 characters; the registry cap is 140.)
- Keywords: commerce, ecommerce, stripe, cart, checkout
- Long description and installation sections: `listing/description.md`
  and `listing/installation.md` (each capped at 2,000 characters;
  `bun run validate` checks this).
- Screenshots: the five 1920x1080 PNGs in `listing/screenshots/`, uploaded
  to the PDS as listing images. Do not move them to a top-level
  `screenshots/` folder: `emdash-plugin bundle` copies that folder into
  the plugin tarball, where the 128 KB per file cap applies.

Later profile edits use `bunx emdash-plugin update-package --manifest
./emdash-plugin.jsonc` (dry run first, then `--yes`). Do not run it against
the `dashcommerce` (Setup) listing.

## Troubleshooting

- `MANIFEST_PUBLISHER_MISMATCH`: another account is active. Run
  `bunx emdash-plugin switch did:plc:yakxzbkuhphkc5eepv7p4wrc`.
- `MISSING_BLOB_SCOPE`: run `bunx emdash-plugin logout` and log in again.
- Size check fails: the registry caps are 128 KB per file and 256 KB per
  release. `bun run size` reports both.

## Before the first public release

- [x] Screenshots for the listing (`listing/screenshots/`, captured from
  the Cloudflare test deployment).
- [x] A run against a real Cloudflare deployment (Workers Paid) to confirm
  every request stays inside the subrequest limit (see DESIGN.md,
  "Cloudflare limits").
- [x] An end-to-end payment with Stripe test keys and a real webhook
  endpoint.
- [ ] Merge this listing prep, then publish 0.2.0 from `main`.
