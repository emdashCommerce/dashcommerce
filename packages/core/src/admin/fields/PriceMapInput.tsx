/**
 * PriceMapInput — custom field widget for product `prices` (and variant
 * prices in the future). Replaces the bare JSON textarea that forces
 * operators to type `{"USD": {"amount": 1999}}` by hand — the source of
 * the "Product not priced in GBP" errors when they seed in one currency
 * and switch the cart to another.
 *
 * Renders one row per currency enabled in store Settings, each with a
 * minor-unit amount (cents/pence) and optional strikethrough compare-at.
 * Inactive rows represent "not sold in this currency"; removing a row
 * deletes its entry from the PriceMap.
 *
 * The widget writes back a plain `Record<CurrencyCode, { amount, compareAtAmount? }>`
 * object — the exact shape the cart's `resolvePrice` expects — so no
 * server-side normalisation is needed beyond the existing content hook
 * validation.
 */

import { useEffect, useMemo, useState } from "react";
import {
	Alert,
	Button,
	Combobox,
	type ComboboxOption,
	FormField,
	Loading,
	NumberInput,
	Toggle,
	currencyOptions,
	getCurrencyInfo,
	usePluginAPI,
} from "../kit";

interface PriceEntry {
	amount: number;
	compareAtAmount?: number;
}

type PriceMapValue = Record<string, PriceEntry>;

export interface PriceMapInputProps {
	value?: PriceMapValue | string | null;
	onChange?: (next: PriceMapValue) => void;
	field?: { label?: string; help?: string; required?: boolean };
	readOnly?: boolean;
}

interface SettingsShape {
	enabledCurrencies?: unknown;
	defaultCurrency?: unknown;
}

/**
 * Emdash sometimes hands the value back as a JSON string (the underlying
 * field type is `json`) rather than a parsed object. Handle both so the
 * widget renders on first save-then-reload as well as when paired with a
 * live React state parent.
 */
function parseValue(raw: PriceMapInputProps["value"]): PriceMapValue {
	if (!raw) return {};
	if (typeof raw === "string") {
		try {
			const parsed = JSON.parse(raw);
			return parsed && typeof parsed === "object" ? (parsed as PriceMapValue) : {};
		} catch {
			return {};
		}
	}
	if (typeof raw === "object") return raw as PriceMapValue;
	return {};
}

export function PriceMapInput(props: PriceMapInputProps) {
	const api = usePluginAPI();
	const [enabledCurrencies, setEnabledCurrencies] = useState<string[] | null>(
		null,
	);
	const [defaultCurrency, setDefaultCurrency] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let alive = true;
		api
			.get<SettingsShape>("admin/settings")
			.then((s) => {
				if (!alive) return;
				const raw = s.enabledCurrencies;
				const list = Array.isArray(raw)
					? raw.filter((c): c is string => typeof c === "string")
					: [];
				setEnabledCurrencies(list.length > 0 ? list : ["USD"]);
				setDefaultCurrency(
					typeof s.defaultCurrency === "string" ? s.defaultCurrency : null,
				);
			})
			.catch((err) => {
				if (!alive) return;
				setError(err instanceof Error ? err.message : "Could not load settings");
				// Fail open: still let the operator edit prices even if settings
				// fetch failed. USD is a safe fallback since the server default
				// currency is USD when unset.
				setEnabledCurrencies(["USD"]);
			});
		return () => {
			alive = false;
		};
	}, [api]);

	if (enabledCurrencies === null) {
		return <Loading label="Loading price editor…" />;
	}

	return (
		<PriceMapEditor
			{...props}
			enabledCurrencies={enabledCurrencies}
			defaultCurrency={defaultCurrency}
			settingsError={error}
		/>
	);
}

interface PriceMapEditorProps extends PriceMapInputProps {
	enabledCurrencies: string[];
	defaultCurrency: string | null;
	settingsError: string | null;
}

