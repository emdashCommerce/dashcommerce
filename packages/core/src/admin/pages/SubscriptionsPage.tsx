/**
 * Subscriptions admin — list with filters + pagination via
 * `useListControls`, plus cancel/pause/resume with confirm dialogs,
 * per-row pending states, and toast feedback.
 *
 * Stripe is the source of truth for subscription state, so we deliberately
 * avoid optimistic updates: after every action we reload the list so the
 * row reflects whatever webhook response came back.
 */

import { useCallback, useMemo, useState } from "react";
import {
	Alert,
	Button,
	Card,
	Input,
	Loading,
	Select,
	Table,
	confirm,
	toast,
	usePluginAPI,
} from "../kit";
import { MoneyDisplay } from "../ui/MoneyDisplay";
import { StatusBadge } from "../ui/StatusBadge";
import { EmptyState } from "../ui/EmptyState";
import type { Subscription, SubscriptionStatus } from "../../types";
import { useListControls } from "../hooks/useListControls";

type Action = "cancel-eop" | "cancel-now" | "pause" | "resume";

interface SubscriptionsFilters {
	status: SubscriptionStatus | "";
	email: string;
	productId: string;
	from: string;
	to: string;
}

const STATUS_FILTERS: {
	value: SubscriptionsFilters["status"];
	label: string;
}[] = [
	{ value: "", label: "Any status" },
	{ value: "active", label: "Active" },
	{ value: "trialing", label: "Trialing" },
	{ value: "past_due", label: "Past due" },
	{ value: "paused", label: "Paused" },
	{ value: "canceled", label: "Canceled" },
	{ value: "unpaid", label: "Unpaid" },
];

const INITIAL: SubscriptionsFilters = {
	status: "",
	email: "",
	productId: "",
	from: "",
	to: "",
};

function isCancellable(sub: Subscription): boolean {
	const cancelled: SubscriptionStatus[] = ["canceled", "incomplete_expired"];
	return !cancelled.includes(sub.status) && !sub.cancelAtPeriodEnd;
}

function isPausable(sub: Subscription): boolean {
	return sub.status === "active" || sub.status === "trialing";
}

function isResumable(sub: Subscription): boolean {
	return sub.status === "paused";
}

