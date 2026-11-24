---
"@dashcommerce/core": patch
---

Docs: an on-page checkout's `client` data is public. `create-session` sends it to the browser, so provider authors must never put a secret key or webhook secret in it.
