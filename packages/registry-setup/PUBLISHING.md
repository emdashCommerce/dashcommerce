# Publishing to the EmDash plugin registry

This package is registry-only. It is `private` in `package.json`, so npm and `changeset publish` skip it. Publishing goes to the `dashcommerce.bsky.social` Atmosphere account, pinned in `emdash-plugin.jsonc` as `did:plc:yakxzbkuhphkc5eepv7p4wrc`.

Run these from the repo root after `bun install`. The CLI is pinned to `@emdash-cms/plugin-cli@0.13.4` as a dev dependency, so `bunx emdash-plugin` uses that version.

```sh
cd packages/registry-setup

# Check before publishing
bun run test
bunx emdash-plugin bundle
tar tzf dist/dashcommerce-0.1.1.tar.gz

# Sign in (opens the Bluesky sign-in page in the browser)
bunx emdash-plugin login dashcommerce.bsky.social

# Confirm the active session is did:plc:yakxzbkuhphkc5eepv7p4wrc
bunx emdash-plugin whoami

# Build, upload to the account's PDS, and write the release record
bunx emdash-plugin publish

# Follow the listing checks until the release is public
bunx emdash-plugin info dashcommerce.bsky.social dashcommerce --version 0.1.1 --watch
```

Notes:

- `publish` fails with `MANIFEST_PUBLISHER_MISMATCH` if another account is active. Run `bunx emdash-plugin switch did:plc:yakxzbkuhphkc5eepv7p4wrc`.
- If it reports `MISSING_BLOB_SCOPE`, run `bunx emdash-plugin logout` and log in again.
- Releases are immutable. Bump `version` in `package.json` before publishing again, and use a major bump if `capabilities`, `allowedHosts` or `storage` ever change.
- The first publish creates the package profile (name, description, keywords). Later changes to those fields go through `bunx emdash-plugin update-package` (dry run) and `bunx emdash-plugin update-package --yes`.