export function SubscriptionsPage() {
	const api = usePluginAPI();
	const [pending, setPending] = useState<{ id: string; action: Action } | null>(
		null,
	);

	const buildQuery = useMemo(
		() => (f: SubscriptionsFilters) => ({
			status: f.status || undefined,
			email: f.email.trim() || undefined,
			productId: f.productId.trim() || undefined,
			from: f.from || undefined,
			to: f.to || undefined,
		}),
		[],
	);

	const {
		filters,
		setFilter,
		resetFilters,
		items,
		loading,
		error,
		hasMore,
		loadMore,
		reload,
	} = useListControls<SubscriptionsFilters, Subscription>({
		api,
		endpoint: "admin/subscriptions",
		initialFilters: INITIAL,
		buildQuery,
		limit: 50,
	});

	const act = useCallback(
		async (sub: Subscription, action: Action): Promise<void> => {
			if (pending) return;
			if (action === "cancel-now" || action === "cancel-eop") {
				const immediate = action === "cancel-now";
				const ok = await confirm({
					title: immediate ? "Cancel subscription now?" : "Cancel at period end?",
					description: immediate
						? "The customer loses access immediately. Any remaining time in the current period is not refunded automatically."
						: `Access continues until ${new Date(sub.currentPeriodEnd).toLocaleDateString()}, then Stripe will cancel the subscription.`,
					confirmLabel: immediate ? "Cancel now" : "Cancel at period end",
					destructive: true,
				});
				if (!ok) return;
			}
			if (action === "pause") {
				const ok = await confirm({
					title: "Pause subscription?",
					description:
						"Stripe stops generating invoices until the subscription is resumed. The customer keeps their record but won't be billed.",
					confirmLabel: "Pause",
				});
				if (!ok) return;
			}
			setPending({ id: sub.id, action });
			try {
				const actionBase = `admin/subscriptions/action?id=${encodeURIComponent(sub.id)}`;
				if (action === "cancel-eop") {
					await api.post(`${actionBase}&action=cancel`, {
						mode: "at_period_end",
					});
					toast.success("Cancelling at period end");
				} else if (action === "cancel-now") {
					await api.post(`${actionBase}&action=cancel`, {
						mode: "immediate",
					});
					toast.success("Subscription cancelled");
				} else if (action === "pause") {
					await api.post(`${actionBase}&action=pause`, {});
					toast.success("Subscription paused");
				} else if (action === "resume") {
					await api.post(`${actionBase}&action=resume`, {});
					toast.success("Subscription resumed");
				}
				await reload();
			} catch (err) {
				toast.error(
					"Action failed",
					err instanceof Error ? err.message : String(err),
				);
			} finally {
				setPending(null);
			}
		},
		[api, pending, reload],
	);

	const activeFilters = [
		filters.status,
		filters.email.trim(),
		filters.productId.trim(),
		filters.from,
		filters.to,
	].filter((v) => v !== "" && v !== undefined).length;

	return (
		<Card title="Subscriptions">
			<div
				style={{
					display: "grid",
					gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
					gap: 12,
					marginBottom: 12,
				}}
			>
				<Select
					label="Status"
					value={filters.status}
					options={STATUS_FILTERS}
					onChange={(e) =>
						setFilter(
							"status",
							e.currentTarget.value as SubscriptionStatus | "",
						)
					}
				/>
				<Input
					label="Customer email"
					value={filters.email}
					onChange={(e) => setFilter("email", e.currentTarget.value)}
					placeholder="e.g. alice@"
				/>
				<Input
					label="Product id"
					value={filters.productId}
					onChange={(e) => setFilter("productId", e.currentTarget.value)}
					placeholder="ULID or slug"
				/>
				<Input
					label="Created from"
					type="date"
					value={filters.from}
					onChange={(e) => setFilter("from", e.currentTarget.value)}
				/>
				<Input
					label="Created to"
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
				<Alert type="error" title="Could not load subscriptions">
					{error}
				</Alert>
			)}

			{items.length === 0 && !loading ? (
				<EmptyState
					title={
						activeFilters > 0 ? "No subscriptions match" : "No subscriptions yet"
					}
					description={
						activeFilters > 0
							? "Try widening your filters."
							: "Once a customer checks out with a subscription product, it will show up here."
					}
				/>
			) : (
				<>
					<Table<Subscription>
						data={items}
						getRowKey={(s) => s.id}
						columns={[
							{
								key: "status",
								header: "Status",
								render: (s) => (
									<div
										style={{
											display: "flex",
											flexDirection: "column",
											gap: 4,
										}}
									>
										<StatusBadge status={s.status} />
										{s.cancelAtPeriodEnd && (
											<span style={{ fontSize: 12, color: "#a16207" }}>
												Cancels at period end
											</span>
										)}
									</div>
								),
							},
							{
								key: "amt",
								header: "Amount",
								render: (s) => (
									<>
										<MoneyDisplay value={s.unitAmount} />
										<span style={{ color: "#6b7280" }}>
											{" "}
											/ {s.intervalCount > 1 ? `${s.intervalCount} ` : ""}
											{s.interval}
											{s.quantity > 1 ? ` × ${s.quantity}` : ""}
										</span>
									</>
								),
							},
							{
								key: "period",
								header: "Current period",
								render: (s) =>
									`${new Date(s.currentPeriodStart).toLocaleDateString()} → ${new Date(
										s.currentPeriodEnd,
									).toLocaleDateString()}`,
							},
							{
								key: "act",
								header: "",
								render: (s) => (
									<SubscriptionActions
										sub={s}
										pending={pending}
										onAct={(a) => act(s, a)}
									/>
								),
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
								End of results — {items.length} subscriptions
							</span>
						) : null}
					</div>
				</>
			)}
		</Card>
	);
}

function SubscriptionActions({
	sub,
	pending,
	onAct,
}: {
	sub: Subscription;
	pending: { id: string; action: Action } | null;
	onAct: (action: Action) => void;
}) {
	const isPendingHere = pending?.id === sub.id;
	const label = (action: Action, fallback: string): string => {
		if (isPendingHere && pending?.action === action) return "Working…";
		return fallback;
	};

	return (
		<div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
			{isResumable(sub) && (
				<Button
					size="sm"
					variant="primary"
					disabled={isPendingHere}
					onClick={() => onAct("resume")}
				>
					{label("resume", "Resume")}
				</Button>
			)}
			{isPausable(sub) && (
				<Button
					size="sm"
					variant="secondary"
					disabled={isPendingHere}
					onClick={() => onAct("pause")}
				>
					{label("pause", "Pause")}
				</Button>
			)}
			{isCancellable(sub) && (
				<>
					<Button
						size="sm"
						variant="secondary"
						disabled={isPendingHere}
						onClick={() => onAct("cancel-eop")}
					>
						{label("cancel-eop", "Cancel at period end")}
					</Button>
					<Button
						size="sm"
						variant="danger"
						disabled={isPendingHere}
						onClick={() => onAct("cancel-now")}
					>
						{label("cancel-now", "Cancel now")}
					</Button>
				</>
			)}
		</div>
	);
}
