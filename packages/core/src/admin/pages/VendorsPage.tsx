/**
 * Vendors admin page.
 *
 * When multi-vendor marketplace is disabled, this page renders a first-run
 * empty state directing the operator to Settings. When enabled, it shows
 * onboarding + list + inline edit for platform fee and Stripe refresh.
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
	Table,
	confirm,
	countryOptions,
	toast,
	usePluginAPI,
} from "../kit";
import { EmptyState } from "../ui/EmptyState";
import { StatusBadge } from "../ui/StatusBadge";
import type { Vendor, VendorPayout } from "../../types";

const STATUS_OPTIONS = [
	{ value: "", label: "All statuses" },
	{ value: "pending", label: "Pending onboarding" },
	{ value: "active", label: "Active" },
	{ value: "restricted", label: "Restricted" },
];

interface SettingsGateState {
	connectEnabled: boolean;
	defaultFeePercent: number;
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
		vendorId: string;
		name: string;
		fee: number;
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
				setGate({
					connectEnabled: enabled,
					defaultFeePercent:
						typeof settings.connectPlatformFeePercent === "number"
							? (settings.connectPlatformFeePercent as number)
							: 0,
				});
				if (!enabled) {
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
					description="Enable Stripe Connect in Settings to onboard vendors and split payouts on each sale. When disabled, all sales settle to your platform account."
					action={
						<a
							href="/_emdash/admin/plugins/dashcommerce/settings"
							style={{
								display: "inline-block",
								background: "#111",
								color: "#fff",
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
			<VendorOnboardingCard
				gate={gate as SettingsGateState}
				api={api}
				state={onboarding}
				setState={setOnboarding}
				onSuccess={async (url) => {
					setLinkUrl(url);
					await loadVendors();
				}}
			/>
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
										<div style={{ color: "#666", fontSize: "0.85em" }}>
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
													vendorId: v.id,
													name: v.name,
													fee: v.platformFeePercent,
												})
											}
										>
											Edit
										</Button>
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
					initial={editing}
					onClose={() => setEditing(null)}
					onSave={async (patch) => {
						try {
							await api.patch<{ vendor: Vendor }>(
								`admin/vendors/item?id=${encodeURIComponent(editing.vendorId)}`,
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

function EditVendorModal({
	initial,
	onClose,
	onSave,
}: {
	initial: { vendorId: string; name: string; fee: number };
	onClose: () => void;
	onSave: (patch: { name?: string; platformFeePercent?: number }) => Promise<void>;
}) {
	const [name, setName] = useState(initial.name);
	const [fee, setFee] = useState<number | null>(initial.fee);
	const [saving, setSaving] = useState(false);
	const isValid =
		name.trim().length > 0 &&
		typeof fee === "number" &&
		fee >= 0 &&
		fee <= 100;

	return (
		<div
			role="dialog"
			aria-modal="true"
			style={{
				position: "fixed",
				inset: 0,
				background: "rgba(17,17,17,0.45)",
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
					background: "#fff",
					borderRadius: 8,
					maxWidth: 440,
					width: "100%",
					padding: "20px 24px",
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
							const patch: { name?: string; platformFeePercent?: number } = {};
							if (name.trim() !== initial.name) patch.name = name.trim();
							if (fee !== initial.fee && typeof fee === "number")
								patch.platformFeePercent = fee;
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
				<p style={{ color: "#666", fontSize: "0.9em" }}>No payouts yet.</p>
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
