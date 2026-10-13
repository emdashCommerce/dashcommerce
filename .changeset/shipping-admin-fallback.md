---
"@dashcommerce/core": patch
---

Stop the shipping admin page from crashing when `data.methods` (or zones/classes) is missing. A flattened EmDash success envelope used to throw `can't access property Symbol.iterator, data.methods is undefined`. Empty lists render instead.

Closes #43.
