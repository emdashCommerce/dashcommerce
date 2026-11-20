---
"@dashcommerce/core": patch
---

Make the admin readable in EmDash's dark mode (#44). Admin pages, fields and widgets now take their colours from EmDash's theme tokens, so they follow the host's light or dark mode. Light fallbacks cover hosts without those tokens, and the existing `--dc-*` variables still override. Status badge colours are unchanged.
