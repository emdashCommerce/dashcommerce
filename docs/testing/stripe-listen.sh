#!/usr/bin/env bash
# Forwards Stripe test-mode events to the local webhook capture proxy.
# Run `stripe login` once first. Copy the whsec_… it prints into
# Settings → Stripe card → Stripe webhook secret.
set -euo pipefail
EVENTS="checkout.session.completed,checkout.session.expired,checkout.session.async_payment_succeeded,checkout.session.async_payment_failed,payment_intent.succeeded,payment_intent.payment_failed,payment_intent.canceled,charge.succeeded,charge.failed,charge.refunded,refund.updated,invoice.paid,invoice.payment_succeeded,invoice.payment_failed,customer.subscription.created,customer.subscription.updated,customer.subscription.deleted,customer.subscription.paused,customer.subscription.resumed,account.updated"
exec stripe listen --events "$EVENTS" \
	--forward-to "localhost:4322/_emdash/api/plugins/dashcommerce/checkout/webhook?provider=stripe"
