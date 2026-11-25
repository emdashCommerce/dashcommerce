/**
 * Vendors admin page.
 *
 * When multi-vendor marketplace is disabled, this page renders a first-run
 * empty state directing the operator to Settings. When enabled (Stripe
 * Connect, or a provider that can split payments), it shows onboarding, the
 * vendor list, and inline edit for the platform fee and payout accounts.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
	Alert,
	Button,
	Card,
	Combobox,
	FormField,
	Input,
	Loading,
	Money,
	NumberInput,
	Select,
	Table,
	confirm,
	countryOptions,
	toast,
	usePluginAPI,
} from "../kit";
import { EmptyState } from "../ui/EmptyState";
import { StatusBadge } from "../ui/StatusBadge";
import type { Vendor, VendorPaymentAccount, VendorPayout } from "../../types";
import { T } from "../theme";

const STATUS_OPTIONS = [
	{ value: "", label: "All statuses" },
	{ value: "pending", label: "Pending onboarding" },
	{ value: "active", label: "Active" },
	{ value: "restricted", label: "Restricted" },
];

interface SettingsGateState {
	connectEnabled: boolean;
	defaultFeePercent: number;
	/** Registered providers that can split a payment across vendor accounts. */
	splitsProviders: Array<{ id: string; label: string; payoutOnboarding: boolean }>;
}

type PageState = "loading" | "disabled" | "ready" | "error";

