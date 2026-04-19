/**
 * Customers list — debounced search + filters + cursor pagination via
 * `useListControls`. Typing into the search box cancels in-flight
 * requests so only the latest query ever populates the table.
 */

import { useEffect, useMemo, useState } from "react";
import {
	Alert,
	Button,
	Card,
	Input,
	Loading,
	Select,
	Table,
	usePluginAPI,
} from "../kit";
import { EmptyState } from "../ui/EmptyState";
import type { Customer } from "../../types";
import { useListControls } from "../hooks/useListControls";
import { CustomerDetailPage } from "./CustomerDetailPage";

// Emdash's admin shell only mounts pages by exact path match, so parametric
// keys like `/customers/:id` never resolve. We route the detail view via
// a hash fragment (`#/customers/<id>`) over the list instead.
function customerIdFromHash(): string | null {
	const match = window.location.hash.match(/customers\/([^/?]+)/);
	return match?.[1] ?? null;
}

interface CustomersFilters {
	search: string;
	guest: "" | "true" | "false";
	from: string;
	to: string;
}

const GUEST_OPTIONS: { value: CustomersFilters["guest"]; label: string }[] = [
	{ value: "", label: "All customers" },
	{ value: "false", label: "Registered only" },
	{ value: "true", label: "Guest only" },
];

const INITIAL: CustomersFilters = { search: "", guest: "", from: "", to: "" };

export function CustomersPage() {
	const [detailId, setDetailId] = useState<string | null>(() =>
		customerIdFromHash(),
	);

	useEffect(() => {
		const onHash = () => setDetailId(customerIdFromHash());
		window.addEventListener("hashchange", onHash);
		return () => window.removeEventListener("hashchange", onHash);
	}, []);

	return detailId ? <CustomerDetailPage /> : <CustomersList />;
}

function CustomersList() {
	const api = usePluginAPI();

	const buildQuery = useMemo(
		() => (f: CustomersFilters) => ({
			search: f.search.trim() || undefined,
			guest: f.guest || undefined,
			from: f.from || undefined,
			to: f.to || undefined,
		}),
		[],
	);

	const { filters, setFilter, resetFilters, items, loading, error, hasMore, loadMore } =
		useListControls<CustomersFilters, Customer>({
			api,
			endpoint: "admin/customers",
			initialFilters: INITIAL,
			buildQuery,
			limit: 50,
		});

	const activeFilters = [
		filters.search.trim(),
		filters.guest,
		filters.from,
		filters.to,
	].filter((v) => v !== "" && v !== undefined).length;

	return (
		<Card title="Customers">
			<div
				style={{
					display: "grid",
					gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
					gap: 12,
					marginBottom: 12,
				}}
			>
				<Input
					label="Search"
					placeholder="Email or name"
					value={filters.search}
					onChange={(e) => setFilter("search", e.currentTarget.value)}
				/>
				<Select
					label="Account"
					value={filters.guest}
					options={GUEST_OPTIONS}
					onChange={(e) =>
						setFilter(
							"guest",
							e.currentTarget.value as CustomersFilters["guest"],
						)
					}
				/>
				<Input
					label="Joined from"
					type="date"
					value={filters.from}
					onChange={(e) => setFilter("from", e.currentTarget.value)}
				/>
				<Input
					label="Joined to"
					type="date"
					value={filters.to}
					onChange={(e) => setFilter("to", e.currentTarget.value)}
				/>
			</div>

			{activeFilters > 0 && (
				<div
					style={{
						display: "flex",
						gap: 8,
						alignItems: "center",
						marginBottom: 12,
					}}
				>
					<span style={{ color: "#6b7280", fontSize: 13 }}>
						{activeFilters} filter{activeFilters === 1 ? "" : "s"} applied
					</span>
					<Button size="sm" variant="secondary" onClick={resetFilters}>
						Clear
					</Button>
				</div>
			)}

			{error && (
				<Alert type="error" title="Could not load customers">
					{error}
				</Alert>
			)}

			{items.length === 0 && !loading ? (
				<EmptyState
					title={
						activeFilters > 0 ? "No customers match" : "No customers yet"
					}
					description={
						activeFilters > 0
							? "Try widening your filters."
							: "Customers appear here after their first order or signup."
					}
				/>
			) : (
				<>
					<Table<Customer>
						data={items}
						getRowKey={(c) => c.id}
						onRowClick={(c) => {
							window.location.hash = `/customers/${c.id}`;
						}}
						columns={[
							{ key: "email", header: "Email", render: (c) => c.email },
							{
								key: "name",
								header: "Name",
								render: (c) =>
									`${c.firstName ?? ""} ${c.lastName ?? ""}`.trim() || "—",
							},
							{
								key: "acc",
								header: "Account",
								render: (c) => (c.userId ? "Registered" : "Guest"),
							},
							{ key: "orders", header: "Orders", render: (c) => c.ordersCount },
							{
								key: "created",
								header: "Joined",
								render: (c) => new Date(c.createdAt).toLocaleDateString(),
							},
						]}
					/>
					<div
						style={{
							display: "flex",
							justifyContent: "center",
							padding: 12,
						}}
					>
						{loading ? (
							<Loading label="Loading…" />
						) : hasMore ? (
							<Button variant="secondary" onClick={loadMore}>
								Load more
							</Button>
						) : items.length > 0 ? (
							<span style={{ color: "#6b7280", fontSize: 13 }}>
								End of results — {items.length} customers
							</span>
						) : null}
					</div>
				</>
			)}
		</Card>
	);
}
