---
"@dashcommerce/starter": patch
---

Pre-bundle the Stripe packages in dev, so the first visit to `/checkout` no longer makes Vite re-optimise and reload. That reload left open admin tabs with two copies of React and an "Invalid hook call" crash.
