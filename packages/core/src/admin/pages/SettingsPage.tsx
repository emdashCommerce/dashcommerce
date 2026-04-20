/**
 * DashCommerce admin settings page.
 *
 * Source of truth for field validation is server-side:
 * `packages/core/src/settings/schema.ts` is imported both here (for inline
 * constraints) and by the admin API POST handler (for rejection). The UI
 * never invents its own rules.
 *
 * Secrets arrive from the GET endpoint under `_secrets` as
 * `{ isSet, hint }` — the form renders them as placeholders and only
 * sends a new value when the operator actually types one.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	Alert,
	Button,
	Card,
	Combobox,
	FormField,
	Input,
	Loading,
	MultiSelect,
	NumberInput,
	Select,
	Toggle,
	currencyOptions,
	toast,
	usePluginAPI,
} from "../kit";
import type { CheckoutMode, TaxMode } from "../../settings/schema";

type Group = "store" | "reviews" | "downloads" | "marketing" | "connect" | "stripe";

interface GroupSpec {
	id: Group;
	title: string;
	description?: string;
}

const GROUPS: GroupSpec[] = [
	{
		id: "store",
		title: "Store",
		description:
			"Currency defaults. Only codes listed as enabled can be used at checkout.",
	},
	{
		id: "stripe",
		title: "Stripe",
		description: "API keys used for charges, refunds, and webhook verification.",
	},
	{
		id: "reviews",
		title: "Reviews",
		description: "Moderation defaults for customer product reviews.",
	},
	{
		id: "downloads",
		title: "Digital downloads",
		description:
			"Controls how long signed download URLs stay valid and how many times each link can be used.",
	},
	{
		id: "marketing",
		title: "Marketing",
		description: "Abandoned-cart cadence and recovery token lifetime.",
	},
	{
		id: "connect",
		title: "Multi-vendor marketplace (Stripe Connect)",
		description:
			"Enable to onboard vendors and split payouts on each sale. Disable to run as a single seller.",
	},
];

interface SettingsShape {
	defaultCurrency: string | null;
	enabledCurrencies: string[] | null;
	taxMode: TaxMode | null;
	flatTaxRatePercent: number | null;
	taxAppliesToShipping: boolean | null;
	reviewsRequireApproval: boolean | null;
	reviewsRequirePurchase: boolean | null;
	downloadTokenTtlHours: number | null;
	downloadMaxUses: number | null;
	downloadGrantExpiryDays: number | null;
	abandonedCartDelayHours: number | null;
	abandonedCartTokenTtlDays: number | null;
	connectEnabled: boolean | null;
	connectPlatformFeePercent: number | null;
	// Secrets are never sent down (server omits them), but the draft
	// accepts strings when the operator types a new value to commit.
	stripeSecretKey: string | null;
	stripePublishableKey: string | null;
	stripeWebhookSecret: string | null;
	checkoutMode: CheckoutMode | null;
	_secrets: Record<string, { isSet: boolean; hint: string | null }>;
}

type Draft = Partial<Omit<SettingsShape, "_secrets">>;

function isEqual(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (Array.isArray(a) && Array.isArray(b)) {
		if (a.length !== b.length) return false;
		return a.every((v, i) => isEqual(v, b[i]));
	}
	return false;
}

export function SettingsPage() {
	const api = usePluginAPI();
	const [saved, setSaved] = useState<SettingsShape | null>(null);
	const [draft, setDraft] = useState<Draft>({});
	const [saving, setSaving] = useState(false);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [errors, setErrors] = useState<Record<string, string>>({});
	const touched = useRef(new Set<keyof Draft>());

	const reload = useCallback(async () => {
		setLoadError(null);
		try {
			const s = await api.get<SettingsShape>("admin/settings");
			setSaved(s);
			setDraft({});
			setErrors({});
			touched.current.clear();
		} catch (err) {
			setLoadError(err instanceof Error ? err.message : "Failed to load settings");
		}
	}, [api]);

	useEffect(() => {
		reload();
	}, [reload]);

	const effective = useCallback(
		<K extends keyof Draft>(key: K): Draft[K] | undefined => {
			if (key in draft) return draft[key];
			return saved?.[key];
		},
		[draft, saved],
	);

	function setField<K extends keyof Draft>(key: K, value: Draft[K]): void {
		const baseline = saved?.[key];
		const nextDraft: Draft = { ...draft };
		if (isEqual(value, baseline)) {
			delete nextDraft[key];
			touched.current.delete(key);
		} else {
			nextDraft[key] = value;
			touched.current.add(key);
		}
		setDraft(nextDraft);
		setErrors((e) => {
			if (!(key in e)) return e;
			const copy = { ...e };
			delete copy[key as string];
			return copy;
		});
	}

	const dirtyKeys = useMemo(() => Object.keys(draft) as Array<keyof Draft>, [draft]);
	const isDirty = dirtyKeys.length > 0;

	async function saveAll(): Promise<void> {
		if (!isDirty) return;
		setSaving(true);
		setErrors({});
		try {
			const payload: Record<string, unknown> = {};
			for (const key of dirtyKeys) {
				payload[key as string] = draft[key];
			}
			await api.post("admin/settings", payload);
			await reload();
			toast.success("Settings saved");
		} catch (err) {
			if (err && typeof err === "object" && "body" in err) {
				const body = (err as { body?: unknown }).body as
					| { errors?: Record<string, string>; error?: string }
					| undefined;
				if (body?.errors) {
					setErrors(body.errors);
					toast.error(
						"Some fields need attention",
						"Review the highlighted inputs.",
					);
					return;
				}
				if (body?.error) {
					toast.error("Save failed", body.error);
					return;
				}
			}
			toast.error(
				"Save failed",
				err instanceof Error ? err.message : "Unknown error",
			);
		} finally {
			setSaving(false);
		}
	}

	function discardAll(): void {
		setDraft({});
		setErrors({});
		touched.current.clear();
	}

	if (loadError) {
		return (
			<Card title="Settings">
				<Alert type="error" title="Could not load settings">
					{loadError}
				</Alert>
				<Button variant="primary" onClick={reload}>
					Retry
				</Button>
			</Card>
		);
	}
	if (!saved) return <Loading />;

	const connectEnabled = !!effective("connectEnabled");
	const enabledCurrencies =
		(effective("enabledCurrencies") as string[] | null | undefined) ?? [];

	const needsStripeKey = !saved._secrets?.stripeSecretKey?.isSet;

	return (
		<div
			style={{ display: "flex", flexDirection: "column", gap: 16, paddingBottom: 80 }}
		>
			{needsStripeKey && (
				<Alert type="warning" title="Finish setup">
					Add a Stripe secret key below to start accepting payments. Test keys
					start with <code>sk_test_</code>. Grab them at{" "}
					<a
						href="https://dashboard.stripe.com/test/apikeys"
						target="_blank"
						rel="noreferrer"
					>
						dashboard.stripe.com/test/apikeys
					</a>
					.
				</Alert>
			)}

			<Alert type="info" title="Tax settings live in Tax">
				Tax mode and rates are configured on the dedicated Tax page to keep
				flat-rate, table, and Stripe Tax controls in one place.
			</Alert>

			{GROUPS.map((group) => (
				<Card key={group.id} title={group.title}>
					{group.description && (
						<p
							style={{
								color: "#666",
								margin: "0 0 0.75rem",
								fontSize: "0.9em",
							}}
						>
							{group.description}
						</p>
					)}
					<GroupBody
						group={group.id}
						saved={saved}
						draft={draft}
						errors={errors}
						enabledCurrencies={enabledCurrencies}
						connectEnabled={connectEnabled}
						setField={setField}
						disabled={saving}
					/>
				</Card>
			))}

			<StickyBar
				isDirty={isDirty}
				dirtyCount={dirtyKeys.length}
				saving={saving}
				onSave={saveAll}
				onDiscard={discardAll}
			/>
		</div>
	);
}

interface GroupBodyProps {
	group: Group;
	saved: SettingsShape;
	draft: Draft;
	errors: Record<string, string>;
	enabledCurrencies: string[];
	connectEnabled: boolean;
	setField: <K extends keyof Draft>(key: K, value: Draft[K]) => void;
	disabled: boolean;
}

function eff<K extends keyof Draft>(
	key: K,
	saved: SettingsShape,
	draft: Draft,
): Draft[K] | undefined {
	if (key in draft) return draft[key];
	return saved[key] as Draft[K] | undefined;
}

function GroupBody({
	group,
	saved,
	draft,
	errors,
	enabledCurrencies,
	connectEnabled,
	setField,
	disabled,
}: GroupBodyProps) {
	if (group === "store") {
		const defaultCurrency = (eff("defaultCurrency", saved, draft) as string | null) ?? null;
		return (
			<>
				<FormField
					label="Enabled currencies"
					description="Customers can only check out in these currencies. Add the codes your pricing supports."
					error={errors.enabledCurrencies}
				>
					<MultiSelect
						value={enabledCurrencies}
						onChange={(next) => setField("enabledCurrencies", next)}
						options={currencyOptions()}
						placeholder="Add a currency…"
						disabled={disabled}
						{...(errors.enabledCurrencies ? { invalid: true } : {})}
						minItems={1}
					/>
				</FormField>
				<FormField
					label="Default currency"
					description="Used when a shopper's preferred currency can't be determined. Must be one of the enabled currencies above."
					error={errors.defaultCurrency}
				>
					<Combobox
						value={defaultCurrency}
						onChange={(next) => setField("defaultCurrency", next ?? null)}
						options={currencyOptions(enabledCurrencies)}
						placeholder={
							enabledCurrencies.length === 0
								? "Enable at least one currency first"
								: "Select default currency"
						}
						disabled={disabled || enabledCurrencies.length === 0}
						{...(errors.defaultCurrency ? { invalid: true } : {})}
					/>
				</FormField>
			</>
		);
	}

	if (group === "stripe") {
		const pkValue = (eff("stripePublishableKey", saved, draft) as string | null) ?? "";
		const checkoutModeValue =
			(eff("checkoutMode", saved, draft) as CheckoutMode | null) ?? "hosted";
		return (
			<>
				<FormField
					label="Checkout flow"
					description="Hosted redirects the customer to a Stripe-hosted page (less PCI scope, mobile-friendly, minimal UI to maintain). Embedded keeps the payment form on your storefront using Stripe Elements."
					error={errors.checkoutMode}
				>
					<Select
						value={checkoutModeValue}
						options={[
							{ value: "hosted", label: "Hosted by Stripe (recommended)" },
							{ value: "embedded", label: "Embedded (Stripe Elements on-site)" },
						]}
						onChange={(e) =>
							setField("checkoutMode", e.currentTarget.value as CheckoutMode)
						}
						disabled={disabled}
					/>
				</FormField>
				<SecretField
					keyName="stripeSecretKey"
					label="Stripe secret key"
					description="Test keys start with sk_test_, live keys with sk_live_. Never shared with the browser."
					saved={saved}
					draft={draft}
					errors={errors}
					setField={setField}
					disabled={disabled}
				/>
				<FormField
					label="Stripe publishable key"
					description="pk_test_ or pk_live_. Safe to expose in the storefront bundle."
					error={errors.stripePublishableKey}
				>
					<Input
						value={pkValue}
						onChange={(e) => setField("stripePublishableKey", e.currentTarget.value)}
						placeholder="pk_test_…"
						disabled={disabled}
						autoComplete="off"
					/>
				</FormField>
				<SecretField
					keyName="stripeWebhookSecret"
					label="Stripe webhook secret"
					description="whsec_… from `stripe listen` or the webhooks page."
					saved={saved}
					draft={draft}
					errors={errors}
					setField={setField}
					disabled={disabled}
				/>
				<StripePing />
			</>
		);
	}

	if (group === "reviews") {
		const requireApproval = !!eff("reviewsRequireApproval", saved, draft);
		const requirePurchase = !!eff("reviewsRequirePurchase", saved, draft);
		return (
			<>
				<FormField
					description="New reviews stay in the pending queue until you approve them."
					error={errors.reviewsRequireApproval}
				>
					<Toggle
						label="Require moderator approval"
						checked={requireApproval}
						onChange={(v) => setField("reviewsRequireApproval", v)}
						disabled={disabled}
					/>
				</FormField>
				<FormField
					description="Only customers with a completed order for the product can leave a review."
					error={errors.reviewsRequirePurchase}
				>
					<Toggle
						label="Verified purchase required"
						checked={requirePurchase}
						onChange={(v) => setField("reviewsRequirePurchase", v)}
						disabled={disabled}
					/>
				</FormField>
			</>
		);
	}

	if (group === "downloads") {
		return (
			<>
				<FormField
					label="Download token TTL (hours)"
					description="How long a signed download URL stays valid after first access."
					error={errors.downloadTokenTtlHours}
				>
					<NumberInput
						value={eff("downloadTokenTtlHours", saved, draft) as number | null | undefined}
						onChange={(v) => setField("downloadTokenTtlHours", v ?? null)}
						min={1}
						max={8760}
						suffix="hours"
						disabled={disabled}
						{...(errors.downloadTokenTtlHours ? { invalid: true } : {})}
					/>
				</FormField>
				<FormField
					label="Download max uses"
					description="Maximum number of times a single download link can be redeemed."
					error={errors.downloadMaxUses}
				>
					<NumberInput
						value={eff("downloadMaxUses", saved, draft) as number | null | undefined}
						onChange={(v) => setField("downloadMaxUses", v ?? null)}
						min={1}
						max={10000}
						disabled={disabled}
						{...(errors.downloadMaxUses ? { invalid: true } : {})}
					/>
				</FormField>
				<FormField
					label="Download grant expiry (days)"
					description="How long a customer keeps access after purchase before the grant expires."
					error={errors.downloadGrantExpiryDays}
				>
					<NumberInput
						value={eff("downloadGrantExpiryDays", saved, draft) as number | null | undefined}
						onChange={(v) => setField("downloadGrantExpiryDays", v ?? null)}
						min={1}
						max={3650}
						suffix="days"
						disabled={disabled}
						{...(errors.downloadGrantExpiryDays ? { invalid: true } : {})}
					/>
				</FormField>
			</>
		);
	}

	if (group === "marketing") {
		return (
			<>
				<FormField
					label="Abandoned-cart email delay (hours)"
					description="Wait this long after a cart is idle before sending the first recovery email."
					error={errors.abandonedCartDelayHours}
				>
					<NumberInput
						value={eff("abandonedCartDelayHours", saved, draft) as number | null | undefined}
						onChange={(v) => setField("abandonedCartDelayHours", v ?? null)}
						min={1}
						max={720}
						suffix="hours"
						disabled={disabled}
						{...(errors.abandonedCartDelayHours ? { invalid: true } : {})}
					/>
				</FormField>
				<FormField
					label="Abandoned-cart restore token TTL (days)"
					description="How long the one-click restore link in the recovery email remains valid."
					error={errors.abandonedCartTokenTtlDays}
				>
					<NumberInput
						value={eff("abandonedCartTokenTtlDays", saved, draft) as number | null | undefined}
						onChange={(v) => setField("abandonedCartTokenTtlDays", v ?? null)}
						min={1}
						max={365}
						suffix="days"
						disabled={disabled}
						{...(errors.abandonedCartTokenTtlDays ? { invalid: true } : {})}
					/>
				</FormField>
			</>
		);
	}

	if (group === "connect") {
		return (
			<>
				<FormField
					description="When on, products can be assigned to vendors and payouts split on each sale."
					error={errors.connectEnabled}
				>
					<Toggle
						label="Enable multi-vendor marketplace"
						checked={connectEnabled}
						onChange={(v) => setField("connectEnabled", v)}
						disabled={disabled}
					/>
				</FormField>
				<FormField
					label="Platform fee %"
					description={
						connectEnabled
							? "Percentage of each vendor sale routed to the platform account."
							: "Enable multi-vendor marketplace above to edit the fee."
					}
					error={errors.connectPlatformFeePercent}
				>
					<NumberInput
						value={eff("connectPlatformFeePercent", saved, draft) as number | null | undefined}
						onChange={(v) => setField("connectPlatformFeePercent", v ?? null)}
						min={0}
						max={100}
						step={0.1}
						suffix="%"
						disabled={disabled || !connectEnabled}
						{...(errors.connectPlatformFeePercent ? { invalid: true } : {})}
					/>
				</FormField>
			</>
		);
	}

	return null;
}

function SecretField({
	keyName,
	label,
	description,
	saved,
	draft,
	errors,
	setField,
	disabled,
}: {
	keyName: "stripeSecretKey" | "stripeWebhookSecret";
	label: string;
	description?: string;
	saved: SettingsShape;
	draft: Draft;
	errors: Record<string, string>;
	setField: <K extends keyof Draft>(key: K, value: Draft[K]) => void;
	disabled: boolean;
}) {
	const meta = saved._secrets?.[keyName];
	const value = (draft[keyName] as string | undefined) ?? "";
	return (
		<FormField
			label={label}
			description={
				meta?.isSet
					? `Leave blank to keep current (${meta.hint ?? "set"}).`
					: description
			}
			error={errors[keyName]}
		>
			<Input
				type="password"
				value={value}
				onChange={(e) => {
					const raw = e.currentTarget.value;
					setField(keyName, raw === "" ? undefined : raw);
				}}
				placeholder={meta?.isSet ? (meta.hint ?? "••••") : description}
				autoComplete="new-password"
				disabled={disabled}
			/>
		</FormField>
	);
}

function StripePing() {
	const api = usePluginAPI();
	const [pending, setPending] = useState(false);
	const [result, setResult] = useState<
		| { ok: true; accountId?: string; chargesEnabled: boolean; payoutsEnabled: boolean }
		| { ok: false; error: string }
		| null
	>(null);

	async function run(): Promise<void> {
		setPending(true);
		setResult(null);
		try {
			const res = await api.post<
				| { ok: true; accountId: string; chargesEnabled: boolean; payoutsEnabled: boolean }
				| { ok: false; error: string }
			>("admin/stripe/ping");
			setResult(res);
			if (res.ok) toast.success("Stripe connection verified");
			else toast.error("Stripe check failed", res.error);
		} catch (err) {
			const message = err instanceof Error ? err.message : "Request failed";
			setResult({ ok: false, error: message });
			toast.error("Stripe check failed", message);
		} finally {
			setPending(false);
		}
	}

	return (
		<div style={{ marginTop: 12 }}>
			<Button variant="secondary" onClick={run} disabled={pending}>
				{pending ? "Testing…" : "Test Stripe connection"}
			</Button>
			{result && result.ok && (
				<Alert type="success" title="Connected">
					Account <code>{result.accountId}</code> · charges{" "}
					{result.chargesEnabled ? "enabled" : "disabled"} · payouts{" "}
					{result.payoutsEnabled ? "enabled" : "disabled"}.
				</Alert>
			)}
			{result && !result.ok && (
				<Alert type="error" title="Stripe rejected the credentials">
					{result.error}
				</Alert>
			)}
		</div>
	);
}

function StickyBar({
	isDirty,
	dirtyCount,
	saving,
	onSave,
	onDiscard,
}: {
	isDirty: boolean;
	dirtyCount: number;
	saving: boolean;
	onSave: () => void;
	onDiscard: () => void;
}) {
	return (
		<div
			style={{
				position: "sticky",
				bottom: 0,
				left: 0,
				right: 0,
				background: "#fff",
				borderTop: "1px solid #e4e4e7",
				padding: "0.75rem 1rem",
				display: "flex",
				alignItems: "center",
				justifyContent: "space-between",
				gap: 12,
				boxShadow: "0 -4px 12px rgba(0,0,0,0.04)",
				zIndex: 10,
				marginTop: "auto",
			}}
		>
			<span style={{ color: isDirty ? "#c08a00" : "#888", fontSize: "0.9em" }}>
				{saving
					? "Saving…"
					: isDirty
						? `${dirtyCount} unsaved change${dirtyCount === 1 ? "" : "s"}`
						: "All changes saved"}
			</span>
			<div style={{ display: "flex", gap: 8 }}>
				<Button
					variant="secondary"
					onClick={onDiscard}
					disabled={!isDirty || saving}
				>
					Discard
				</Button>
				<Button
					variant="primary"
					onClick={onSave}
					disabled={!isDirty || saving}
				>
					{saving ? "Saving…" : "Save all"}
				</Button>
			</div>
		</div>
	);
}