export function VendorsPage() {
	const api = usePluginAPI();
	const [pageState, setPageState] = useState<PageState>("loading");
	const [loadError, setLoadError] = useState<string | null>(null);
	const [gate, setGate] = useState<SettingsGateState | null>(null);
	const [vendors, setVendors] = useState<Vendor[]>([]);
	const [q, setQ] = useState("");
	const [statusFilter, setStatusFilter] = useState<string>("");
	const [onboarding, setOnboarding] = useState<{
		name: string;
		email: string;
		country: string | null;
		feePercent: number | null;
	} | null>(null);
	const [linkUrl, setLinkUrl] = useState<string | null>(null);
	const [payouts, setPayouts] = useState<Record<string, VendorPayout[]>>({});
	const [pending, setPending] = useState<Record<string, boolean>>({});
	const [editing, setEditing] = useState<{
		vendor: Vendor;
	} | null>(null);

	const loadVendors = useCallback(async () => {
		const params: Record<string, string> = {};
		if (statusFilter) params.status = statusFilter;
		if (q.trim()) params.q = q.trim();
		const res = await api.get<{ items: Vendor[] }>("admin/vendors", params);
		setVendors(res.items ?? []);
	}, [api, statusFilter, q]);

	useEffect(() => {
		(async () => {
			setPageState("loading");
			setLoadError(null);
			try {
				const settings = await api.get<Record<string, unknown>>("admin/settings");
				const enabled = settings.connectEnabled === true;
				const providers = Array.isArray(settings._providers)
					? (settings._providers as Array<{
							id: string;
							label: string;
							capabilities?: { splits?: boolean };
							payoutOnboarding?: boolean;
						}>)
					: [];
				const splitsProviders = providers
					.filter((provider) => provider.capabilities?.splits === true)
					.map((provider) => ({
						id: provider.id,
						label: provider.label,
						payoutOnboarding: provider.payoutOnboarding === true,
					}));
				setGate({
					connectEnabled: enabled,
					defaultFeePercent:
						typeof settings.connectPlatformFeePercent === "number"
							? (settings.connectPlatformFeePercent as number)
							: 0,
					splitsProviders,
				});
				if (!enabled && splitsProviders.length === 0) {
					setPageState("disabled");
					return;
				}
				await loadVendors();
				setPageState("ready");
			} catch (err) {
				setLoadError(err instanceof Error ? err.message : "Failed to load vendors");
				setPageState("error");
			}
		})();
	}, [api, loadVendors]);

	// Re-load when filters change (only after initial gate check).
	useEffect(() => {
		if (pageState !== "ready") return;
		loadVendors().catch((err) => {
			toast.error("Could not load vendors", err instanceof Error ? err.message : undefined);
		});
	}, [loadVendors, pageState]);

	if (pageState === "loading") return <Loading label="Loading vendors…" />;

	if (pageState === "error") {
		return (
			<Card title="Vendors">
				<Alert type="error" title="Could not load">
					{loadError}
				</Alert>
			</Card>
		);
	}

	if (pageState === "disabled") {
		return (
			<Card title="Vendors">
				<EmptyState
					title="Multi-vendor marketplace is off"
					description="Enable Stripe Connect in Settings, or install a payment provider that supports split payments, to onboard vendors and split payouts on each sale. When disabled, all sales settle to your platform account."
					action={
						<a
							href="/_emdash/admin/plugins/dashcommerce/settings"
							style={{
								display: "inline-block",
								background: T.primaryBg,
								color: T.primaryFg,
								padding: "8px 16px",
								borderRadius: 6,
								textDecoration: "none",
								fontWeight: 500,
							}}
						>
							Open Settings
						</a>
					}
				/>
			</Card>
		);
	}

	return (
		<div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
			{gate?.connectEnabled ? (
				<VendorOnboardingCard
					gate={gate}
					api={api}
					state={onboarding}
					setState={setOnboarding}
					onSuccess={async (url) => {
						setLinkUrl(url);
						await loadVendors();
					}}
				/>
			) : gate && gate.splitsProviders.length > 0 ? (
				<ProviderVendorCard gate={gate} api={api} onSuccess={loadVendors} />
			) : null}
			{linkUrl && (
				<Card title="Onboarding link">
					<Alert type="success" title="Send this link to the vendor">
						<div style={{ wordBreak: "break-all" }}>
							<a href={linkUrl} target="_blank" rel="noreferrer">
								{linkUrl}
							</a>
						</div>
						<Button
							size="sm"
							onClick={async () => {
								try {
									await navigator.clipboard.writeText(linkUrl);
									toast.success("Copied to clipboard");
								} catch {
									toast.warning("Copy failed", "Select and copy manually.");
								}
							}}
							style={{ marginTop: 8 }}
						>
							Copy
						</Button>
					</Alert>
				</Card>
			)}
			<Card title="Vendors">
				<div
					style={{
						display: "flex",
						gap: 8,
						marginBottom: 12,
						flexWrap: "wrap",
					}}
				>
					<Input
						value={q}
						onChange={(e) => setQ(e.currentTarget.value)}
						placeholder="Search name, email, or Stripe account…"
						style={{ flex: "1 1 280px" }}
					/>
					<Combobox
						value={statusFilter || null}
						onChange={(next) => setStatusFilter(next ?? "")}
						options={STATUS_OPTIONS.map((o) => ({
							value: o.value,
							label: o.label,
						}))}
						placeholder="All statuses"
						allowClear
					/>
				</div>
				{vendors.length === 0 ? (
					<EmptyState
						title="No vendors match your filters"
						description="Try clearing filters or onboarding a new vendor above."
					/>
				) : (
					<Table<Vendor>
						data={vendors}
						getRowKey={(v) => v.id}
						columns={[
							{
								key: "name",
								header: "Vendor",
								render: (v) => (
									<div>
										<div style={{ fontWeight: 500 }}>{v.name}</div>
										<div style={{ color: T.textMuted, fontSize: "0.85em" }}>
											{v.email}
										</div>
									</div>
								),
							},
							{
								key: "status",
								header: "Status",
								render: (v) => <StatusBadge status={v.onboardingStatus} />,
							},
							{
								key: "charges",
								header: "Charges",
								render: (v) => (v.chargesEnabled ? "✓" : "—"),
							},
							{
								key: "payouts",
								header: "Payouts",
								render: (v) => (v.payoutsEnabled ? "✓" : "—"),
							},
							{
								key: "fee",
								header: "Fee %",
								render: (v) => `${v.platformFeePercent}%`,
							},
							{
								key: "actions",
								header: "",
								render: (v) => (
									<div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
										<Button
											size="sm"
											onClick={() =>
												setEditing({
													vendor: v,
												})
											}
										>
											Edit
										</Button>
										{v.stripeAccountId && (
											<Button
												size="sm"
												disabled={!!pending[`refresh:${v.id}`]}
												onClick={async () => {
													setPending((p) => ({ ...p, [`refresh:${v.id}`]: true }));
													try {
														await api.post<{ vendor: Vendor }>(
															`admin/vendors/refresh?id=${encodeURIComponent(v.id)}`,
														);
														toast.success("Refreshed from Stripe");
														await loadVendors();
													} catch (err) {
														toast.error(
															"Refresh failed",
															err instanceof Error ? err.message : undefined,
														);
													} finally {
														setPending((p) => {
															const n = { ...p };
															delete n[`refresh:${v.id}`];
															return n;
														});
													}
												}}
											>
												{pending[`refresh:${v.id}`] ? "Refreshing…" : "Refresh"}
											</Button>
										)}
										<Button
											size="sm"
											disabled={!v.payoutsEnabled || !!pending[`payouts:${v.id}`]}
											onClick={async () => {
												setPending((p) => ({ ...p, [`payouts:${v.id}`]: true }));
												try {
													const res = await api.get<{ items: VendorPayout[] }>(
														`admin/vendors/payouts?id=${encodeURIComponent(v.id)}&sync=1`,
													);
													setPayouts((p) => ({ ...p, [v.id]: res.items }));
													toast.success(
														"Payouts synced",
														`${res.items.length} payout${res.items.length === 1 ? "" : "s"}`,
													);
												} catch (err) {
													toast.error(
														"Payout sync failed",
														err instanceof Error ? err.message : undefined,
													);
												} finally {
													setPending((p) => {
														const n = { ...p };
														delete n[`payouts:${v.id}`];
														return n;
													});
												}
											}}
										>
											Sync payouts
										</Button>
										<Button
											size="sm"
											onClick={async () => {
												const ok = await confirm({
													title: "Generate a new onboarding link?",
													description:
														"Use this to re-invite the vendor after a rejected or stalled Stripe Connect application.",
													confirmLabel: "Generate link",
												});
												if (!ok) return;
												try {
													const res = await api.post<{ url: string }>(
														"admin/vendors/onboard-link",
														{
															vendorId: v.id,
															email: v.email,
															name: v.name,
															refreshUrl: `${window.location.origin}/vendor/refresh`,
															returnUrl: `${window.location.origin}/vendor/done`,
														},
													);
													setLinkUrl(res.url);
													toast.success("Onboarding link ready");
												} catch (err) {
													toast.error(
														"Could not generate link",
														err instanceof Error ? err.message : undefined,
													);
												}
											}}
										>
											Relink
										</Button>
									</div>
								),
							},
						]}
					/>
				)}
				{Object.entries(payouts).length > 0 && (
					<div style={{ marginTop: 16 }}>
						{Object.entries(payouts).map(([vendorId, list]) => (
							<PayoutList key={vendorId} vendorId={vendorId} payouts={list} />
						))}
					</div>
				)}
			</Card>

			{editing && (
				<EditVendorModal
					initial={editing.vendor}
					providers={gate?.splitsProviders ?? []}
					api={api}
					onClose={() => setEditing(null)}
					onChanged={async () => {
						setEditing(null);
						await loadVendors();
					}}
					onSave={async (patch) => {
						try {
							await api.patch<{ vendor: Vendor }>(
								`admin/vendors/item?id=${encodeURIComponent(editing.vendor.id)}`,
								patch,
							);
							toast.success("Vendor updated");
							setEditing(null);
							await loadVendors();
						} catch (err) {
							toast.error(
								"Save failed",
								err instanceof Error ? err.message : undefined,
							);
						}
					}}
				/>
			)}
		</div>
	);
}

