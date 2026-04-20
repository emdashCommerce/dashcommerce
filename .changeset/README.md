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

It writes a file like `.changeset/nice-flowers-dance.md`. Commit it with your PR — the rest of the release is automated.

## Release flow (automated)

1. You merge a PR with a changeset file into `main`.
2. The `Release` GitHub Action opens (or updates) a **Version Packages** PR that bumps versions + prepends the changeset summaries to each package CHANGELOG.
3. When you're happy with the accumulated changes, **merge the Version Packages PR**. The same Action then:
   - tags the release
   - runs `bun run release` (builds + `changeset publish`) — `@dashcommerce/core` lands on npm
   - creates per-package GitHub Releases with the CHANGELOG body as the release notes

`@dashcommerce/starter` is `"private": true` in its `package.json`, so it participates in versioning + CHANGELOG but isn't published to npm. The starter gets mirrored to its flat repo by a separate workflow.
