---
"@dashcommerce/core": patch
---

Preserve raw Web `Response` objects on EmDash 1.2 (cart `Set-Cookie`, Stripe webhook bodies) without defaulting `response: "raw"`, which fails typecheck on 0.37 and strips cookies on unpatched 1.x. Ship a version-exact 1.2.0 patch that clones the request body and duck-types `Response`, warn when the host version has no matching patch, and fail loudly if a webhook arrives with the body already consumed.

Thanks [@moset15](https://github.com/moset15) for the original routing fix in #42.
