#!/usr/bin/env bash
# Print the CHANGELOG entry for one version, without its "## <version>" heading.
#
# Usage: release-notes.sh <version> [changelog]
#   version    e.g. 0.3.2 (no leading "v")
#   changelog  defaults to packages/core/CHANGELOG.md
#
# Exits 1 if the changelog has no "## <version>" heading or the entry is empty.
# Used by .github/workflows/release.yml to build GitHub Release notes.
set -euo pipefail

version="${1:?usage: release-notes.sh <version> [changelog]}"
changelog="${2:-packages/core/CHANGELOG.md}"

notes="$(
	awk -v v="$version" '
		/^## / {
			if (found) exit
			heading = $0
			sub(/^## +/, "", heading)
			sub(/[ \t]+$/, "", heading)
			if (heading == v) { found = 1; next }
		}
		found { print }
	' "$changelog"
)"

# Drop leading blank lines. $(...) already strips trailing newlines.
notes="$(printf '%s\n' "$notes" | sed -e '/./,$!d')"

if [ -z "$notes" ]; then
	echo "No CHANGELOG entry for ${version} in ${changelog}" >&2
	exit 1
fi

printf '%s\n' "$notes"
