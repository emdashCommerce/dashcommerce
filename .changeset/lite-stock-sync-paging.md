---
"@dashcommerce/lite": patch
---

Stock sync now walks the whole catalog: each click checks one page of 100 published products, oldest first, keeps its place in plugin KV and continues on the next click, so tracked products past the first 100 get stock rows. Each click stays within 8 bridge calls. The settings toast now counts only changed settings and says how many submitted values already matched.