function VendorOnboardingCard({
	gate,
	api,
	state,
	setState,
	onSuccess,
}: {
	gate: SettingsGateState;
	api: ReturnType<typeof usePluginAPI>;
	state: {
		name: string;
		email: string;
		country: string | null;
		feePercent: number | null;
	} | null;
	setState: (
		next: {
			name: string;
			email: string;
			country: string | null;
			feePercent: number | null;
		} | null,
	) => void;
	onSuccess: (url: string) => Promise<void>;
}) {
	const [submitting, setSubmitting] = useState(false);
	const form = state ?? {
		name: "",
		email: "",
		country: "US",
		feePercent: gate.defaultFeePercent,
	};
	const countries = useMemo(() => countryOptions(), []);
	const valid =
		form.name.trim().length > 0 &&
		/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email) &&
		typeof form.feePercent === "number" &&
		form.feePercent >= 0 &&
		form.feePercent <= 100;

	async function onboard(): Promise<void> {
		if (!valid) return;
		setSubmitting(true);
		try {
			const res = await api.post<{ url: string }>("admin/vendors/onboard-link", {
				name: form.name.trim(),
				email: form.email.trim(),
				country: form.country ?? undefined,
				platformFeePercent: form.feePercent ?? undefined,
				refreshUrl: `${window.location.origin}/vendor/refresh`,
				returnUrl: `${window.location.origin}/vendor/done`,
			});
			setState(null);
			await onSuccess(res.url);
		} catch (err) {
			toast.error(
				"Onboarding failed",
				err instanceof Error ? err.message : undefined,
			);
		} finally {
			setSubmitting(false);
		}
	}

	return (
		<Card title="Onboard a vendor">
			<FormField label="Vendor name">
				<Input
					value={form.name}
					onChange={(e) => setState({ ...form, name: e.currentTarget.value })}
					placeholder="Acme Widgets LLC"
					disabled={submitting}
				/>
			</FormField>
			<FormField label="Vendor email">
				<Input
					type="email"
					value={form.email}
					onChange={(e) => setState({ ...form, email: e.currentTarget.value })}
					placeholder="ops@acme.example"
					disabled={submitting}
				/>
			</FormField>
			<FormField
				label="Country"
				description="Country of the vendor's business. Must match their Stripe Connect eligibility."
			>
				<Combobox
					value={form.country}
					onChange={(next) => setState({ ...form, country: next })}
					options={countries}
					disabled={submitting}
				/>
			</FormField>
			<FormField
				label="Platform fee override"
				description={`Leave at ${gate.defaultFeePercent}% to use the marketplace default from Settings.`}
			>
				<NumberInput
					value={form.feePercent}
					onChange={(v) => setState({ ...form, feePercent: v ?? 0 })}
					min={0}
					max={100}
					step={0.1}
					suffix="%"
					disabled={submitting}
				/>
			</FormField>
			<Button
				variant="primary"
				onClick={onboard}
				disabled={!valid || submitting}
			>
				{submitting ? "Generating…" : "Generate onboarding link"}
			</Button>
		</Card>
	);
}

