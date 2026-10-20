# Changesets

We use [changesets](https://github.com/changesets/changesets) to manage versions, CHANGELOGs, and releases.

## Contributing workflow

When you open a PR that changes a published package, add a changeset:

```sh
bun changeset
```

That opens an interactive prompt:

1. **Which packages changed?** Pick `@dashcommerce/core`, `@dashcommerce/starter`, or both.
2. **What kind of change?** `patch` (bug fix, docs), `minor` (new feature, additive), `major` (breaking). Follow [SemVer](https://semver.org/).
3. **Summary?** One-line description — lands verbatim in the package CHANGELOG, so write it for a user reading the changelog, not for the reviewer.

It writes a file like `.changeset/nice-flowers-dance.md`. Commit it with your PR.

## Release flow

1. You merge a PR with a changeset file into `main`.
2. The `Release` GitHub Action opens (or updates) a **Version Packages** PR that bumps versions + prepends the changeset summaries to each package CHANGELOG.
3. When you're happy with the accumulated changes, **merge the Version Packages PR**. That lands the version bumps on `main`. It does **not** publish to npm from Actions.
4. On that push to `main`, the `Release` workflow also sees that `@dashcommerce/core` has a version with no git tag yet. It creates the tag `v<version>` (for example `v0.3.2`) on that commit and a GitHub Release with the matching `packages/core/CHANGELOG.md` entry as its notes. This is automatic. Pushes that do not change the core version do nothing here, and re-runs do not create duplicates. To retry by hand, run the `Release` workflow from the Actions tab (`workflow_dispatch`).
5. npm publish is still manual. Publish from a machine that is logged into npm:

```sh
cd packages/core
npm publish --access public
```

`@dashcommerce/starter` is `"private": true` in its `package.json`, so it participates in versioning + CHANGELOG but isn't published to npm. The starter gets mirrored to its flat repo by a separate workflow. It gets no git tag or GitHub Release of its own: `v*` tags and releases track `@dashcommerce/core` only.
