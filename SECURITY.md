# Security policy

## Supported versions

Security fixes target the latest released minor line and `main`. Older lines that are still in use are handled case by case. See the **Current Release** table in [`README.md`](./README.md) for the current version and the supported EmDash peer range.

## Reporting a vulnerability

**Do not open a public issue.** Report privately through GitHub's private vulnerability reporting:

https://github.com/emdashCommerce/dashcommerce/security/advisories/new

Please include:

- the affected package and version, or the commit on `main`;
- the EmDash version and runtime (Cloudflare Workers or Node; D1, Postgres or SQLite);
- a minimal reproduction or proof of concept;
- the impact you believe it has;
- any suggested fix or mitigation.

We aim to acknowledge a report within 3 business days and will keep you updated while we investigate. Please give us a reasonable window to fix and release before public disclosure.

## Scope

In scope:

- `@dashcommerce/core`
- `@dashcommerce/starter`
- `@dashcommerce/lite`
- `@dashcommerce/create`
- payment provider packages in this repository
- the registry setup

Out of scope:

- vulnerabilities in EmDash itself — report those to the EmDash project;
- vulnerabilities in Stripe, Paystack, Flutterwave or another provider's API;
- issues that require a compromised merchant account, leaked API keys or an already-compromised host.