function ProviderVendorCard({
	gate,
	api,
	onSuccess,
}: {
	gate: SettingsGateState;
	api: ReturnType<typeof usePluginAPI>;
	onSuccess: () => Promise<void>;
}) {
	const [name, setName] = useState("");
	const [email, setEmail] = useState("");
	const [fee, setFee] = useState<number | null>(gate.defaultFeePercent);
	const [providerId, setProviderId] = useState(gate.splitsProviders[0]?.id ?? "");
	const [accountReference, setAccountReference] = useState("");
	const [submitting, setSubmitting] = useState(false);

	const valid =
		name.trim().length > 0 &&
		/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) &&
		typeof fee === "number" &&
		fee >= 0 &&
		fee <= 100 &&
		providerId.length > 0 &&
		accountReference.trim().length >= 4;

	async function add(): Promise<void> {
		if (!valid) return;
		setSubmitting(true);
		try {
			await api.post("admin/vendors/item", {
				name: name.trim(),
				email: email.trim(),
				platformFeePercent: fee ?? 0,
				paymentAccount: {
					providerId,
					accountReference: accountReference.trim(),
					status: "active",
				},
			});
			toast.success("Vendor added");
			setName("");
			setEmail("");
			setAccountReference("");
			await onSuccess();
		} catch (err) {
			toast.error("Could not add vendor", err instanceof Error ? err.message : undefined);
		} finally {
			setSubmitting(false);
		}
	}

	return (
		<Card title="Add a vendor">
			<p style={{ color: T.textMuted, marginTop: 0 }}>
				Paste the payout account id the provider gave you. For Flutterwave, create a collection
				subaccount in the dashboard and use its <code>RS_…</code> id.
			</p>
			<FormField label="Vendor name">
				<Input
					value={name}
					onChange={(e) => setName(e.currentTarget.value)}
					placeholder="Acme Widgets"
					disabled={submitting}
				/>
			</FormField>
			<FormField label="Vendor email">
				<Input
					type="email"
					value={email}
					onChange={(e) => setEmail(e.currentTarget.value)}
					placeholder="ops@acme.example"
					disabled={submitting}
				/>
			</FormField>
			{gate.splitsProviders.length > 1 && (
				<FormField label="Payment provider">
					<Select
						value={providerId}
						onChange={(e) => setProviderId(e.currentTarget.value)}
						options={gate.splitsProviders.map((provider) => ({
							value: provider.id,
							label: provider.label,
						}))}
						disabled={submitting}
					/>
				</FormField>
			)}
			<FormField
				label="Payout account"
				description="The provider's account id for this vendor."
			>
				<Input
					value={accountReference}
					onChange={(e) => setAccountReference(e.currentTarget.value)}
					placeholder="RS_…"
					disabled={submitting}
				/>
			</FormField>
			<FormField
				label="Platform fee override"
				description={`Leave at ${gate.defaultFeePercent}% to use the marketplace default.`}
			>
				<NumberInput
					value={fee}
					onChange={(v) => setFee(v ?? 0)}
					min={0}
					max={100}
					step={0.1}
					suffix="%"
					disabled={submitting}
				/>
			</FormField>
			<Button variant="primary" onClick={add} disabled={!valid || submitting}>
				{submitting ? "Adding…" : "Add vendor"}
			</Button>
		</Card>
	);
}

