## Summary

<!-- What changed and why. Link the issue or discussion. -->

Closes #

## Type

- [ ] Bug fix
- [ ] Feature
- [ ] Payment provider package
- [ ] Docs or templates
- [ ] Refactor / internal
- [ ] Breaking change

## Affected packages

- [ ] `@dashcommerce/core`
- [ ] `@dashcommerce/starter`
- [ ] `@dashcommerce/lite`
- [ ] `@dashcommerce/create`
- [ ] `@dashcommerce/<provider>` (new or updated provider)
- [ ] `registry-setup`
- [ ] Docs or templates

## Tests

<!-- Commands you ran, and what they cover. -->

- [ ] `bun run typecheck`
- [ ] `bun run build`
- [ ] `bun test`
- [ ] `bun run --cwd packages/lite validate`
- [ ] `bun run --cwd packages/lite test`
- [ ] Tested against a real store or test-mode provider (describe below)

```text
paste command output or a short description
```

## Changeset

- [ ] Added with `bun run changeset`
- [ ] Not needed (docs or templates only)

## Provider checklist (only for provider packages)

- [ ] API facts checked against the provider's docs, not assumed
- [ ] Hosted and/or on-page checkout described
- [ ] Webhook signature scheme and headers documented
- [ ] Refunds and refund webhooks covered
- [ ] Split payments / multi-vendor covered, or explicitly `false`
- [ ] `allowedHosts` documented
- [ ] Test-mode evidence included (real checkout, webhook, refund)
- [ ] No keys, secrets or customer data in the diff

## Breaking change

<!-- If yes, what breaks and what is the migration? -->

## Screenshots or logs

<!-- Optional. Remove secrets and customer data. -->

## Checklist

- [ ] I read `CONTRIBUTING.md`.
- [ ] The PR is focused on one concern.
- [ ] I added or updated tests for behaviour changes.
- [ ] I updated the README or docs where behaviour changed.
- [ ] I did not include API keys, webhook secrets or customer data.
