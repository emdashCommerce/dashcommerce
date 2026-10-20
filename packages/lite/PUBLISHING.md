# Publishing DashCommerce to the EmDash plugin registry

This package is registry-only. It is `private` in `package.json`, so npm and
`changeset publish` skip it. It publishes as slug `dashcommerce` from the
`dashcommerce.bsky.social` Atmosphere account, pinned in
`emdash-plugin.jsonc` as `did:plc:yakxzbkuhphkc5eepv7p4wrc`.

## It supersedes the setup listing

The `dashcommerce` listing already exists. Its 0.1.0 release was a setup
page (no capabilities) that showed install steps for the native plugin. It
was built from `packages/registry-setup`, which has been removed from this
repo; the source is in git history (merged in #50). 0.2.0 from this package
is the next release of the same listing, so sites that installed the setup
page get the store as an update.

- Same slug and publisher, so no new listing is created.
- The trust contract changes: 0.1.0 asked for nothing; 0.2.0 asks for
  `content:read`, `network:request` to `api.stripe.com`, and four storage
  collections. Sites must approve the new access when they update. In 0.x
  the minor bump (0.1 to 0.2) is the breaking-change bump.
- The minimum host moves from EmDash 1.1 to `>=1.3.0 <2.0.0`.
- This package is now the only source for the `dashcommerce` listing.
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
tar tzf dist/dashcommerce-0.2.0.tar.gz

# Sign in (opens the Bluesky sign-in page in the browser)
bunx emdash-plugin login dashcommerce.bsky.social

# Confirm the active session is did:plc:yakxzbkuhphkc5eepv7p4wrc
bunx emdash-plugin whoami

# Build, upload to the account's PDS, and write the release record
bunx emdash-plugin publish

# Follow the listing checks until the release is public
bunx emdash-plugin info dashcommerce.bsky.social dashcommerce --version 0.2.0 --watch
```

Then update the package profile (next section). The 0.2.0 release is not
done until the listing shows the new name and description.

## Update the package profile (part of the 0.2.0 release)

Publishing a release does not change the package profile. The profile was
created by the 0.1.0 publish and still reads:

- Name: DashCommerce Setup
- Description: Setup guide for DashCommerce. The full store installs from
  npm as @dashcommerce/core; this listing shows the install steps in your
  admin.
- Keywords: commerce, ecommerce, stripe, store, setup

After `publish` succeeds and `info --watch` shows 0.2.0 as public, run from
`packages/lite` with the same signed-in session:

```sh
# Dry run: prints the diff and writes nothing
bunx emdash-plugin update-package --manifest ./emdash-plugin.jsonc

# Apply it
bunx emdash-plugin update-package --manifest ./emdash-plugin.jsonc --yes

# Confirm the listing shows the new name and description
bunx emdash-plugin info dashcommerce.bsky.social dashcommerce
```

Add `--json` to either `update-package` call for machine-readable output.

The dry run should show exactly these changes, all taken from
`emdash-plugin.jsonc`:

- Name: DashCommerce
- Description: Sell products from your EmDash content with a cart, Stripe
  Checkout, stock tracking, refunds, flat tax and shipping, and CSV order
  export.
- Keywords: commerce, ecommerce, stripe, cart, checkout

The registry caps the description at 140 characters; this one is 138.

License (MIT), author (Timchosen Uzua) and the security contact are the
same as on the existing profile. If the dry run shows other differences,
stop and check them before running with `--yes`.

## Troubleshooting

- `MANIFEST_PUBLISHER_MISMATCH`: another account is active. Run
  `bunx emdash-plugin switch did:plc:yakxzbkuhphkc5eepv7p4wrc`.
- `MISSING_BLOB_SCOPE`: run `bunx emdash-plugin logout` and log in again.
- Size check fails: the registry caps are 128 KB per file and 256 KB per
  release. `bun run size` reports both.

## Before the first public release

- Screenshots for the listing (orders page, order detail, settings).
- A run against a real Cloudflare deployment to confirm checkout stays
  inside the subrequest limit (see DESIGN.md, "Cloudflare limits").
- An end-to-end payment with Stripe test keys and a real webhook endpoint.
