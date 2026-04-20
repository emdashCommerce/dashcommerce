/**
 * Reports — revenue, MRR, top products, top customers.
 *
 * Every card shares one `{from, to}` range (driven by the kit
 * `DateRangePicker`) and independently fetches with its own error/empty
 * state + retry button. Revenue and MRR render inline SVG sparklines so
 * operators get a shape-at-a-glance without pulling in a chart library.
 *
 * Per-card "Export CSV" uses a blob download so it works offline from
 * the admin shell's network context.
 */

import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import {
	Alert,
	Button,
	Card,
	type DateRange,
	DateRangePicker,
	Loading,
	type PluginAPI,
	Select,
	Table,
	MoneyMinor,
	usePluginAPI,
} from "../kit";
import { EmptyState } from "../ui/EmptyState";
import type { Customer } from "../../types";

type GroupBy = "day" | "week" | "month";

interface RevSeries {
	groupBy: string;
	series: Array<{ bucket: string; currencies: Record<string, number> }>;
}
interface TopProduct {
	productId: string;
	name: string;
	units: number;
	revenue: number;
	currency: string;
}
interface Mrr {
	mrr: Record<string, number>;
}

function defaultRange(): DateRange {
	const to = new Date().toISOString().slice(0, 10);
	const from = new Date(Date.now() - 29 * 86_400_000).toISOString().slice(0, 10);
	return { from, to };
}

export function ReportsPage() {
	const [range, setRange] = useState<DateRange>(defaultRange);
	const [groupBy, setGroupBy] = useState<GroupBy>("day");

	const rangeQuery = useMemo(
		() => ({ from: range.from, to: range.to }),
		[range.from, range.to],
	);

	return (
		<div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
			<Card title="Date range">
				<DateRangePicker value={range} onChange={setRange} />
			</Card>
			<RevenueCard range={rangeQuery} groupBy={groupBy} onGroupByChange={setGroupBy} />
			<MrrCard />
			<TopProductsCard range={rangeQuery} />
			<TopCustomersCard />
		</div>
	);
}

// ────────────────────────────────────────────────────────────────────────────
// Generic async card wrapper
// ────────────────────────────────────────────────────────────────────────────

interface CardState<T> {
	data: T | null;
	error: string | null;
	loading: boolean;
}

