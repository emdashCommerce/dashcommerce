/**
 * Coupons admin page — full CRUD with dates, limits, eligible products, and
 * currency for fixed-amount types. Destructive actions go through
 * `confirm()` and write paths produce toasts.
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
	currencyOptions,
	toast,
	usePluginAPI,
} from "../kit";
import { EmptyState } from "../ui/EmptyState";
import { StatusBadge } from "../ui/StatusBadge";
import type { Coupon, DiscountType } from "../../types";

const DISCOUNT_TYPES: { value: DiscountType; label: string }[] = [
	{ value: "percent_cart", label: "% off cart" },
	{ value: "fixed_cart", label: "$ off cart" },
	{ value: "percent_product", label: "% off product" },
	{ value: "fixed_product", label: "$ off product" },
	{ value: "free_shipping", label: "Free shipping" },
];

function isFixed(type: DiscountType): boolean {
	return type === "fixed_cart" || type === "fixed_product";
}

function isPercent(type: DiscountType): boolean {
	return type === "percent_cart" || type === "percent_product";
}

export function CouponsPage() {
	const api = usePluginAPI();
	const [coupons, setCoupons] = useState<Coupon[] | null>(null);
	const [editing, setEditing] = useState<Coupon | null>(null);
	const [creating, setCreating] = useState(false);
	const [enabledCurrencies, setEnabledCurrencies] = useState<string[]>(["USD"]);

	const reload = useCallback(async () => {
		const res = await api.get<{ items: Coupon[] }>("admin/coupons");
		setCoupons(res.items ?? []);
	}, [api]);

	useEffect(() => {
		(async () => {
			try {
				const s = await api.get<{ enabledCurrencies?: string[] }>("admin/settings");
				if (Array.isArray(s.enabledCurrencies)) {
					setEnabledCurrencies(s.enabledCurrencies);
				}
			} catch {
				// non-fatal — fall back to USD default
			}
			await reload();
		})();
	}, [api, reload]);

	if (!coupons) return <Loading />;

	return (
		<div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
			<Card title="Coupons">
				<div
					style={{
						display: "flex",
						justifyContent: "flex-end",
						marginBottom: 8,
					}}
				>
					<Button variant="primary" onClick={() => setCreating(true)}>
						New coupon
					</Button>
				</div>
				{coupons.length === 0 ? (
					<EmptyState
						title="No coupons yet"
						description="Create a coupon to offer discounts at checkout."
						action={
							<Button variant="primary" onClick={() => setCreating(true)}>
								Create first coupon
							</Button>
						}
					/>
				) : (
					<Table<Coupon>
						data={coupons}
						getRowKey={(c) => c.id}
						columns={[
							{
								key: "code",
								header: "Code",
								render: (c) => <code>{c.code}</code>,
							},
							{
								key: "type",
								header: "Type",
								render: (c) =>
									DISCOUNT_TYPES.find((t) => t.value === c.discountType)?.label ??
									c.discountType,
							},
							{
								key: "value",
								header: "Value",
								render: (c) =>
									isPercent(c.discountType)
										? `${c.discountValue}%`
										: isFixed(c.discountType)
											? `${(c.discountValue / 100).toFixed(2)} ${c.currency ?? ""}`
											: "—",
							},
							{
								key: "status",
								header: "Status",
								render: (c) => <StatusBadge status={c.status} />,
							},
							{
								key: "used",
								header: "Used",
								render: (c) =>
									c.usageLimit
										? `${c.usageCount} / ${c.usageLimit}`
										: c.usageCount,
							},
							{
								key: "expiry",
								header: "Expires",
								render: (c) =>
									c.endsAt
										? new Date(c.endsAt).toLocaleDateString()
										: "—",
							},
							{
								key: "actions",
								header: "",
								render: (c) => (
									<div style={{ display: "flex", gap: 4 }}>
										<Button size="sm" onClick={() => setEditing(c)}>
											Edit
										</Button>
										<Button
											size="sm"
											variant="danger"
											onClick={async () => {
												const ok = await confirm({
													title: `Delete coupon ${c.code}?`,
													description:
														c.usageCount > 0
															? `This coupon has been used ${c.usageCount} time(s). Deleting it won't revert those orders, but shoppers can't redeem it anymore.`
															: "Customers will no longer be able to use this code.",
													confirmLabel: "Delete",
													destructive: true,
												});
												if (!ok) return;
												try {
													await api.delete(`admin/coupons/item?id=${encodeURIComponent(c.id)}`);
													toast.success("Coupon deleted");
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

			{(creating || editing) && (
				<CouponEditor
					key={editing?.id ?? "new"}
					initial={editing}
					currencies={enabledCurrencies}
					onClose={() => {
						setEditing(null);
						setCreating(false);
					}}
					onSave={async (payload) => {
						try {
							if (editing) {
								await api.post(`admin/coupons/item?id=${encodeURIComponent(editing.id)}`, payload);
								toast.success("Coupon updated");
							} else {
								await api.post("admin/coupons", payload);
								toast.success("Coupon created");
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

function CouponEditor({
	initial,
	currencies,
	onClose,
	onSave,
}: {
	initial: Coupon | null;
	currencies: string[];
	onClose: () => void;
	onSave: (payload: Partial<Coupon>) => Promise<void>;
}) {
	const [code, setCode] = useState(initial?.code ?? "");
	const [description, setDescription] = useState(initial?.description ?? "");
	const [discountType, setDiscountType] = useState<DiscountType>(
		initial?.discountType ?? "percent_cart",
	);
	const [percentValue, setPercentValue] = useState<number | null>(
		initial && isPercent(initial.discountType) ? initial.discountValue : 10,
	);
	const [fixedMajor, setFixedMajor] = useState<number | null>(
		initial && isFixed(initial.discountType) ? initial.discountValue / 100 : 5,
	);
	const [currency, setCurrency] = useState<string | null>(
		initial?.currency ?? currencies[0] ?? "USD",
	);
	const [status, setStatus] = useState<"active" | "inactive">(initial?.status ?? "active");
	const [startsAt, setStartsAt] = useState<string>(
		initial?.startsAt ? initial.startsAt.slice(0, 10) : "",
	);
	const [endsAt, setEndsAt] = useState<string>(
		initial?.endsAt ? initial.endsAt.slice(0, 10) : "",
	);
	const [usageLimit, setUsageLimit] = useState<number | null>(
		initial?.usageLimit ?? null,
	);
	const [usageLimitPerCustomer, setUsageLimitPerCustomer] = useState<number | null>(
		initial?.usageLimitPerCustomer ?? null,
	);
	const [individualUse, setIndividualUse] = useState(initial?.individualUse ?? false);
	const [excludeSaleItems, setExcludeSaleItems] = useState(
		initial?.excludeSaleItems ?? false,
	);
	const [saving, setSaving] = useState(false);

	const currencyOpts = useMemo(() => currencyOptions(currencies), [currencies]);

	const valid =
		code.trim().length >= 2 &&
		(isPercent(discountType)
			? typeof percentValue === "number" && percentValue > 0 && percentValue <= 100
			: isFixed(discountType)
				? typeof fixedMajor === "number" && fixedMajor > 0 && currency
				: true) &&
		(!startsAt || !endsAt || startsAt <= endsAt);

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
					maxWidth: 560,
					width: "100%",
					padding: "20px 24px",
					maxHeight: "90vh",
					overflowY: "auto",
				}}
			>
				<h2 style={{ margin: "0 0 12px" }}>
					{initial ? `Edit ${initial.code}` : "New coupon"}
				</h2>
				<FormField
					label="Code"
					description="Uppercased automatically. Customers type this at checkout."
				>
					<Input
						value={code}
						onChange={(e) => setCode(e.currentTarget.value.toUpperCase())}
						placeholder="SUMMER25"
						disabled={saving || !!initial}
					/>
				</FormField>
				<FormField
					label="Internal description"
					description="Visible only in the admin."
				>
					<Input
						value={description}
						onChange={(e) => setDescription(e.currentTarget.value)}
						placeholder="Summer seasonal launch"
						disabled={saving}
					/>
				</FormField>
				<FormField label="Discount type">
					<Select
						value={discountType}
						options={DISCOUNT_TYPES}
						onChange={(e) => setDiscountType(e.currentTarget.value as DiscountType)}
						disabled={saving}
					/>
				</FormField>
				{isPercent(discountType) && (
					<FormField label="Percent off">
						<NumberInput
							value={percentValue}
							onChange={(v) => setPercentValue(v ?? null)}
							min={0.01}
							max={100}
							step={0.01}
							suffix="%"
							disabled={saving}
						/>
					</FormField>
				)}
				{isFixed(discountType) && (
					<>
						<FormField label="Amount off">
							<NumberInput
								value={fixedMajor}
								onChange={(v) => setFixedMajor(v ?? null)}
								min={0.01}
								step={0.01}
								prefix={currency ?? "USD"}
								disabled={saving}
							/>
						</FormField>
						<FormField
							label="Currency"
							description="Coupon only applies to carts in this currency."
						>
							<Combobox
								value={currency}
								onChange={(next) => setCurrency(next)}
								options={currencyOpts}
								disabled={saving}
							/>
						</FormField>
					</>
				)}
				<FormField label="Status">
					<Select
						value={status}
						options={[
							{ value: "active", label: "Active" },
							{ value: "inactive", label: "Inactive" },
						]}
						onChange={(e) => setStatus(e.currentTarget.value as "active" | "inactive")}
						disabled={saving}
					/>
				</FormField>
				<div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
					<FormField label="Starts (optional)" style={{ flex: "1 1 200px" }}>
						<Input
							type="date"
							value={startsAt}
							onChange={(e) => setStartsAt(e.currentTarget.value)}
							disabled={saving}
						/>
					</FormField>
					<FormField label="Ends (optional)" style={{ flex: "1 1 200px" }}>
						<Input
							type="date"
							value={endsAt}
							onChange={(e) => setEndsAt(e.currentTarget.value)}
							disabled={saving}
						/>
					</FormField>
				</div>
				{startsAt && endsAt && startsAt > endsAt && (
					<Alert type="error" title="End date must be after start date." />
				)}
				<div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
					<FormField
						label="Usage limit (total)"
						description="Leave blank for unlimited."
						style={{ flex: "1 1 200px" }}
					>
						<NumberInput
							value={usageLimit}
							onChange={(v) => setUsageLimit(v ?? null)}
							min={1}
							step={1}
							disabled={saving}
						/>
					</FormField>
					<FormField
						label="Per-customer limit"
						description="Leave blank for unlimited."
						style={{ flex: "1 1 200px" }}
					>
						<NumberInput
							value={usageLimitPerCustomer}
							onChange={(v) => setUsageLimitPerCustomer(v ?? null)}
							min={1}
							step={1}
							disabled={saving}
						/>
					</FormField>
				</div>
				<div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginTop: 8 }}>
					<Toggle
						label="Cannot combine with other coupons"
						checked={individualUse}
						onChange={setIndividualUse}
						disabled={saving}
					/>
					<Toggle
						label="Exclude sale items"
						checked={excludeSaleItems}
						onChange={setExcludeSaleItems}
						disabled={saving}
					/>
				</div>
				<div
					style={{
						display: "flex",
						justifyContent: "flex-end",
						gap: 8,
						marginTop: 20,
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
							const discountValue = isPercent(discountType)
								? percentValue ?? 0
								: isFixed(discountType)
									? Math.round((fixedMajor ?? 0) * 100)
									: 0;
							const payload: Partial<Coupon> = {
								code: code.trim().toUpperCase(),
								description: description.trim() || undefined,
								discountType,
								discountValue,
								status,
								excludeSaleItems,
								individualUse,
								...(isFixed(discountType) && currency
									? { currency: currency as Coupon["currency"] }
									: {}),
								...(startsAt
									? { startsAt: new Date(startsAt).toISOString() as Coupon["startsAt"] }
									: {}),
								...(endsAt
									? { endsAt: new Date(`${endsAt}T23:59:59.999Z`).toISOString() as Coupon["endsAt"] }
									: {}),
								...(typeof usageLimit === "number" ? { usageLimit } : {}),
								...(typeof usageLimitPerCustomer === "number"
									? { usageLimitPerCustomer }
									: {}),
							};
							try {
								await onSave(payload);
							} finally {
								setSaving(false);
							}
						}}
					>
						{saving ? "Saving…" : initial ? "Save changes" : "Create"}
					</Button>
				</div>
			</div>
		</div>
	);
}
