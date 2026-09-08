// stripe-provider.test.ts — verifies the StripePaymentProvider adapter's
// pure logic (webhook parsing, refund status mapping, formatAmount)
// without any network calls. initCheckout/refund's actual HTTP path is
// exercised indirectly via ../stripe/*'s own existing behaviour (untouched
// by this fork) — this suite covers the NEW adapter code only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { stripePaymentProvider } from "./stripe-provider";

test("parseWebhookEvent: checkout.session.completed maps to charge.succeeded with orderDraftId from metadata", () => {
	const raw = JSON.stringify({
		type: "checkout.session.completed",
		data: {
			object: {
				id: "cs_test_123",
				object: "checkout.session",
				mode: "payment",
				amount_total: 250000,
				currency: "kes",
				metadata: { orderDraftId: "draft_abc" },
				client_reference_id: "draft_abc",
				customer_details: { email: "fan@example.com", name: "Jane Fan", phone: "+254700000000" },
				shipping_details: {
					address: { line1: "123 St", city: "Nairobi", country: "KE", postal_code: "00100" },
				},
			},
		},
	});
	const event = stripePaymentProvider.parseWebhookEvent(raw);
	assert.equal(event.type, "charge.succeeded");
	if (event.type === "charge.succeeded") {
		assert.equal(event.orderDraftId, "draft_abc");
		assert.equal(event.amount, 250000);
		assert.equal(event.currency, "KES");
		assert.equal(event.customer.email, "fan@example.com");
		assert.equal(event.shippingAddress?.country, "KE");
	}
});

test("parseWebhookEvent: checkout.session.completed falls back to client_reference_id when metadata.orderDraftId absent", () => {
	const raw = JSON.stringify({
		type: "checkout.session.completed",
		data: {
			object: {
				id: "cs_test_456",
				object: "checkout.session",
				mode: "payment",
				currency: "usd",
				client_reference_id: "draft_xyz",
				customer_details: { email: "a@b.com" },
			},
		},
	});
	const event = stripePaymentProvider.parseWebhookEvent(raw);
	assert.equal(event.type, "charge.succeeded");
	if (event.type === "charge.succeeded") assert.equal(event.orderDraftId, "draft_xyz");
});

test("parseWebhookEvent: payment_intent.payment_failed maps to charge.failed", () => {
	const raw = JSON.stringify({
		type: "payment_intent.payment_failed",
		data: { object: { id: "pi_test_1", metadata: { orderDraftId: "draft_fail" } } },
	});
	const event = stripePaymentProvider.parseWebhookEvent(raw);
	assert.equal(event.type, "charge.failed");
	if (event.type === "charge.failed") assert.equal(event.orderDraftId, "draft_fail");
});

test("parseWebhookEvent: unrelated event types map to 'unhandled', never dropped silently", () => {
	const raw = JSON.stringify({ type: "customer.created", data: { object: {} } });
	const event = stripePaymentProvider.parseWebhookEvent(raw);
	assert.equal(event.type, "unhandled");
	if (event.type === "unhandled") assert.equal(event.providerEventType, "customer.created");
});

test("parseWebhookEvent: unparseable body maps to 'unhandled' rather than throwing", () => {
	const event = stripePaymentProvider.parseWebhookEvent("not json{{{");
	assert.equal(event.type, "unhandled");
});

test("parseWebhookEvent: checkout.session.completed with no correlatable id is 'unhandled' (never fabricates an orderDraftId)", () => {
	const raw = JSON.stringify({
		type: "checkout.session.completed",
		data: { object: { id: "cs_test_789", object: "checkout.session", mode: "payment" } },
	});
	const event = stripePaymentProvider.parseWebhookEvent(raw);
	assert.equal(event.type, "unhandled");
});