function useAsyncFetch<T>(
	api: PluginAPI,
	path: string,
	deps: unknown[],
): CardState<T> & { reload: () => void } {
	const [state, setState] = useState<CardState<T>>({
		data: null,
		error: null,
		loading: true,
	});

	const reload = useCallback(() => {
		setState({ data: null, error: null, loading: true });
		let cancelled = false;
		api
			.get<T>(path)
			.then((data) => {
				if (cancelled) return;
				setState({ data, error: null, loading: false });
			})
			.catch((err) => {
				if (cancelled) return;
				setState({
					data: null,
					error: err instanceof Error ? err.message : String(err),
					loading: false,
				});
			});
		return () => {
			cancelled = true;
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [api, path]);

	useEffect(() => {
		const cleanup = reload();
		return cleanup;
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, deps);

	return { ...state, reload };
}

function ErrorRetry({ error, onRetry }: { error: string; onRetry: () => void }) {
	return (
		<Alert type="error" title="Could not load">
			<div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
				<span>{error}</span>
				<div>
					<Button size="sm" variant="secondary" onClick={onRetry}>
						Retry
					</Button>
				</div>
			</div>
		</Alert>
	);
}

// ────────────────────────────────────────────────────────────────────────────
// Revenue card — with sparkline + CSV export
// ────────────────────────────────────────────────────────────────────────────

function RevenueCard({
	range,
	groupBy,
	onGroupByChange,
}: {
	range: { from: string; to: string };
	groupBy: GroupBy;
	onGroupByChange: (g: GroupBy) => void;
}) {
	const api = usePluginAPI();
	const qs = new URLSearchParams({
		groupBy,
		from: range.from,
		to: range.to,
	}).toString();
	const { data, error, loading, reload } = useAsyncFetch<RevSeries>(
		api,
		`admin/reports/revenue?${qs}`,
		[qs],
	);

	const currencies = useMemo(() => {
		if (!data || !Array.isArray(data.series)) return [] as string[];
		const set = new Set<string>();
		for (const pt of data.series) {
			for (const k of Object.keys(pt.currencies ?? {})) set.add(k);
		}
		return [...set].sort();
	}, [data]);

	const [focusCurrency, setFocusCurrency] = useState<string>("");
	useEffect(() => {
		if (currencies.length > 0 && !focusCurrency) {
			setFocusCurrency(currencies[0] ?? "");
		}
	}, [currencies, focusCurrency]);

	const sparkValues = useMemo(() => {
		if (!data || !focusCurrency || !Array.isArray(data.series)) return [];
		return data.series.map((pt) => pt.currencies?.[focusCurrency] ?? 0);
	}, [data, focusCurrency]);

	function exportCsv(): void {
		if (!data || !Array.isArray(data.series)) return;
		const header = ["bucket", ...currencies];
		const rows = data.series.map((pt) => [
			pt.bucket,
			...currencies.map((c) => ((pt.currencies?.[c] ?? 0) / 100).toFixed(2)),
		]);
		downloadCsv(`revenue-${range.from}-to-${range.to}-${groupBy}.csv`, [
			header,
			...rows,
		]);
	}

	return (
		<Card title="Revenue">
			<div
				style={{
					display: "flex",
					gap: 12,
					alignItems: "flex-end",
					flexWrap: "wrap",
					marginBottom: 12,
				}}
			>
				<Select
					label="Group by"
					value={groupBy}
					options={[
						{ value: "day", label: "Day" },
						{ value: "week", label: "Week" },
						{ value: "month", label: "Month" },
					]}
					onChange={(e) => onGroupByChange(e.currentTarget.value as GroupBy)}
				/>
				{currencies.length > 1 && (
					<Select
						label="Sparkline currency"
						value={focusCurrency}
						options={currencies.map((c) => ({ value: c, label: c }))}
						onChange={(e) => setFocusCurrency(e.currentTarget.value)}
					/>
				)}
				{Array.isArray(data?.series) && data.series.length > 0 && (
					<Button size="sm" variant="secondary" onClick={exportCsv}>
						Export CSV
					</Button>
				)}
			</div>
			{loading ? (
				<Loading />
			) : error ? (
				<ErrorRetry error={error} onRetry={reload} />
			) : !data || !Array.isArray(data.series) || data.series.length === 0 ? (
				<EmptyState
					title="No paid orders in this range"
					description="Widen the date range or wait for fresh orders to show up."
				/>
			) : (
				<>
					{sparkValues.length > 0 && (
						<div style={{ marginBottom: 12 }}>
							<Sparkline values={sparkValues} />
						</div>
					)}
					<Table
						data={data.series}
						getRowKey={(s) => s.bucket}
						columns={[
							{ key: "b", header: "Bucket", render: (s) => s.bucket },
							{
								key: "amt",
								header: "Revenue",
								render: (s) => (
									<div
										style={{
											display: "flex",
											gap: 8,
											flexWrap: "wrap",
										}}
									>
										{Object.entries(s.currencies).map(([cc, amt]) => (
											<MoneyMinor key={cc} amount={amt as number} currency={cc} />
										))}
									</div>
								),
							},
						]}
					/>
				</>
			)}
		</Card>
	);
}

// ────────────────────────────────────────────────────────────────────────────
// MRR card
// ────────────────────────────────────────────────────────────────────────────

function MrrCard() {
	const api = usePluginAPI();
	const { data, error, loading, reload } = useAsyncFetch<Mrr>(
		api,
		"admin/reports/mrr",
		[],
	);
	const entries = data ? Object.entries(data.mrr) : [];
	return (
		<Card title="MRR (active subscriptions)">
			{loading ? (
				<Loading />
			) : error ? (
				<ErrorRetry error={error} onRetry={reload} />
			) : entries.length === 0 ? (
				<EmptyState
					title="No active subscriptions yet"
					description="MRR appears once customers start subscriptions."
				/>
			) : (
				<Table
					data={entries.map(([cc, amt]) => ({ cc, amt: amt as number }))}
					getRowKey={(r) => r.cc}
					columns={[
						{ key: "cc", header: "Currency", render: (r) => r.cc },
						{
							key: "mrr",
							header: "MRR",
							render: (r) => <MoneyMinor amount={r.amt} currency={r.cc} />,
						},
					]}
				/>
			)}
		</Card>
	);
}

// ────────────────────────────────────────────────────────────────────────────
// Top products card — with CSV export
// ────────────────────────────────────────────────────────────────────────────

function TopProductsCard({
	range,
}: {
	range: { from: string; to: string };
}) {
	const api = usePluginAPI();
	const qs = new URLSearchParams({ from: range.from, to: range.to }).toString();
	const { data, error, loading, reload } = useAsyncFetch<{ items: TopProduct[] }>(
		api,
		`admin/reports/top-products?${qs}`,
		[qs],
	);
	const items = data?.items ?? [];
	function exportCsv(): void {
		downloadCsv(`top-products-${range.from}-to-${range.to}.csv`, [
			["productId", "name", "units", "revenue", "currency"],
			...items.map((i) => [
				i.productId,
				i.name,
				String(i.units),
				(i.revenue / 100).toFixed(2),
				i.currency,
			]),
		]);
	}
	return (
		<Card title="Top products">
			<div style={{ marginBottom: 12 }}>
				{items.length > 0 && (
					<Button size="sm" variant="secondary" onClick={exportCsv}>
						Export CSV
					</Button>
				)}
			</div>
			{loading ? (
				<Loading />
			) : error ? (
				<ErrorRetry error={error} onRetry={reload} />
			) : items.length === 0 ? (
				<EmptyState
					title="No products in this range"
					description="Try a wider date range once orders start coming in."
				/>
			) : (
				<Table
					data={items}
					getRowKey={(p) => p.productId}
					columns={[
						{ key: "name", header: "Product", render: (p) => p.name },
						{ key: "units", header: "Units", render: (p) => p.units },
						{
							key: "rev",
							header: "Revenue",
							render: (p) => (
								<MoneyMinor amount={p.revenue} currency={p.currency} />
							),
						},
					]}
				/>
			)}
		</Card>
	);
}

// ────────────────────────────────────────────────────────────────────────────
// Top customers card
// ────────────────────────────────────────────────────────────────────────────

function TopCustomersCard() {
	const api = usePluginAPI();
	const { data, error, loading, reload } = useAsyncFetch<{ items: Customer[] }>(
		api,
		"admin/reports/top-customers",
		[],
	);
	const items = data?.items ?? [];
	function exportCsv(): void {
		const rows = [
			["email", "name", "ordersCount", "lifetime"],
			...items.map((c) => [
				c.email,
				`${c.firstName ?? ""} ${c.lastName ?? ""}`.trim(),
				String(c.ordersCount),
				Object.entries(c.totalSpent ?? {})
					.map(([cc, v]) => `${cc} ${((v as number) / 100).toFixed(2)}`)
					.join(" | "),
			]),
		];
		downloadCsv("top-customers.csv", rows);
	}
	return (
		<Card title="Top customers">
			<div style={{ marginBottom: 12 }}>
				{items.length > 0 && (
					<Button size="sm" variant="secondary" onClick={exportCsv}>
						Export CSV
					</Button>
				)}
			</div>
			{loading ? (
				<Loading />
			) : error ? (
				<ErrorRetry error={error} onRetry={reload} />
			) : items.length === 0 ? (
				<EmptyState title="No customers yet" />
			) : (
				<Table
					data={items}
					getRowKey={(c) => c.id}
					columns={[
						{ key: "email", header: "Email", render: (c) => c.email },
						{
							key: "spent",
							header: "Lifetime",
							render: (c) => (
								<div
									style={{ display: "flex", gap: 8, flexWrap: "wrap" }}
								>
									{Object.entries(c.totalSpent ?? {}).map(([cc, v]) => (
										<MoneyMinor
											key={cc}
											amount={v as number}
											currency={cc}
										/>
									))}
								</div>
							),
						},
						{ key: "count", header: "Orders", render: (c) => c.ordersCount },
					]}
				/>
			)}
		</Card>
	);
}

// ────────────────────────────────────────────────────────────────────────────
// Sparkline
// ────────────────────────────────────────────────────────────────────────────

function Sparkline({
	values,
	width = 320,
	height = 48,
}: {
	values: number[];
	width?: number;
	height?: number;
}): ReactNode {
	if (values.length === 0) return null;
	const max = Math.max(1, ...values);
	const min = Math.min(0, ...values);
	const range = max - min || 1;
	const step = values.length > 1 ? width / (values.length - 1) : 0;
	const points = values
		.map((v, i) => {
			const x = i * step;
			const y = height - ((v - min) / range) * height;
			return `${x.toFixed(1)},${y.toFixed(1)}`;
		})
		.join(" ");
	const areaPoints = `0,${height} ${points} ${(width).toFixed(1)},${height}`;
	return (
		<svg
			viewBox={`0 0 ${width} ${height}`}
			width="100%"
			height={height}
			preserveAspectRatio="none"
			role="img"
			aria-label="Sparkline of revenue over time"
		>
			<polygon points={areaPoints} fill="#dbeafe" />
			<polyline
				points={points}
				fill="none"
				stroke="#2563eb"
				strokeWidth={1.5}
				strokeLinecap="round"
				strokeLinejoin="round"
			/>
		</svg>
	);
}

// ────────────────────────────────────────────────────────────────────────────
// CSV helper
// ────────────────────────────────────────────────────────────────────────────

function escapeCsv(cell: string): string {
	if (/[",\n\r]/.test(cell)) return `"${cell.replace(/"/g, '""')}"`;
	return cell;
}

function downloadCsv(filename: string, rows: string[][]): void {
	const body = rows.map((row) => row.map(escapeCsv).join(",")).join("\r\n");
	const blob = new Blob([body], { type: "text/csv;charset=utf-8;" });
	const url = URL.createObjectURL(blob);
	const a = document.createElement("a");
	a.href = url;
	a.download = filename;
	document.body.appendChild(a);
	a.click();
	document.body.removeChild(a);
	setTimeout(() => URL.revokeObjectURL(url), 1000);
}

