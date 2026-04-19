/**
 * Shipping page — full CRUD for zones, methods and classes.
 *
 * Zones own methods, so the UI renders methods inline under each zone and
 * blocks zone deletion while methods still reference it. Classes are a
 * globally-shared taxonomy (product `shippingClassSlug` points at a slug)
 * and get their own card below.
 *
 * Method config is polymorphic (`flat_rate | free_shipping | local_pickup |
 * weight_based`); the editor swaps the config sub-form based on the chosen
 * type and always produces a well-typed ShippingMethodConfig before saving.
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
	MoneyMinor,
	MultiSelect,
	NumberInput,
	Select,
	Table,
	Toggle,
	confirm,
	countryOptions,
	currencyOptions,
	toast,
	usePluginAPI,
} from "../kit";
import { EmptyState } from "../ui/EmptyState";
import type {
	ShippingClass,
	ShippingMethod,
	ShippingMethodConfig,
	ShippingMethodType,
	ShippingZone,
} from "../../types";

interface ShippingShape {
	zones: ShippingZone[];
	methods: ShippingMethod[];
	classes: ShippingClass[];
}

const METHOD_TYPE_LABELS: Record<ShippingMethodType, string> = {
	flat_rate: "Flat rate",
	free_shipping: "Free shipping",
	local_pickup: "Local pickup",
	weight_based: "Weight-based",
};

export function ShippingPage() {
	const api = usePluginAPI();
	const [data, setData] = useState<ShippingShape | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [currencies, setCurrencies] = useState<string[]>(["USD"]);

	const [editingZone, setEditingZone] = useState<ShippingZone | null>(null);
	const [creatingZone, setCreatingZone] = useState(false);
	const [editingMethod, setEditingMethod] = useState<{
		zoneId: string;
		method: ShippingMethod | null;
	} | null>(null);
	const [editingClass, setEditingClass] = useState<ShippingClass | null>(null);
	const [creatingClass, setCreatingClass] = useState(false);

	const reload = useCallback(async () => {
		try {
			const [shape, settings] = await Promise.all([
				api.get<ShippingShape>("admin/shipping"),
				api.get<Record<string, unknown>>("admin/settings"),
			]);
			setData(shape);
			const raw = settings.enabledCurrencies;
			if (Array.isArray(raw) && raw.length > 0) {
				setCurrencies(raw.filter((c): c is string => typeof c === "string"));
			}
			setError(null);
		} catch (err) {
			setError(err instanceof Error ? err.message : "Could not load shipping");
		}
	}, [api]);

	useEffect(() => {
		reload();
	}, [reload]);

	if (error) return <Alert type="error" title="Shipping unavailable">{error}</Alert>;
	if (!data) return <Loading />;

	const methodsByZone = new Map<string, ShippingMethod[]>();
	for (const m of data.methods) {
		const arr = methodsByZone.get(m.zoneId) ?? [];
		arr.push(m);
		methodsByZone.set(m.zoneId, arr);
	}

	async function deleteZone(zone: ShippingZone) {
		const methodCount = methodsByZone.get(zone.id)?.length ?? 0;
		if (methodCount > 0) {
			toast.error(
				"Zone still has methods",
				"Delete or move the methods first.",
			);
			return;
		}
		const ok = await confirm({
			title: "Delete shipping zone?",
			description: `Zone "${zone.name}" will be removed. Customers whose address matched this zone will fall back to the default zone.`,
			confirmLabel: "Delete zone",
			destructive: true,
		});
		if (!ok) return;
		try {
			await api.delete(`admin/shipping/zones/item?id=${encodeURIComponent(zone.id)}`);
			toast.success("Zone deleted");
			await reload();
		} catch (err) {
			toast.error(
				"Delete failed",
				err instanceof Error ? err.message : undefined,
			);
		}
	}

	async function deleteMethod(method: ShippingMethod) {
		const ok = await confirm({
			title: "Delete shipping method?",
			description: `"${method.title}" will no longer be offered at checkout.`,
			confirmLabel: "Delete",
			destructive: true,
		});
		if (!ok) return;
		try {
			await api.delete(`admin/shipping/methods/item?id=${encodeURIComponent(method.id)}`);
			toast.success("Method deleted");
			await reload();
		} catch (err) {
			toast.error(
				"Delete failed",
				err instanceof Error ? err.message : undefined,
			);
		}
	}

	async function deleteClass(cls: ShippingClass) {
		const ok = await confirm({
			title: "Delete shipping class?",
			description: `Class "${cls.name}" (slug: ${cls.slug}) will be removed. Products pointing at this slug will fall back to the default class.`,
			confirmLabel: "Delete class",
			destructive: true,
		});
		if (!ok) return;
		try {
			await api.delete(`admin/shipping/classes/item?id=${encodeURIComponent(cls.id)}`);
			toast.success("Class deleted");
			await reload();
		} catch (err) {
			toast.error(
				"Delete failed",
				err instanceof Error ? err.message : undefined,
			);
		}
	}

	return (
		<div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
			<Card title="Zones">
				<div
					style={{
						display: "flex",
						justifyContent: "space-between",
						alignItems: "center",
						marginBottom: 8,
					}}
				>
					<p style={{ margin: 0, color: "#555", fontSize: "0.9em" }}>
						Zones match customer addresses to a set of available shipping
						methods. A zone with no locations is the fallback "everywhere" zone.
					</p>
					<Button variant="primary" onClick={() => setCreatingZone(true)}>
						Add zone
					</Button>
				</div>
				{data.zones.length === 0 ? (
					<EmptyState
						title="No shipping zones"
						description="Create at least one zone so customers see shipping options at checkout."
						action={
							<Button variant="primary" onClick={() => setCreatingZone(true)}>
								Add the first zone
							</Button>
						}
					/>
				) : (
					<div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
						{data.zones.map((zone) => (
							<ZoneCard
								key={zone.id}
								zone={zone}
								methods={methodsByZone.get(zone.id) ?? []}
								onEditZone={() => setEditingZone(zone)}
								onDeleteZone={() => deleteZone(zone)}
								onAddMethod={() =>
									setEditingMethod({ zoneId: zone.id, method: null })
								}
								onEditMethod={(m) =>
									setEditingMethod({ zoneId: zone.id, method: m })
								}
								onDeleteMethod={(m) => deleteMethod(m)}
							/>
						))}
					</div>
				)}
			</Card>

			<Card title="Shipping classes">
				<div
					style={{
						display: "flex",
						justifyContent: "space-between",
						alignItems: "center",
						marginBottom: 8,
					}}
				>
					<p style={{ margin: 0, color: "#555", fontSize: "0.9em" }}>
						Classes let you charge different rates for grouped products (e.g.
						"bulky", "hazmat"). Assign a class to a product from the product
						edit screen.
					</p>
					<Button variant="primary" onClick={() => setCreatingClass(true)}>
						Add class
					</Button>
				</div>
				{data.classes.length === 0 ? (
					<EmptyState
						title="No shipping classes"
						description="Classes are optional — skip if all products ship the same way."
					/>
				) : (
					<Table<ShippingClass>
						data={data.classes}
						getRowKey={(c) => c.id}
						columns={[
							{ key: "slug", header: "Slug", render: (c) => <code>{c.slug}</code> },
							{ key: "name", header: "Name", render: (c) => c.name },
							{
								key: "desc",
								header: "Description",
								render: (c) => c.description ?? "—",
							},
							{
								key: "actions",
								header: "",
								render: (c) => (
									<div style={{ display: "flex", gap: 4 }}>
										<Button size="sm" onClick={() => setEditingClass(c)}>
											Edit
										</Button>
										<Button
											size="sm"
											variant="danger"
											onClick={() => deleteClass(c)}
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

			{(creatingZone || editingZone) && (
				<ZoneEditor
					key={editingZone?.id ?? "new-zone"}
					initial={editingZone}
					onClose={() => {
						setEditingZone(null);
						setCreatingZone(false);
					}}
					onSave={async (patch) => {
						try {
							if (editingZone) {
								await api.patch(
									`admin/shipping/zones/item?id=${encodeURIComponent(editingZone.id)}`,
									patch,
								);
								toast.success("Zone updated");
							} else {
								await api.post("admin/shipping/zones", patch);
								toast.success("Zone added");
							}
							setEditingZone(null);
							setCreatingZone(false);
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

			{editingMethod && (
				<MethodEditor
					key={editingMethod.method?.id ?? `new-method-${editingMethod.zoneId}`}
					zoneId={editingMethod.zoneId}
					zoneName={
						data.zones.find((z) => z.id === editingMethod.zoneId)?.name ??
						"zone"
					}
					initial={editingMethod.method}
					currencies={currencies}
					classes={data.classes}
					onClose={() => setEditingMethod(null)}
					onSave={async (payload) => {
						try {
							if (editingMethod.method) {
								await api.patch(
									`admin/shipping/methods/item?id=${encodeURIComponent(editingMethod.method.id)}`,
									payload,
								);
								toast.success("Method updated");
							} else {
								await api.post("admin/shipping/methods", payload);
								toast.success("Method added");
							}
							setEditingMethod(null);
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

			{(creatingClass || editingClass) && (
				<ClassEditor
					key={editingClass?.id ?? "new-class"}
					initial={editingClass}
					onClose={() => {
						setEditingClass(null);
						setCreatingClass(false);
					}}
					onSave={async (patch) => {
						try {
							if (editingClass) {
								await api.patch(
									`admin/shipping/classes/item?id=${encodeURIComponent(editingClass.id)}`,
									patch,
								);
								toast.success("Class updated");
							} else {
								await api.post("admin/shipping/classes", patch);
								toast.success("Class added");
							}
							setEditingClass(null);
							setCreatingClass(false);
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

function ZoneCard({
	zone,
	methods,
	onEditZone,
	onDeleteZone,
	onAddMethod,
	onEditMethod,
	onDeleteMethod,
}: {
	zone: ShippingZone;
	methods: ShippingMethod[];
	onEditZone: () => void;
	onDeleteZone: () => void;
	onAddMethod: () => void;
	onEditMethod: (method: ShippingMethod) => void;
	onDeleteMethod: (method: ShippingMethod) => void;
}) {
	const covers =
		zone.locations.length === 0
			? "Everywhere (fallback)"
			: zone.locations.map((l) => l.country).join(", ");

	return (
		<div
			style={{
				border: "1px solid #e4e4e7",
				borderRadius: 6,
				padding: 12,
				background: "#fafafa",
			}}
		>
			<div
				style={{
					display: "flex",
					justifyContent: "space-between",
					alignItems: "flex-start",
					gap: 12,
				}}
			>
				<div>
					<div style={{ fontWeight: 600 }}>{zone.name}</div>
					<div style={{ color: "#666", fontSize: "0.85em" }}>{covers}</div>
				</div>
				<div style={{ display: "flex", gap: 4 }}>
					<Button size="sm" onClick={onEditZone}>
						Edit zone
					</Button>
					<Button size="sm" variant="danger" onClick={onDeleteZone}>
						Delete
					</Button>
				</div>
			</div>

			<div style={{ marginTop: 12 }}>
				<div
					style={{
						display: "flex",
						justifyContent: "space-between",
						alignItems: "center",
						marginBottom: 4,
					}}
				>
					<strong style={{ fontSize: "0.9em" }}>
						Methods ({methods.length})
					</strong>
					<Button size="sm" onClick={onAddMethod}>
						Add method
					</Button>
				</div>
				{methods.length === 0 ? (
					<p style={{ color: "#888", fontSize: "0.85em", margin: "4px 0 0" }}>
						No methods yet — customers in this zone won't see any shipping
						options.
					</p>
				) : (
					<Table<ShippingMethod>
						data={methods}
						getRowKey={(m) => m.id}
						columns={[
							{
								key: "title",
								header: "Title",
								render: (m) => (
									<span>
										{m.title}
										{!m.enabled && (
											<span
												style={{
													color: "#a1a1aa",
													fontSize: "0.8em",
													marginLeft: 6,
												}}
											>
												(disabled)
											</span>
										)}
									</span>
								),
							},
							{
								key: "type",
								header: "Type",
								render: (m) => METHOD_TYPE_LABELS[m.type],
							},
							{
								key: "cost",
								header: "Cost",
								render: (m) => <MethodCostSummary method={m} />,
							},
							{
								key: "actions",
								header: "",
								render: (m) => (
									<div style={{ display: "flex", gap: 4 }}>
										<Button size="sm" onClick={() => onEditMethod(m)}>
											Edit
										</Button>
										<Button
											size="sm"
											variant="danger"
											onClick={() => onDeleteMethod(m)}
										>
											Delete
										</Button>
									</div>
								),
							},
						]}
					/>
				)}
			</div>
		</div>
	);
}

function MethodCostSummary({ method }: { method: ShippingMethod }) {
	const c = method.config;
	switch (c.type) {
		case "flat_rate":
			return <MoneyMinor amount={c.amount.amount} currency={c.amount.currency} />;
		case "free_shipping":
			if (c.minimumAmount)
				return (
					<span>
						Free over{" "}
						<MoneyMinor
							amount={c.minimumAmount.amount}
							currency={c.minimumAmount.currency}
						/>
					</span>
				);
			return <span>Free</span>;
		case "local_pickup":
			if (c.amount)
				return <MoneyMinor amount={c.amount.amount} currency={c.amount.currency} />;
			return <span>Free pickup</span>;
		case "weight_based":
			return (
				<span>
					<MoneyMinor amount={c.base.amount} currency={c.base.currency} /> +
					{c.perGram}/g
				</span>
			);
	}
}

// ────────────────────────────────────────────────────────────────────────────
// Zone editor
// ────────────────────────────────────────────────────────────────────────────

function ZoneEditor({
	initial,
	onClose,
	onSave,
}: {
	initial: ShippingZone | null;
	onClose: () => void;
	onSave: (patch: Partial<ShippingZone>) => Promise<void>;
}) {
	const countryOpts = useMemo(() => countryOptions(), []);
	const [name, setName] = useState(initial?.name ?? "");
	const [countries, setCountries] = useState<string[]>(
		initial?.locations.map((l) => l.country) ?? [],
	);
	const [order, setOrder] = useState<number | null>(initial?.order ?? 0);
	const [saving, setSaving] = useState(false);

	const valid = name.trim().length > 0 && typeof order === "number";

	return (
		<EditorShell
			title={initial ? "Edit zone" : "Add zone"}
			onClose={onClose}
			saving={saving}
			canSave={valid}
			onSave={async () => {
				if (!valid) return;
				setSaving(true);
				try {
					await onSave({
						name: name.trim(),
						locations: countries.map((c) => ({
							country: c as ShippingZone["locations"][number]["country"],
						})),
						order: order ?? 0,
					});
				} finally {
					setSaving(false);
				}
			}}
		>
			<FormField label="Name">
				<Input
					value={name}
					onChange={(e) => setName(e.currentTarget.value)}
					placeholder="e.g. United States"
					disabled={saving}
				/>
			</FormField>
			<FormField
				label="Countries"
				description="Leave empty for a fallback 'everywhere' zone — only do this once per store."
			>
				<MultiSelect
					value={countries}
					onChange={setCountries}
					options={countryOpts}
					disabled={saving}
					placeholder="Add country…"
				/>
			</FormField>
			<FormField
				label="Order"
				description="Lower numbers are evaluated first. Use this when zones overlap."
			>
				<NumberInput
					value={order}
					onChange={(v) => setOrder(v ?? 0)}
					min={0}
					max={1000}
					step={1}
					disabled={saving}
				/>
			</FormField>
		</EditorShell>
	);
}

// ────────────────────────────────────────────────────────────────────────────
// Method editor — polymorphic config sub-form
// ────────────────────────────────────────────────────────────────────────────

function MethodEditor({
	zoneId,
	zoneName,
	initial,
	currencies,
	classes,
	onClose,
	onSave,
}: {
	zoneId: string;
	zoneName: string;
	initial: ShippingMethod | null;
	currencies: string[];
	classes: ShippingClass[];
	onClose: () => void;
	onSave: (payload: Partial<ShippingMethod>) => Promise<void>;
}) {
	const currencyOpts = useMemo(() => currencyOptions(currencies), [currencies]);
	const defaultCurrency = currencies[0] ?? "USD";

	const [title, setTitle] = useState(initial?.title ?? "Standard shipping");
	const [type, setType] = useState<ShippingMethodType>(
		initial?.type ?? "flat_rate",
	);
	const [enabled, setEnabled] = useState(initial?.enabled ?? true);
	const [order, setOrder] = useState<number | null>(initial?.order ?? 0);

	// Flat rate
	const flatInitial =
		initial?.config.type === "flat_rate" ? initial.config : null;
	const [flatCurrency, setFlatCurrency] = useState<string | null>(
		flatInitial?.amount.currency ?? defaultCurrency,
	);
	const [flatAmount, setFlatAmount] = useState<number | null>(
		flatInitial ? flatInitial.amount.amount : 0,
	);
	const [classRates, setClassRates] = useState<
		Record<string, number | null>
	>(() => {
		const out: Record<string, number | null> = {};
		for (const cls of classes) {
			out[cls.slug] = flatInitial?.shippingClassRates?.[cls.slug]?.amount ?? null;
		}
		return out;
	});

	// Free shipping
	const freeInitial =
		initial?.config.type === "free_shipping" ? initial.config : null;
	const [freeMinEnabled, setFreeMinEnabled] = useState(
		Boolean(freeInitial?.minimumAmount),
	);
	const [freeMinCurrency, setFreeMinCurrency] = useState<string | null>(
		freeInitial?.minimumAmount?.currency ?? defaultCurrency,
	);
	const [freeMinAmount, setFreeMinAmount] = useState<number | null>(
		freeInitial?.minimumAmount?.amount ?? 0,
	);
	const [freeRequiresCoupon, setFreeRequiresCoupon] = useState(
		freeInitial?.requiresCoupon ?? false,
	);

	// Local pickup
	const pickupInitial =
		initial?.config.type === "local_pickup" ? initial.config : null;
	const [pickupHasCost, setPickupHasCost] = useState(
		Boolean(pickupInitial?.amount),
	);
	const [pickupCurrency, setPickupCurrency] = useState<string | null>(
		pickupInitial?.amount?.currency ?? defaultCurrency,
	);
	const [pickupAmount, setPickupAmount] = useState<number | null>(
		pickupInitial?.amount?.amount ?? 0,
	);

	// Weight-based
	const weightInitial =
		initial?.config.type === "weight_based" ? initial.config : null;
	const [weightCurrency, setWeightCurrency] = useState<string | null>(
		weightInitial?.currency ?? defaultCurrency,
	);
	const [weightBase, setWeightBase] = useState<number | null>(
		weightInitial?.base.amount ?? 0,
	);
	const [weightPerGram, setWeightPerGram] = useState<number | null>(
		weightInitial?.perGram ?? 0,
	);

	const [saving, setSaving] = useState(false);

	const config = buildConfig();

	function buildConfig(): ShippingMethodConfig | null {
		switch (type) {
			case "flat_rate": {
				if (!flatCurrency || typeof flatAmount !== "number") return null;
				const overrides: Record<string, { amount: number; currency: string }> = {};
				for (const [slug, amt] of Object.entries(classRates)) {
					if (typeof amt === "number" && amt > 0) {
						overrides[slug] = { amount: amt, currency: flatCurrency };
					}
				}
				return {
					type: "flat_rate",
					amount: { amount: flatAmount, currency: flatCurrency },
					...(Object.keys(overrides).length > 0
						? { shippingClassRates: overrides }
						: {}),
				};
			}
			case "free_shipping": {
				if (
					freeMinEnabled &&
					(!freeMinCurrency || typeof freeMinAmount !== "number")
				)
					return null;
				return {
					type: "free_shipping",
					...(freeMinEnabled && freeMinCurrency && typeof freeMinAmount === "number"
						? {
								minimumAmount: {
									amount: freeMinAmount,
									currency: freeMinCurrency,
								},
							}
						: {}),
					...(freeRequiresCoupon ? { requiresCoupon: true } : {}),
				};
			}
			case "local_pickup": {
				if (!pickupHasCost) return { type: "local_pickup" };
				if (!pickupCurrency || typeof pickupAmount !== "number") return null;
				return {
					type: "local_pickup",
					amount: { amount: pickupAmount, currency: pickupCurrency },
				};
			}
			case "weight_based": {
				if (
					!weightCurrency ||
					typeof weightBase !== "number" ||
					typeof weightPerGram !== "number"
				)
					return null;
				return {
					type: "weight_based",
					currency: weightCurrency,
					base: { amount: weightBase, currency: weightCurrency },
					perGram: weightPerGram,
				};
			}
		}
	}

	const valid = title.trim().length > 0 && config !== null;

	return (
		<EditorShell
			title={
				initial
					? `Edit method — ${zoneName}`
					: `Add method — ${zoneName}`
			}
			onClose={onClose}
			saving={saving}
			canSave={valid}
			onSave={async () => {
				if (!valid || !config) return;
				setSaving(true);
				try {
					await onSave({
						zoneId,
						title: title.trim(),
						type,
						enabled,
						order: order ?? 0,
						config,
					});
				} finally {
					setSaving(false);
				}
			}}
		>
			<FormField label="Title">
				<Input
					value={title}
					onChange={(e) => setTitle(e.currentTarget.value)}
					placeholder="Shown to customers at checkout"
					disabled={saving}
				/>
			</FormField>
			<FormField label="Type">
				<Select
					value={type}
					options={(
						["flat_rate", "free_shipping", "local_pickup", "weight_based"] as const
					).map((t) => ({ value: t, label: METHOD_TYPE_LABELS[t] }))}
					onChange={(e) =>
						setType(e.currentTarget.value as ShippingMethodType)
					}
					disabled={saving}
				/>
			</FormField>

			{type === "flat_rate" && (
				<>
					<FormField label="Currency">
						<Combobox
							value={flatCurrency}
							onChange={setFlatCurrency}
							options={currencyOpts}
							disabled={saving}
						/>
					</FormField>
					<FormField label="Amount (in minor units)" description="USD cents, GBP pence, JPY yen.">
						<NumberInput
							value={flatAmount}
							onChange={(v) => setFlatAmount(v ?? 0)}
							min={0}
							step={1}
							disabled={saving}
						/>
					</FormField>
					{classes.length > 0 && (
						<FormField
							label="Per-class overrides"
							description="Leave blank to use the amount above. Overrides use the same currency."
						>
							<div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
								{classes.map((cls) => (
									<div
										key={cls.id}
										style={{
											display: "grid",
											gridTemplateColumns: "1fr 160px",
											gap: 8,
											alignItems: "center",
										}}
									>
										<span>
											<strong>{cls.name}</strong>{" "}
											<code style={{ color: "#888" }}>{cls.slug}</code>
										</span>
										<NumberInput
											value={classRates[cls.slug] ?? null}
											onChange={(v) =>
												setClassRates((prev) => ({
													...prev,
													[cls.slug]: v ?? null,
												}))
											}
											min={0}
											step={1}
											placeholder="inherit"
											disabled={saving}
										/>
									</div>
								))}
							</div>
						</FormField>
					)}
				</>
			)}

			{type === "free_shipping" && (
				<>
					<Toggle
						label="Require minimum order value"
						checked={freeMinEnabled}
						onChange={setFreeMinEnabled}
						disabled={saving}
					/>
					{freeMinEnabled && (
						<>
							<FormField label="Minimum currency">
								<Combobox
									value={freeMinCurrency}
									onChange={setFreeMinCurrency}
									options={currencyOpts}
									disabled={saving}
								/>
							</FormField>
							<FormField label="Minimum amount (minor units)">
								<NumberInput
									value={freeMinAmount}
									onChange={(v) => setFreeMinAmount(v ?? 0)}
									min={0}
									step={1}
									disabled={saving}
								/>
							</FormField>
						</>
					)}
					<Toggle
						label="Requires a coupon"
						checked={freeRequiresCoupon}
						onChange={setFreeRequiresCoupon}
						disabled={saving}
					/>
				</>
			)}

			{type === "local_pickup" && (
				<>
					<Toggle
						label="Charge for pickup"
						checked={pickupHasCost}
						onChange={setPickupHasCost}
						disabled={saving}
					/>
					{pickupHasCost && (
						<>
							<FormField label="Currency">
								<Combobox
									value={pickupCurrency}
									onChange={setPickupCurrency}
									options={currencyOpts}
									disabled={saving}
								/>
							</FormField>
							<FormField label="Amount (minor units)">
								<NumberInput
									value={pickupAmount}
									onChange={(v) => setPickupAmount(v ?? 0)}
									min={0}
									step={1}
									disabled={saving}
								/>
							</FormField>
						</>
					)}
				</>
			)}

			{type === "weight_based" && (
				<>
					<FormField label="Currency">
						<Combobox
							value={weightCurrency}
							onChange={setWeightCurrency}
							options={currencyOpts}
							disabled={saving}
						/>
					</FormField>
					<FormField label="Base amount (minor units)">
						<NumberInput
							value={weightBase}
							onChange={(v) => setWeightBase(v ?? 0)}
							min={0}
							step={1}
							disabled={saving}
						/>
					</FormField>
					<FormField
						label="Per-gram rate (minor units / gram)"
						description="E.g. 2 means 2 cents per gram of total cart weight."
					>
						<NumberInput
							value={weightPerGram}
							onChange={(v) => setWeightPerGram(v ?? 0)}
							min={0}
							step={0.01}
							disabled={saving}
						/>
					</FormField>
				</>
			)}

			<FormField label="Display order" description="Lower numbers show higher in the checkout list.">
				<NumberInput
					value={order}
					onChange={(v) => setOrder(v ?? 0)}
					min={0}
					max={1000}
					step={1}
					disabled={saving}
				/>
			</FormField>
			<Toggle
				label="Enabled"
				checked={enabled}
				onChange={setEnabled}
				disabled={saving}
			/>
		</EditorShell>
	);
}

// ────────────────────────────────────────────────────────────────────────────
// Class editor
// ────────────────────────────────────────────────────────────────────────────

function ClassEditor({
	initial,
	onClose,
	onSave,
}: {
	initial: ShippingClass | null;
	onClose: () => void;
	onSave: (patch: Partial<ShippingClass>) => Promise<void>;
}) {
	const [slug, setSlug] = useState(initial?.slug ?? "");
	const [name, setName] = useState(initial?.name ?? "");
	const [description, setDescription] = useState(initial?.description ?? "");
	const [saving, setSaving] = useState(false);

	const slugValid = /^[a-z0-9][a-z0-9-_]*$/i.test(slug.trim());
	const valid = slugValid && name.trim().length > 0;

	return (
		<EditorShell
			title={initial ? "Edit class" : "Add class"}
			onClose={onClose}
			saving={saving}
			canSave={valid}
			onSave={async () => {
				if (!valid) return;
				setSaving(true);
				try {
					await onSave({
						slug: slug.trim().toLowerCase(),
						name: name.trim(),
						...(description.trim() ? { description: description.trim() } : {}),
					});
				} finally {
					setSaving(false);
				}
			}}
		>
			<FormField
				label="Slug"
				description="Unique, lowercase identifier used on product records. Changing this will orphan products pointing at the old slug."
			>
				<Input
					value={slug}
					onChange={(e) => setSlug(e.currentTarget.value)}
					placeholder="e.g. bulky"
					disabled={saving || Boolean(initial)}
				/>
			</FormField>
			<FormField label="Name">
				<Input
					value={name}
					onChange={(e) => setName(e.currentTarget.value)}
					placeholder="Display name"
					disabled={saving}
				/>
			</FormField>
			<FormField label="Description">
				<Input
					value={description}
					onChange={(e) => setDescription(e.currentTarget.value)}
					placeholder="Optional notes"
					disabled={saving}
				/>
			</FormField>
		</EditorShell>
	);
}

// ────────────────────────────────────────────────────────────────────────────
// Shared modal shell
// ────────────────────────────────────────────────────────────────────────────

function EditorShell({
	title,
	children,
	onClose,
	onSave,
	saving,
	canSave,
}: {
	title: string;
	children: React.ReactNode;
	onClose: () => void;
	onSave: () => void | Promise<void>;
	saving: boolean;
	canSave: boolean;
}) {
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
				<h2 style={{ margin: "0 0 12px" }}>{title}</h2>
				{children}
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
						disabled={!canSave || saving}
						onClick={onSave}
					>
						{saving ? "Saving…" : "Save"}
					</Button>
				</div>
			</div>
		</div>
	);
}
