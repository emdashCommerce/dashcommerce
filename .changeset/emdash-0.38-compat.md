---
"@dashcommerce/core": patch
---

Widen `emdash` peer dependency to allow 0.38.x alongside existing 0.37.x support. EmDash 0.38 adds entry edit locks (migration `075_entry_edit_locks`), atomic `ctx.storage.<collection>.updateIf()` for conditional updates, SEO `<EmDashHead>` overlay, collection grouping, and Portable Text table enhancements. DashCommerce installations on EmDash 0.37.x continue to work; 0.38.x installs now pass peer checks.

**For plugin authors using DashCommerce:**
- Content update/publish APIs may now return `409 ENTRY_LOCKED` when an editor has the entry open. Pass `overrideLock: true` in request body or `?overrideLock=true` on DELETE to bypass.
- Consider using `ctx.storage.<collection>.updateIf()` for atomic stock/inventory decrements instead of read-modify-write patterns.
- EmDash auto-migrates on default settings; manual migration projects should run `emdash migrate` before deploying.