function PriceMapEditor({
	value,
	onChange,
	field,
	readOnly,
	enabledCurrencies,
	defaultCurrency,
	settingsError,
}: PriceMapEditorProps) {
	const priceMap = useMemo(() => parseValue(value), [value]);
	const [showCompareAt, setShowCompareAt] = useState(() =>
		Object.values(priceMap).some((p) => typeof p.compareAtAmount === "number"),
	);

	// Currencies we show rows for: union of enabled + anything already set on
	// the product (so operators see legacy prices even after disabling a
	// currency, and can explicitly clear them).
	const rowCodes = useMemo(() => {
		const set = new Set<string>([...enabledCurrencies, ...Object.keys(priceMap)]);
		return Array.from(set).sort((a, b) => {
			if (a === defaultCurrency) return -1;
			if (b === defaultCurrency) return 1;
			if (enabledCurrencies.includes(a) && !enabledCurrencies.includes(b)) return -1;
			if (!enabledCurrencies.includes(a) && enabledCurrencies.includes(b)) return 1;
			return a.localeCompare(b);
		});
	}, [enabledCurrencies, priceMap, defaultCurrency]);

	// Extra currencies the operator can add (global ISO-4217 table minus the
	// ones we already render as rows).
	const addableOptions = useMemo<ComboboxOption[]>(() => {
		const shown = new Set(rowCodes);
		return currencyOptions().filter((opt) => !shown.has(opt.value));
	}, [rowCodes]);

	function update(next: PriceMapValue): void {
		onChange?.(next);
	}

	function setAmount(code: string, amount: number | undefined): void {
		if (amount === undefined || amount === null) {
			const { [code]: _drop, ...rest } = priceMap;
			update(rest);
			return;
		}
		update({
			...priceMap,
			[code]: {
				...priceMap[code],
				amount: Math.max(0, Math.round(amount)),
			},
		});
	}

	function setCompareAt(code: string, amount: number | undefined): void {
		const existing = priceMap[code];
		if (!existing) return;
		if (amount === undefined || amount === null || amount === 0) {
			const { compareAtAmount: _drop, ...rest } = existing;
			update({ ...priceMap, [code]: rest });
			return;
		}
		update({
			...priceMap,
			[code]: {
				...existing,
				compareAtAmount: Math.max(0, Math.round(amount)),
			},
		});
	}

	function removeRow(code: string): void {
		const { [code]: _drop, ...rest } = priceMap;
		update(rest);
	}

	function addRow(code: string | null): void {
		if (!code) return;
		if (priceMap[code] !== undefined) return;
		update({ ...priceMap, [code]: { amount: 0 } });
	}

	const pricedCount = Object.keys(priceMap).length;
	const missingDefault =
		defaultCurrency && priceMap[defaultCurrency] === undefined;
	const unsetEnabled = enabledCurrencies.filter((c) => priceMap[c] === undefined);

	return (
		<FormField
			label={field?.label ?? "Prices"}
			description={
				field?.help ??
				"Set an amount for each currency you accept. Amounts are in minor units (e.g. 1999 = $19.99)."
			}
			{...(field?.required ? { required: true } : {})}
		>
			{settingsError && (
				<div style={{ marginBottom: 8 }}>
					<Alert type="info" title="Using default currency list">
						Could not reach settings ({settingsError}). Showing USD only — save
						and refresh once Settings is reachable to see your full list.
					</Alert>
				</div>
			)}
			{missingDefault && (
				<div style={{ marginBottom: 8 }}>
					<Alert type="warning" title={`Missing ${defaultCurrency} price`}>
						{defaultCurrency} is the store default currency. Customers whose
						cart falls back to the default currency won't be able to buy this
						product without a {defaultCurrency} price.
					</Alert>
				</div>
			)}
			{!missingDefault && unsetEnabled.length > 0 && (
				<div style={{ marginBottom: 8 }}>
					<Alert type="info" title="Some currencies have no price">
						{unsetEnabled.join(", ")} — customers whose cart is set to these
						currencies won't be able to buy this product.
					</Alert>
				</div>
			)}

			<div
				style={{
					display: "flex",
					alignItems: "center",
					justifyContent: "space-between",
					marginBottom: 6,
					gap: 8,
				}}
			>
				<Toggle
					label="Show compare-at (sale) prices"
					checked={showCompareAt}
					onChange={setShowCompareAt}
					disabled={readOnly}
				/>
				<span style={{ color: "#888", fontSize: "0.85em" }}>
					{pricedCount} currenc{pricedCount === 1 ? "y" : "ies"} priced
				</span>
			</div>

			<div
				style={{
					display: "flex",
					flexDirection: "column",
					gap: 6,
					border: "1px solid #e4e4e7",
					borderRadius: 6,
					padding: 8,
					background: "#fafafa",
				}}
			>
				{rowCodes.length === 0 ? (
					<p style={{ color: "#888", fontSize: "0.9em", margin: "4px 0" }}>
						No currencies configured. Enable at least one currency in store
						Settings, then come back to price this product.
					</p>
				) : (
					rowCodes.map((code) => (
						<PriceRow
							key={code}
							code={code}
							entry={priceMap[code]}
							isDefault={code === defaultCurrency}
							isEnabled={enabledCurrencies.includes(code)}
							showCompareAt={showCompareAt}
							readOnly={readOnly}
							onAmountChange={(v) => setAmount(code, v)}
							onCompareAtChange={(v) => setCompareAt(code, v)}
							onRemove={() => removeRow(code)}
						/>
					))
				)}
			</div>

			{addableOptions.length > 0 && !readOnly && (
				<div style={{ marginTop: 8 }}>
					<details>
						<summary
							style={{
								cursor: "pointer",
								fontSize: "0.85em",
								color: "#555",
							}}
						>
							Add another currency (not in your enabled list)
						</summary>
						<div style={{ marginTop: 6, maxWidth: 320 }}>
							<Combobox
								value={null}
								onChange={addRow}
								options={addableOptions}
								placeholder="Pick a currency to add…"
							/>
						</div>
					</details>
				</div>
			)}
		</FormField>
	);
}

