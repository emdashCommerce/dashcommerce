# DashCommerce Deployment Checklist

Quick reference for operators deploying DashCommerce on Railway, Heroku, GCP, AWS, or any reverse proxy setup.

## Required Environment Variables

Set these before first deployment:

```bash
# Required: Public site URL (no trailing slash)
SITE_URL=https://your-domain.com

# Required: Database connection
DATABASE_URL=postgresql://...

# Required: Stripe keys (test or live)
STRIPE_SECRET_KEY=sk_test_...
STRIPE_PUBLISHABLE_KEY=pk_test_...

# Optional: S3/R2 for media storage
S3_BUCKET=your-bucket
S3_REGION=us-east-1
S3_ACCESS_KEY_ID=...
S3_SECRET_ACCESS_KEY=...
S3_ENDPOINT=https://...  # For R2/Cloudflare

# Optional: Email provider
RESEND_API_KEY=re_...
EMAIL_FROM=noreply@your-domain.com
```

## Post-Deployment Database Check

After first deployment, verify site URL options are correct:

```sql
-- Check current values
SELECT key, value FROM options WHERE key LIKE '%site%';

-- Expected output:
-- emdash:site_url | "https://your-domain.com"
-- site:url        | "https://your-domain.com"

-- Fix if stale:
UPDATE options 
SET value = '"https://your-domain.com"'
WHERE key = 'emdash:site_url';
```

## Common Issues

### Stripe redirects to localhost

**Symptom:** After checkout, browser redirects to `http://localhost:8080/thank-you/...`

**Cause:** Either `SITE_URL` not set, or stale `emdash:site_url` database option

**Fix:**
1. Verify `SITE_URL` environment variable is set correctly
2. Redeploy to pick up environment change
3. Run SQL to fix database option (see above)
4. Check logs for "Site URL is localhost" warnings

### Admin invite links use localhost

**Symptom:** Vendor onboarding emails contain `http://localhost:8080/vendor/...`

**Cause:** Same as above - stale database option or missing `SITE_URL`

**Fix:** Same as above

### Domain change not taking effect

**Symptom:** After changing domain, old domain still appears in redirects

**Cause:** Database option not updated after domain change

**Fix:**
```sql
UPDATE options 
SET value = '"https://new-domain.com"'
WHERE key IN ('emdash:site_url', 'site:url');
```

Then redeploy or restart the application.

## Platform-Specific Notes

### Railway
- `SITE_URL` set in project Environment Variables
- Auto-deploys on git push
- Internal routing uses `localhost:8080` by default
- Public domain handled by Railway proxy

### Heroku
- `SITE_URL` set via `heroku config:set SITE_URL=...`
- Use `heroku pg:psql` to run database queries
- Internal routing uses `0.0.0.0:$PORT`

### Cloudflare Workers/Pages
- `SITE_URL` set in wrangler.toml vars or dashboard
- No reverse proxy issues (Workers run at edge)
- Use D1/R2 bindings for storage

### Docker Compose / Kubernetes
- `SITE_URL` set via environment in compose/deployment yaml
- May need to configure ingress/load balancer for domain
- Internal container network uses localhost or service names

## Verification Commands

```bash
# Check environment variable
echo $SITE_URL

# Check database option (requires DB access)
psql $DATABASE_URL -c "SELECT key, value FROM options WHERE key LIKE '%site%';"

# Test checkout redirect (after adding item to cart)
curl -X POST https://your-domain.com/_emdash/api/plugins/dashcommerce/checkout/create-session \
  -H "Content-Type: application/json" \
  -d '{"notes":"test"}' \
  | jq .url

# Should return a Stripe URL with success_url=https://your-domain.com/thank-you/...
```

## Monitoring

Watch application logs for:
- `"Site URL is localhost - set SITE_URL for production"` - Indicates misconfiguration
- `"ctx.site.url is not configured"` - SITE_URL environment variable is missing
- Stripe webhook errors - May indicate redirect URL issues

## Emergency Rollback

If this fix causes issues:

1. Revert PR #25
2. Redeploy previous version
3. File issue with logs and database state

## Support

- Documentation: [`LOCALHOST_REDIRECT_FIX.md`](./LOCALHOST_REDIRECT_FIX.md)
- GitHub Issues: https://github.com/emdashCommerce/dashcommerce/issues
- PR: https://github.com/emdashCommerce/dashcommerce/pull/25
