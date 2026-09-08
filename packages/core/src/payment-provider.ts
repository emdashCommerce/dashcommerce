/**
 * Public entry point for this fork's PaymentProvider abstraction —
 * `@dashcommerce/core/payment-provider` export. Sibling gateway
 * packages (e.g. a gateway package (e.g. Paystack)) import types from
 * here and call `registerPaymentProvider` at their own module load time.
 */
export type {
	CreateRefundInput,
	InitCheckoutInput,
	InitCheckoutResult,
	Money,
	NormalizedPaymentEvent,
	PaymentProvider,
	PaymentProviderAddress,
	PaymentProviderCredentials,
	PaymentProviderCustomer,
	PaymentProviderLineItem,
	PaymentProviderRuntimeContext,
	RefundResult,
	VerifyWebhookInput,
	VerifyWebhookResult,
} from "./payment-provider/types";
export { stripePaymentProvider } from "./payment-provider/stripe-provider";
export { createMockPaymentProvider } from "./payment-provider/mock-provider";
export {
	getPaymentProvider,
	listPaymentProviders,
	registerPaymentProvider,
	resolveProvider,
	type PaymentProviderId,
} from "./payment-provider/registry";
