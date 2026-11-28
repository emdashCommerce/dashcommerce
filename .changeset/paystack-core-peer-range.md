---
"@dashcommerce/paystack": patch
---

Accept any core from 0.4.0 up to 1.0 as a peer (`>=0.4.0 <1.0.0`), and have changesets bump a package for a peer change only when the new peer version falls outside its range. Before this, every core minor release (0.4 to 0.5, and later ones) counted as a breaking peer change, so core's 0.5.0 release would have published this package as 1.0.0 instead of 0.1.0. The package's tests run against the current core on every pull request, so each core release from this repository is tested with it.