function PriceRow({
	code,
	entry,
	isDefault,
	isEnabled,
	showCompareAt,
	readOnly,
	onAmountChange,
	onCompareAtChange,
	onRemove,
}: {
	code: string;
	entry: PriceEntry | undefined;
	isDefault: boolean;
	isEnabled: boolean;
	showCompareAt: boolean;
	readOnly?: boolean;
	onAmountChange: (v: number | undefined) => void;
	onCompareAtChange: (v: number | undefined) => void;
	onRemove: () => void;
}) {
	const info = getCurrencyInfo(code);
	const symbol = info?.symbol ?? code;
	const active = entry !== undefined;

	return (
		<div
			style={{
				display: "grid",
				gridTemplateColumns: showCompareAt
					? "140px 1fr 1fr 32px"
					: "140px 1fr 32px",
				alignItems: "center",
				gap: 8,
				padding: "4px 2px",
			}}
		>
			<div>
				<strong style={{ fontFamily: "var(--font-mono)" }}>{code}</strong>
				<div style={{ fontSize: "0.75em", color: "#888" }}>
					{info?.name ?? "Unknown currency"}
					{isDefault && (
						<span
							style={{
								marginLeft: 4,
								background: "#eef2ff",
								color: "#3730a3",
								borderRadius: 3,
								padding: "0 4px",
							}}
						>
							default
						</span>
					)}
					{!isEnabled && (
						<span
							style={{
								marginLeft: 4,
								background: "#fef3c7",
								color: "#92400e",
								borderRadius: 3,
								padding: "0 4px",
							}}
						>
							not enabled
						</span>
					)}
				</div>
			</div>
			<NumberInput
				value={entry?.amount ?? null}
				onChange={onAmountChange}
				min={0}
				step={1}
				prefix={symbol}
				placeholder={active ? "0" : "Not sold in this currency"}
				disabled={readOnly}
			/>
			{showCompareAt && (
				<NumberInput
					value={entry?.compareAtAmount ?? null}
					onChange={onCompareAtChange}
					min={0}
					step={1}
					prefix={symbol}
					placeholder="Compare-at (optional)"
					disabled={readOnly || !active}
				/>
			)}
			<Button
				size="sm"
				variant="secondary"
				onClick={onRemove}
				disabled={readOnly || !active}
				aria-label={`Remove ${code}`}
			>
				×
			</Button>
		</div>
	);
}
