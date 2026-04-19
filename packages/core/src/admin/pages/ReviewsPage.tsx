/**
 * Reviews moderation. Supports bulk actions (approve, reject, spam) from
 * the pending queue plus "reverse" from approved/rejected/spam queues so
 * operators can undo a misclick without touching the API directly.
 *
 * List uses `useListControls` for server-side filtering + cursor
 * pagination; filters include product id, rating, verified-only, and
 * date range in addition to the queue (status) selector.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
	Alert,
	Button,
	Card,
	Input,
	Loading,
	Select,
	Table,
	Toggle,
	confirm,
	toast,
	usePluginAPI,
} from "../kit";
import { EmptyState } from "../ui/EmptyState";
import { StatusBadge } from "../ui/StatusBadge";
import type { Review, ReviewStatus } from "../../types";
import { useListControls } from "../hooks/useListControls";

type ModerationTarget = Exclude<ReviewStatus, "pending">;

interface ReviewsFilters {
	queue: ReviewStatus;
	productId: string;
	rating: "" | "1" | "2" | "3" | "4" | "5";
	verifiedOnly: boolean;
	from: string;
	to: string;
}

const QUEUE_OPTIONS: { value: ReviewStatus; label: string }[] = [
	{ value: "pending", label: "Pending" },
	{ value: "approved", label: "Approved" },
	{ value: "rejected", label: "Rejected" },
	{ value: "spam", label: "Spam" },
];

const RATING_OPTIONS: { value: ReviewsFilters["rating"]; label: string }[] = [
	{ value: "", label: "Any rating" },
	{ value: "5", label: "★★★★★" },
	{ value: "4", label: "★★★★" },
	{ value: "3", label: "★★★" },
	{ value: "2", label: "★★" },
	{ value: "1", label: "★" },
];

const INITIAL: ReviewsFilters = {
	queue: "pending",
	productId: "",
	rating: "",
	verifiedOnly: false,
	from: "",
	to: "",
};

export function ReviewsPage() {
	const api = usePluginAPI();
	const [selected, setSelected] = useState<Set<string>>(new Set());
	const [pending, setPending] = useState<Record<string, boolean>>({});
	const [bulkPending, setBulkPending] = useState(false);

	const buildQuery = useMemo(
		() => (f: ReviewsFilters) => ({
			status: f.queue,
			productId: f.productId.trim() || undefined,
			rating: f.rating || undefined,
			verifiedOnly: f.verifiedOnly ? "true" : undefined,
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
	} = useListControls<ReviewsFilters, Review>({
		api,
		endpoint: "admin/reviews",
		initialFilters: INITIAL,
		buildQuery,
		limit: 50,
	});

	// Clear selection whenever the filtered set changes shape.
	const itemIds = useMemo(() => items.map((r) => r.id).join("|"), [items]);
	useEffect(() => {
		setSelected(new Set());
	}, [itemIds]);

	const moderate = useCallback(
		async (id: string, next: ReviewStatus): Promise<void> => {
			setPending((p) => ({ ...p, [id]: true }));
			try {
				await api.post(
					`admin/reviews/moderate?id=${encodeURIComponent(id)}`,
					{ status: next },
				);
				toast.success(`Review marked ${next}`);
				await reload();
			} catch (err) {
				toast.error(
					"Moderation failed",
					err instanceof Error ? err.message : undefined,
				);
			} finally {
				setPending((p) => {
					const n = { ...p };
					delete n[id];
					return n;
				});
			}
		},
		[api, reload],
	);

	const bulkModerate = useCallback(
		async (next: ReviewStatus): Promise<void> => {
			const ids = [...selected];
			if (ids.length === 0) return;
			const needsConfirm = next === "spam" || next === "rejected";
			if (needsConfirm) {
				const ok = await confirm({
					title: `Mark ${ids.length} review${ids.length === 1 ? "" : "s"} as ${next}?`,
					description:
						next === "spam"
							? "Spam reviews are hidden from product pages and the author's IP is flagged."
							: "Rejected reviews are hidden and don't contribute to the product's rating.",
					confirmLabel: `Mark ${next}`,
					destructive: true,
				});
				if (!ok) return;
			}
			setBulkPending(true);
			try {
				const results = await Promise.allSettled(
					ids.map((id) =>
						api.post(
							`admin/reviews/moderate?id=${encodeURIComponent(id)}`,
							{ status: next },
						),
					),
				);
				const failed = results.filter((r) => r.status === "rejected").length;
				if (failed === 0) {
					toast.success(
						`Updated ${ids.length} review${ids.length === 1 ? "" : "s"}`,
					);
				} else {
					toast.warning(
						"Some moderations failed",
						`${results.length - failed} succeeded, ${failed} failed.`,
					);
				}
				await reload();
			} finally {
				setBulkPending(false);
			}
		},
		[api, reload, selected],
	);

	const allOnPage = useMemo(() => items.map((r) => r.id), [items]);
	const allSelected =
		allOnPage.length > 0 && allOnPage.every((id) => selected.has(id));

	const activeFilters = [
		filters.productId.trim(),
		filters.rating,
		filters.verifiedOnly ? "verifiedOnly" : "",
		filters.from,
		filters.to,
	].filter((v) => v !== "").length;

	return (
		<Card title="Reviews">
			<div
				style={{
					display: "grid",
					gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
					gap: 12,
					marginBottom: 12,
				}}
			>
				<Select
					label="Queue"
					value={filters.queue}
					options={QUEUE_OPTIONS}
					onChange={(e) =>
						setFilter("queue", e.currentTarget.value as ReviewStatus)
					}
				/>
				<Input
					label="Product id"
					value={filters.productId}
					onChange={(e) => setFilter("productId", e.currentTarget.value)}
					placeholder="ULID or slug"
				/>
				<Select
					label="Rating"
					value={filters.rating}
					options={RATING_OPTIONS}
					onChange={(e) =>
						setFilter(
							"rating",
							e.currentTarget.value as ReviewsFilters["rating"],
						)
					}
				/>
				<Input
					label="From"
					type="date"
					value={filters.from}
					onChange={(e) => setFilter("from", e.currentTarget.value)}
				/>
				<Input
					label="To"
					type="date"
					value={filters.to}
					onChange={(e) => setFilter("to", e.currentTarget.value)}
				/>
				<div style={{ alignSelf: "flex-end" }}>
					<Toggle
						label="Verified purchases only"
						checked={filters.verifiedOnly}
						onChange={(v) => setFilter("verifiedOnly", v)}
					/>
				</div>
			</div>

			{(activeFilters > 0 || selected.size > 0) && (
				<div
					style={{
						display: "flex",
						gap: 8,
						alignItems: "center",
						marginBottom: 12,
						flexWrap: "wrap",
					}}
				>
					{activeFilters > 0 && (
						<>
							<span style={{ color: "#6b7280", fontSize: 13 }}>
								{activeFilters} filter{activeFilters === 1 ? "" : "s"} applied
							</span>
							<Button size="sm" variant="secondary" onClick={resetFilters}>
								Clear filters
							</Button>
						</>
					)}
					{selected.size > 0 && (
						<div style={{ display: "flex", gap: 8, alignItems: "center" }}>
							<span style={{ color: "#555", fontSize: "0.9em" }}>
								{selected.size} selected
							</span>
							{filters.queue === "pending" ? (
								<>
									<Button
										size="sm"
										variant="primary"
										disabled={bulkPending}
										onClick={() => bulkModerate("approved")}
									>
										Approve
									</Button>
									<Button
										size="sm"
										disabled={bulkPending}
										onClick={() => bulkModerate("rejected")}
									>
										Reject
									</Button>
									<Button
										size="sm"
										variant="danger"
										disabled={bulkPending}
										onClick={() => bulkModerate("spam")}
									>
										Mark as spam
									</Button>
								</>
							) : (
								<Button
									size="sm"
									variant="secondary"
									disabled={bulkPending}
									onClick={() => bulkModerate("pending")}
								>
									Return to pending
								</Button>
							)}
						</div>
					)}
				</div>
			)}

			{error && (
				<Alert type="error" title="Could not load reviews">
					{error}
				</Alert>
			)}

			{items.length === 0 && !loading ? (
				<EmptyState
					title={`No ${filters.queue} reviews`}
					description={
						filters.queue === "pending"
							? "New reviews will appear here for moderation."
							: "Check other queues or come back later."
					}
				/>
			) : (
				<>
					<Table<Review>
						data={items}
						getRowKey={(r) => r.id}
						columns={[
							{
								key: "select",
								header: (
									<input
										type="checkbox"
										aria-label="Select all"
										checked={allSelected}
										onChange={(e) => {
											if (e.currentTarget.checked) {
												setSelected(new Set(allOnPage));
											} else {
												setSelected(new Set());
											}
										}}
									/>
								),
								render: (r) => (
									<input
										type="checkbox"
										aria-label={`Select review ${r.id}`}
										checked={selected.has(r.id)}
										onChange={(e) => {
											setSelected((prev) => {
												const next = new Set(prev);
												if (e.currentTarget.checked) next.add(r.id);
												else next.delete(r.id);
												return next;
											});
										}}
									/>
								),
								width: 40,
							},
							{
								key: "stars",
								header: "Rating",
								render: (r) => "★".repeat(r.rating) + "☆".repeat(5 - r.rating),
							},
							{
								key: "who",
								header: "Reviewer",
								render: (r) => (
									<div>
										<div>{r.customerName}</div>
										<div style={{ color: "#666", fontSize: "0.85em" }}>
											{r.customerEmail ?? "—"}
										</div>
									</div>
								),
							},
							{
								key: "body",
								header: "Review",
								render: (r) => (
									<div>
										{r.title && <strong>{r.title}: </strong>}
										{r.body.slice(0, 180)}
										{r.body.length > 180 ? "…" : ""}
									</div>
								),
							},
							{
								key: "verified",
								header: "Verified",
								render: (r) => (r.verifiedPurchase ? "✓" : "—"),
							},
							{
								key: "status",
								header: "Status",
								render: (r) => <StatusBadge status={r.status} />,
							},
							{
								key: "act",
								header: "",
								render: (r) =>
									r.status === "pending" ? (
										<div
											style={{ display: "flex", gap: 4, flexWrap: "wrap" }}
										>
											<Button
												variant="primary"
												size="sm"
												disabled={!!pending[r.id]}
												onClick={() => moderate(r.id, "approved")}
											>
												Approve
											</Button>
											<Button
												size="sm"
												disabled={!!pending[r.id]}
												onClick={async () => {
													const ok = await confirm({
														title: "Reject this review?",
														description:
															"Rejected reviews stay in your records but aren't shown to shoppers.",
														confirmLabel: "Reject",
														destructive: true,
													});
													if (!ok) return;
													moderate(r.id, "rejected");
												}}
											>
												Reject
											</Button>
											<Button
												variant="danger"
												size="sm"
												disabled={!!pending[r.id]}
												onClick={async () => {
													const ok = await confirm({
														title: "Mark as spam?",
														description:
															"The author's IP is flagged to help future moderation.",
														confirmLabel: "Mark as spam",
														destructive: true,
													});
													if (!ok) return;
													moderate(r.id, "spam");
												}}
											>
												Spam
											</Button>
										</div>
									) : (
										<Button
											size="sm"
											variant="secondary"
											disabled={!!pending[r.id]}
											onClick={() => moderate(r.id, "pending")}
										>
											Return to pending
										</Button>
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
								End of results — {items.length} reviews
							</span>
						) : null}
					</div>
				</>
			)}
		</Card>
	);
}

