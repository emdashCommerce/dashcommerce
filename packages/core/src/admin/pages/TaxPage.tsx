/**
 * Tax page — consolidates tax mode, flat rate, rate table CRUD, and
 * Stripe Tax status. Mode-aware gating hides irrelevant controls so
 * operators can't misconfigure a rate table when in flat mode, etc.
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
	NumberInput,
	Select,
	Table,
	Toggle,
	confirm,
	countryOptions,
	toast,
	usePluginAPI,
} from "../kit";
import { EmptyState } from "../ui/EmptyState";
import type { TaxMode, TaxRate } from "../../types";

const TAX_CLASS_OPTIONS = [
	{ value: "standard", label: "Standard" },
	{ value: "reduced", label: "Reduced" },
	{ value: "zero", label: "Zero-rated" },
	{ value: "shipping", label: "Shipping" },
];

interface TaxSettings {
	taxMode: TaxMode;
	flatTaxRatePercent: number;
	taxAppliesToShipping: boolean;
}

export function TaxPage() {
	const api = usePluginAPI();
	const [settings, setSettings] = useState<TaxSettings | null>(null);
	const [rates, setRates] = useState<TaxRate[]>([]);
	const [stripeStatus, setStripeStatus] = useState<
		| { loading: true }
		| { loading: false; ok: true; accountId: string; chargesEnabled: boolean }
		| { loading: false; ok: false; error: string }
	>({ loading: true });
	const [savingSetting, setSavingSetting] = useState<string | null>(null);
	const [editing, setEditing] = useState<TaxRate | null>(null);
	const [creating, setCreating] = useState(false);

	const reload = useCallback(async () => {
		const [s, rs] = await Promise.all([
			api.get<Record<string, unknown>>("admin/settings"),
			api.get<{ items: TaxRate[] }>("admin/tax/rates"),
		]);
		setSettings({
			taxMode: (s.taxMode as TaxMode) ?? "flat",
			flatTaxRatePercent:
				typeof s.flatTaxRatePercent === "number" ? (s.flatTaxRatePercent as number) : 0,
			taxAppliesToShipping: s.taxAppliesToShipping === true,
		});
		setRates(rs.items ?? []);
	}, [api]);

	useEffect(() => {
		reload();
	}, [reload]);

	const checkStripeStatus = useCallback(async () => {
		setStripeStatus({ loading: true });
		try {
			const res = await api.post<
				| { ok: true; accountId: string; chargesEnabled: boolean }
				| { ok: false; error: string }
			>("admin/stripe/ping");
			if (res.ok) {
				setStripeStatus({
					loading: false,
					ok: true,
					accountId: res.accountId,
					chargesEnabled: res.chargesEnabled,
				});
			} else {
				setStripeStatus({ loading: false, ok: false, error: res.error });
			}
		} catch (err) {
			setStripeStatus({
				loading: false,
				ok: false,
				error: err instanceof Error ? err.message : "Stripe check failed",
			});
		}
	}, [api]);

	useEffect(() => {
		if (settings?.taxMode === "stripe_tax") {
			checkStripeStatus();
		}
	}, [settings?.taxMode, checkStripeStatus]);

	async function updateSetting<K extends keyof TaxSettings>(
		key: K,
		value: TaxSettings[K],
	): Promise<void> {
		if (!settings) return;
		const next = { ...settings, [key]: value };
		setSettings(next);
		setSavingSetting(key);
		try {
			await api.post("admin/settings", { [key]: value });
		} catch (err) {
			if (err && typeof err === "object" && "body" in err) {
				const body = (err as { body?: { errors?: Record<string, string> } }).body;
				if (body?.errors?.[key]) {
					toast.error("Invalid value", body.errors[key]);
					setSettings(settings);
					return;
				}
			}
			toast.error(
				"Could not save",
				err instanceof Error ? err.message : undefined,
			);
			setSettings(settings);
		} finally {
			setSavingSetting(null);
		}
	}

	if (!settings) return <Loading />;

	return (
		<div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
			<Card title="Tax mode">
				<FormField
					label="Strategy"
					description="Flat rate is the simplest — a single percentage applies to every sale. Rate table lets you configure by country/region. Stripe Tax automates rates using Stripe's service."
				>
					<Select
						value={settings.taxMode}
						options={[
							{ value: "flat", label: "Flat rate" },
							{ value: "table", label: "Rate table (by region)" },
							{ value: "stripe_tax", label: "Stripe Tax (automatic)" },
						]}
						onChange={(e) => updateSetting("taxMode", e.currentTarget.value as TaxMode)}
						disabled={savingSetting === "taxMode"}
					/>
				</FormField>
				{settings.taxMode === "flat" && (
					<FormField
						label="Flat rate"
						description="Applied as a percentage to every taxable line item."
					>
						<NumberInput
							value={settings.flatTaxRatePercent}
							onChange={(v) => updateSetting("flatTaxRatePercent", v ?? 0)}
							min={0}
							max={100}
							step={0.01}
							suffix="%"
							disabled={savingSetting === "flatTaxRatePercent"}
						/>
					</FormField>
				)}
				{settings.taxMode !== "stripe_tax" && (
					<FormField description="When on, the tax rate is also applied to shipping charges.">
						<Toggle
							label="Apply tax to shipping"
							checked={settings.taxAppliesToShipping}
							onChange={(next) => updateSetting("taxAppliesToShipping", next)}
							disabled={savingSetting === "taxAppliesToShipping"}
						/>
					</FormField>
				)}
			</Card>

			{settings.taxMode === "flat" && (
				<Alert type="info" title="Rate table is hidden">
					Switch to &ldquo;Rate table&rdquo; to configure country- and region-specific
					rates. Flat mode ignores the table.
				</Alert>
			)}

			{settings.taxMode === "table" && (
				<Card title="Tax rates">
					<div
						style={{
							display: "flex",
							justifyContent: "flex-end",
							marginBottom: 8,
						}}
					>
						<Button variant="primary" onClick={() => setCreating(true)}>
							Add rate
						</Button>
					</div>
					{rates.length === 0 ? (
						<EmptyState
							title="No tax rates yet"
							description="Add at least one rate for the jurisdictions where you collect tax."
							action={
								<Button variant="primary" onClick={() => setCreating(true)}>
									Add the first rate
								</Button>
							}
						/>
					) : (
						<Table<TaxRate>
							data={rates}
							getRowKey={(r) => r.id}
							columns={[
								{
									key: "priority",
									header: "Priority",
									render: (r) => r.priority,
								},
								{
									key: "name",
									header: "Name",
									render: (r) => r.name,
								},
								{ key: "c", header: "Country", render: (r) => r.country },
								{
									key: "r",
									header: "Region",
									render: (r) => r.region ?? "—",
								},
								{
									key: "postal",
									header: "Postal",
									render: (r) => r.postalCode ?? "—",
								},
								{
									key: "cls",
									header: "Class",
									render: (r) => r.taxClass,
								},
								{ key: "pct", header: "Rate", render: (r) => `${r.rate}%` },
								{
									key: "ship",
									header: "On shipping",
									render: (r) => (r.appliesToShipping ? "yes" : "no"),
								},
								{
									key: "compound",
									header: "Compound",
									render: (r) => (r.compound ? "yes" : "no"),
								},
								{
									key: "actions",
									header: "",
									render: (r) => (
										<div style={{ display: "flex", gap: 4 }}>
											<Button size="sm" onClick={() => setEditing(r)}>
												Edit
											</Button>
											<Button
												size="sm"
												variant="danger"
												onClick={async () => {
													const ok = await confirm({
														title: "Delete tax rate?",
														description: `Rate "${r.name}" (${r.country}${r.region ? ` / ${r.region}` : ""}) will no longer be applied.`,
														confirmLabel: "Delete",
														destructive: true,
													});
													if (!ok) return;
													try {
														await api.delete(`admin/tax/rates/item?id=${encodeURIComponent(r.id)}`);
														toast.success("Rate deleted");
														await reload();
													} catch (err) {
														toast.error(
															"Delete failed",
															err instanceof Error ? err.message : undefined,
														);
													}
												}}
											>
												Delete
											</Button>
										</div>
									),
								},
							]}
						/>
					)}
				</Card>
			)}

			{settings.taxMode === "stripe_tax" && (
				<Card title="Stripe Tax">
					<p style={{ color: "#555", fontSize: "0.9em", margin: "0 0 12px" }}>
						Stripe Tax calculates rates at checkout using your Stripe account's
						nexus and product tax codes. Make sure your account has tax
						registrations configured in the Stripe dashboard.
					</p>
					{stripeStatus.loading ? (
						<Loading label="Checking Stripe status…" />
					) : stripeStatus.ok ? (
						<Alert type="success" title="Connected">
							Stripe account <code>{stripeStatus.accountId}</code> —{" "}
							charges {stripeStatus.chargesEnabled ? "enabled" : "disabled"}.
						</Alert>
					) : (
						<Alert type="error" title="Stripe not reachable">
							{stripeStatus.error} — configure your Stripe secret key on the
							Settings page.
						</Alert>
					)}
					<div style={{ marginTop: 12 }}>
						<Button variant="secondary" onClick={checkStripeStatus}>
							Re-check Stripe connection
						</Button>
					</div>
				</Card>
			)}

			{(creating || editing) && (
				<TaxRateEditor
					key={editing?.id ?? "new"}
					initial={editing}
					onClose={() => {
						setEditing(null);
						setCreating(false);
					}}
					onSave={async (patch) => {
						try {
							if (editing) {
								await api.patch(
									`admin/tax/rates/item?id=${encodeURIComponent(editing.id)}`,
									patch,
								);
								toast.success("Rate updated");
							} else {
								await api.post("admin/tax/rates", patch);
								toast.success("Rate added");
							}
							setEditing(null);
							setCreating(false);
							await reload();
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

function TaxRateEditor({
	initial,
	onClose,
	onSave,
}: {
	initial: TaxRate | null;
	onClose: () => void;
	onSave: (patch: Partial<TaxRate>) => Promise<void>;
}) {
	const countries = useMemo(() => countryOptions(), []);
	const [name, setName] = useState(initial?.name ?? "");
	const [country, setCountry] = useState<string | null>(initial?.country ?? "US");
	const [region, setRegion] = useState(initial?.region ?? "");
	const [postal, setPostal] = useState(initial?.postalCode ?? "");
	const [taxClass, setTaxClass] = useState(initial?.taxClass ?? "standard");
	const [rate, setRate] = useState<number | null>(initial?.rate ?? 0);
	const [compound, setCompound] = useState(initial?.compound ?? false);
	const [appliesToShipping, setAppliesToShipping] = useState(
		initial?.appliesToShipping ?? false,
	);
	const [priority, setPriority] = useState<number | null>(initial?.priority ?? 0);
	const [saving, setSaving] = useState(false);

	const valid =
		name.trim() &&
		country &&
		taxClass &&
		typeof rate === "number" &&
		rate >= 0 &&
		rate <= 100 &&
		typeof priority === "number";

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
					maxWidth: 520,
					width: "100%",
					padding: "20px 24px",
					maxHeight: "90vh",
					overflowY: "auto",
				}}
			>
				<h2 style={{ margin: "0 0 12px" }}>
					{initial ? "Edit tax rate" : "Add tax rate"}
				</h2>
				<FormField label="Name">
					<Input
						value={name}
						onChange={(e) => setName(e.currentTarget.value)}
						placeholder="e.g. California Sales Tax"
						disabled={saving}
					/>
				</FormField>
				<FormField label="Country">
					<Combobox
						value={country}
						onChange={(next) => setCountry(next)}
						options={countries}
						disabled={saving}
					/>
				</FormField>
				<FormField
					label="Region / state"
					description="Optional. Leave blank to apply to the whole country."
				>
					<Input
						value={region}
						onChange={(e) => setRegion(e.currentTarget.value)}
						placeholder="CA"
						disabled={saving}
					/>
				</FormField>
				<FormField
					label="Postal code prefix"
					description="Optional. Matches if the shipping postal code starts with this."
				>
					<Input
						value={postal}
						onChange={(e) => setPostal(e.currentTarget.value)}
						placeholder="941"
						disabled={saving}
					/>
				</FormField>
				<FormField label="Tax class">
					<Select
						value={taxClass}
						options={TAX_CLASS_OPTIONS}
						onChange={(e) => setTaxClass(e.currentTarget.value)}
						disabled={saving}
					/>
				</FormField>
				<FormField label="Rate">
					<NumberInput
						value={rate}
						onChange={(v) => setRate(v ?? 0)}
						min={0}
						max={100}
						step={0.001}
						suffix="%"
						disabled={saving}
					/>
				</FormField>
				<FormField
					label="Priority"
					description="Lower numbers run first. Use priorities when multiple rates could match the same order."
				>
					<NumberInput
						value={priority}
						onChange={(v) => setPriority(v ?? 0)}
						min={0}
						max={1000}
						step={1}
						disabled={saving}
					/>
				</FormField>
				<div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
					<Toggle
						label="Compound"
						checked={compound}
						onChange={setCompound}
						disabled={saving}
					/>
					<Toggle
						label="Applies to shipping"
						checked={appliesToShipping}
						onChange={setAppliesToShipping}
						disabled={saving}
					/>
				</div>
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
						disabled={!valid || saving}
						onClick={async () => {
							if (!valid) return;
							setSaving(true);
							try {
								await onSave({
									name: name.trim(),
									country: country as TaxRate["country"],
									...(region.trim() ? { region: region.trim() as TaxRate["region"] } : {}),
									...(postal.trim() ? { postalCode: postal.trim() } : {}),
									taxClass: taxClass.trim(),
									rate: rate as number,
									compound,
									appliesToShipping,
									priority: priority as number,
								});
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