function PayoutAccountForm({
	provider,
	vendor,
	api,
	onChanged,
}: {
	provider: { id: string; label: string; payoutOnboarding: boolean };
	vendor: Vendor;
	api: ReturnType<typeof usePluginAPI>;
	onChanged: () => Promise<void>;
}) {
	const stored = vendor.paymentAccounts?.[provider.id];
	const [country, setCountry] = useState("NG");
	const [banks, setBanks] = useState<Array<{ code: string; name: string }> | null>(null);
	const [bankCode, setBankCode] = useState("");
	const [accountNumber, setAccountNumber] = useState("");
	const [accountName, setAccountName] = useState<string | null>(null);
	const [businessName, setBusinessName] = useState(vendor.name);
	const [businessEmail, setBusinessEmail] = useState(vendor.email);
	const [businessMobile, setBusinessMobile] = useState("");
	const [splitType, setSplitType] = useState<"percentage" | "flat">("percentage");
	const [splitValue, setSplitValue] = useState<number | null>(vendor.platformFeePercent || 10);
	const [verifying, setVerifying] = useState(false);
	const [creating, setCreating] = useState(false);
	const [removing, setRemoving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const countries = useMemo(() => countryOptions(), []);

	useEffect(() => {
		if (stored) return;
		let alive = true;
		setBanks(null);
		api
			.get<{ banks: Array<{ code: string; name: string }> }>("admin/vendors/payout-banks", {
				provider: provider.id,
				country,
			})
			.then((res) => {
				if (alive) setBanks(res.banks ?? []);
			})
			.catch((err) => {
				if (alive) {
					setError(err instanceof Error ? err.message : "Could not load banks");
				}
			});
		return () => {
			alive = false;
		};
	}, [api, provider.id, country, stored]);

	if (stored) {
		return (
			<div style={{ marginTop: 12, paddingTop: 12, borderTop: `1px solid ${T.border}` }}>
				<Alert type="success" title={`${provider.label} payout account`}>
					{stored.accountName ?? stored.label ?? "Account"} ·{" "}
					{stored.bankName ?? stored.bankCode}
					{stored.maskedAccountNumber ? ` ${stored.maskedAccountNumber}` : ""} ·{" "}
					{stored.status}
				</Alert>
				<Button
					size="sm"
					disabled={removing}
					onClick={async () => {
						setRemoving(true);
						try {
							await api.patch(`admin/vendors/item?id=${encodeURIComponent(vendor.id)}`, {
								paymentAccount: { providerId: provider.id, accountReference: null },
							});
							toast.success("Payout account removed");
							await onChanged();
						} catch (err) {
							toast.error(
								"Could not remove the account",
								err instanceof Error ? err.message : undefined,
							);
						} finally {
							setRemoving(false);
						}
					}}
				>
					{removing ? "Removing…" : "Remove account"}
				</Button>
			</div>
		);
	}

	const valid =
		country.length === 2 &&
		bankCode.length > 0 &&
		accountNumber.trim().length >= 4 &&
		businessName.trim().length > 0 &&
		/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(businessEmail) &&
		businessMobile.trim().length > 0 &&
		accountName !== null &&
		typeof splitValue === "number" &&
		splitValue >= 0 &&
		(splitType === "flat" ? splitValue > 0 : splitValue <= 100);

	async function verify(): Promise<void> {
		setVerifying(true);
		setError(null);
		try {
			const res = await api.post<{ accountName: string }>(
				"admin/vendors/payout-account/resolve",
				{ providerId: provider.id, accountNumber: accountNumber.trim(), bankCode },
			);
			setAccountName(res.accountName);
		} catch (err) {
			setAccountName(null);
			setError(err instanceof Error ? err.message : "Could not verify the account");
		} finally {
			setVerifying(false);
		}
	}

	async function create(): Promise<void> {
		setCreating(true);
		setError(null);
		try {
			await api.post("admin/vendors/payout-account", {
				providerId: provider.id,
				vendorId: vendor.id,
				accountNumber: accountNumber.trim(),
				bankCode,
				country,
				businessName: businessName.trim(),
				businessEmail: businessEmail.trim(),
				businessMobile: businessMobile.trim(),
				splitType,
				splitValue: splitType === "percentage" ? (splitValue ?? 0) / 100 : (splitValue ?? 0),
			});
			toast.success("Payout account created");
			await onChanged();
		} catch (err) {
			setError(err instanceof Error ? err.message : "Could not create the account");
		} finally {
			setCreating(false);
		}
	}

	return (
		<div style={{ marginTop: 12, paddingTop: 12, borderTop: `1px solid ${T.border}` }}>
			<h3 style={{ margin: "0 0 8px", fontSize: "1em" }}>{provider.label} payout account</h3>
			{error && (
				<Alert type="error" title="Could not set up the account">
					{error}
				</Alert>
			)}
			<FormField label="Country">
				<Select
					value={country}
					onChange={(e) => {
						setCountry(e.currentTarget.value);
						setBankCode("");
						setAccountName(null);
					}}
					options={countries.map((c) => ({ value: c.value, label: c.label }))}
					disabled={creating}
				/>
			</FormField>
			<FormField label="Bank" description={banks === null ? "Loading banks…" : undefined}>
				<Select
					value={bankCode}
					onChange={(e) => {
						setBankCode(e.currentTarget.value);
						setAccountName(null);
					}}
					options={(banks ?? []).map((b) => ({ value: b.code, label: b.name }))}
					disabled={creating || !banks}
				/>
			</FormField>
			<FormField label="Account number">
				<Input
					value={accountNumber}
					onChange={(e) => {
						setAccountNumber(e.currentTarget.value);
						setAccountName(null);
					}}
					disabled={creating}
				/>
			</FormField>
			<Button
				size="sm"
				onClick={verify}
				disabled={creating || verifying || !bankCode || accountNumber.trim().length < 4}
			>
				{verifying ? "Verifying…" : "Verify account"}
			</Button>
			{accountName && (
				<Alert type="success" title="Account verified">
					{accountName}
				</Alert>
			)}
			<FormField label="Business name">
				<Input
					value={businessName}
					onChange={(e) => setBusinessName(e.currentTarget.value)}
					disabled={creating}
				/>
			</FormField>
			<FormField label="Business email">
				<Input
					type="email"
					value={businessEmail}
					onChange={(e) => setBusinessEmail(e.currentTarget.value)}
					disabled={creating}
				/>
			</FormField>
			<FormField label="Business mobile">
				<Input
					value={businessMobile}
					onChange={(e) => setBusinessMobile(e.currentTarget.value)}
					placeholder="+234…"
					disabled={creating}
				/>
			</FormField>
			<FormField
				label="Default split type"
				description="DashCommerce overrides this per payment with the exact vendor amount; it is the account's fallback."
			>
				<Select
					value={splitType}
					onChange={(e) => setSplitType(e.currentTarget.value as "percentage" | "flat")}
					options={[
						{ value: "percentage", label: "Percentage" },
						{ value: "flat", label: "Flat amount" },
					]}
					disabled={creating}
				/>
			</FormField>
			<FormField
				label={splitType === "percentage" ? "Platform fee (%)" : "Flat platform fee"}
			>
				<NumberInput
					value={splitValue}
					onChange={(v) => setSplitValue(v ?? null)}
					min={0}
					max={splitType === "percentage" ? 100 : undefined}
					step={0.1}
					suffix={splitType === "percentage" ? "%" : undefined}
					disabled={creating}
				/>
			</FormField>
			<Button variant="primary" onClick={create} disabled={!valid || creating}>
				{creating ? "Creating…" : "Create payout account"}
			</Button>
		</div>
	);
}

interface PaymentAccountDraft {
	accountReference: string;
	status: VendorPaymentAccount["status"];
}

function EditVendorModal({
	initial,
	providers,
	api,
	onClose,
	onSave,
	onChanged,
}: {
	initial: Vendor;
	providers: Array<{ id: string; label: string; payoutOnboarding: boolean }>;
	api: ReturnType<typeof usePluginAPI>;
	onClose: () => void;
	onSave: (patch: {
		name?: string;
		platformFeePercent?: number;
		paymentAccounts?: Array<{
			providerId: string;
			accountReference: string | null;
			status: VendorPaymentAccount["status"];
		}>;
	}) => Promise<void>;
	onChanged: () => Promise<void>;
}) {
	const [name, setName] = useState(initial.name);
	const [fee, setFee] = useState<number | null>(initial.platformFeePercent);
	const [accounts, setAccounts] = useState<Record<string, PaymentAccountDraft>>(() => {
		const out: Record<string, PaymentAccountDraft> = {};
		for (const provider of providers) {
			const account = initial.paymentAccounts?.[provider.id];
			out[provider.id] = {
				accountReference: account?.accountReference ?? "",
				status: account?.status ?? "active",
			};
		}
		return out;
	});
	const [saving, setSaving] = useState(false);
	const isValid =
		name.trim().length > 0 &&
		typeof fee === "number" &&
		fee >= 0 &&
		fee <= 100;

	function setAccount(providerId: string, patch: Partial<PaymentAccountDraft>): void {
		setAccounts((current) => ({
			...current,
			[providerId]: {
				accountReference: current[providerId]?.accountReference ?? "",
				status: current[providerId]?.status ?? "active",
				...patch,
			},
		}));
	}

	return (
		<div
			role="dialog"
			aria-modal="true"
			style={{
				position: "fixed",
				inset: 0,
				background: T.scrim,
				display: "flex",
				alignItems: "center",
				justifyContent: "center",
				zIndex: 9999,
				padding: 16,
			}}
			onClick={onClose}
		>
			<div
				onClick={(e) => e.stopPropagation()}
				style={{
					background: T.surface,
					border: `1px solid ${T.border}`,
					borderRadius: 8,
					maxWidth: 480,
					width: "100%",
					padding: "20px 24px",
					maxHeight: "90vh",
					overflowY: "auto",
				}}
			>
				<h2 style={{ margin: "0 0 12px" }}>Edit vendor</h2>
				<FormField label="Name">
					<Input
						value={name}
						onChange={(e) => setName(e.currentTarget.value)}
						disabled={saving}
					/>
				</FormField>
				<FormField
					label="Platform fee"
					description="Override of the marketplace default for this vendor."
				>
					<NumberInput
						value={fee}
						onChange={(v) => setFee(v ?? null)}
						min={0}
						max={100}
						step={0.1}
						suffix="%"
						disabled={saving}
					/>
				</FormField>
				{providers.map((provider) =>
					provider.payoutOnboarding ? (
						<PayoutAccountForm
							key={provider.id}
							provider={provider}
							vendor={initial}
							api={api}
							onChanged={onChanged}
						/>
					) : (
						<div
							key={provider.id}
							style={{
								marginTop: 12,
								paddingTop: 12,
								borderTop: `1px solid ${T.border}`,
							}}
						>
							<FormField
								label={`${provider.label} payout account`}
								description="The account id the provider gave you (Flutterwave: RS_…). Leave blank to remove it."
							>
								<Input
									value={accounts[provider.id]?.accountReference ?? ""}
									onChange={(e) =>
										setAccount(provider.id, { accountReference: e.currentTarget.value })
									}
									placeholder="RS_…"
									disabled={saving}
								/>
							</FormField>
							<FormField label="Account status">
								<Select
									value={accounts[provider.id]?.status ?? "active"}
									onChange={(e) =>
										setAccount(provider.id, {
											status: e.currentTarget.value as VendorPaymentAccount["status"],
										})
									}
									options={[
										{ value: "active", label: "Active — can receive splits" },
										{ value: "pending", label: "Pending — no splits yet" },
										{ value: "disabled", label: "Disabled" },
									]}
									disabled={saving}
								/>
							</FormField>
						</div>
					),
				)}
				<div
					style={{
						display: "flex",
						justifyContent: "flex-end",
						gap: 8,
						marginTop: 16,
					}}
				>
					<Button variant="secondary" onClick={onClose} disabled={saving}>
						Cancel
					</Button>
					<Button
						variant="primary"
						disabled={!isValid || saving}
						onClick={async () => {
							setSaving(true);
							const patch: {
								name?: string;
								platformFeePercent?: number;
								paymentAccounts?: Array<{
									providerId: string;
									accountReference: string | null;
									status: VendorPaymentAccount["status"];
								}>;
							} = {};
							if (name.trim() !== initial.name) patch.name = name.trim();
							if (fee !== initial.platformFeePercent && typeof fee === "number")
								patch.platformFeePercent = fee;
							if (providers.length > 0) {
								const manualProviders = providers.filter(
									(provider) => !provider.payoutOnboarding,
								);
								if (manualProviders.length > 0) {
									patch.paymentAccounts = manualProviders.map((provider) => ({
										providerId: provider.id,
										accountReference:
											(accounts[provider.id]?.accountReference ?? "").trim() || null,
										status: accounts[provider.id]?.status ?? "active",
									}));
								}
							}
							try {
								await onSave(patch);
							} finally {
								setSaving(false);
							}
						}}
					>
						{saving ? "Saving…" : "Save"}
					</Button>
				</div>
			</div>
		</div>
	);
}

function PayoutList({
	vendorId,
	payouts,
}: {
	vendorId: string;
	payouts: VendorPayout[];
}) {
	return (
		<div style={{ marginTop: 12 }}>
			<h3 style={{ margin: "0 0 6px", fontSize: "0.95em" }}>
				Recent payouts for {vendorId}
			</h3>
			{payouts.length === 0 ? (
				<p style={{ color: T.textMuted, fontSize: "0.9em" }}>No payouts yet.</p>
			) : (
				<Table<VendorPayout>
					data={payouts}
					getRowKey={(p) => p.id}
					columns={[
						{
							key: "arrival",
							header: "Arrival",
							render: (p) =>
								new Date(p.arrivalDate).toLocaleDateString(undefined, {
									year: "numeric",
									month: "short",
									day: "numeric",
								}),
						},
						{
							key: "amount",
							header: "Amount",
							render: (p) => <Money value={p.amount} />,
						},
						{
							key: "status",
							header: "Status",
							render: (p) => <StatusBadge status={p.status} />,
						},
						{
							key: "stripe",
							header: "Stripe payout",
							render: (p) => (
								<code style={{ fontSize: "0.8em" }}>{p.stripePayoutId}</code>
							),
						},
					]}
				/>
			)}
		</div>
	);
}
