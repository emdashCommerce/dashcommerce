/**
 * `useListControls` — shared behaviour for admin list pages.
 *
 * Responsibilities:
 *   - Hold a typed filter object and expose per-field setters.
 *   - Debounce fetches (300ms) so typing into a search box doesn't spam
 *     the server; cancel in-flight requests with an `AbortController`
 *     when filters change so we never apply a stale response.
 *   - Track server-side cursor pagination: `loadMore` appends the next
 *     page; any filter change drops the cursor and starts fresh.
 *   - Sync filters to `location.search` via `history.replaceState` so a
 *     refresh preserves state but the admin shell's hash-based routing
 *     is left untouched. Optional — callers can opt out.
 *
 * The hook is intentionally UI-framework agnostic about the filter
 * shape: callers pass `buildQuery` to translate their filter state into
 * the flat string map that admin routes expect. That keeps the URL
 * representation declarative (one entry per public query param) while
 * still letting filter state be strongly typed in React.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PluginAPI } from "../kit";

type Primitive = string | number | boolean | undefined | null;

export type QueryRecord = Record<string, Primitive>;

export interface ListControlsOptions<F, T> {
	api: PluginAPI;
	endpoint: string;
	initialFilters: F;
	/**
	 * Convert typed filter state into the flat string map posted to the
	 * server. Return `undefined` for any filter that should be omitted
	 * entirely (the hook drops empty/null/undefined automatically too).
	 */
	buildQuery: (filters: F) => QueryRecord;
	limit?: number;
	debounceMs?: number;
	/**
	 * Identifier used to namespace the URL-synced filter state. When
	 * unset the hook skips URL sync — useful when the page is mounted
	 * inside a host that already owns the querystring.
	 */
	urlKey?: string;
	/**
	 * Optional parser: given the value of the `urlKey` querystring, hydrate
	 * back into filter shape. Paired with `serializeFilters` below.
	 */
	parseFilters?: (raw: string) => Partial<F> | null;
	serializeFilters?: (filters: F) => string | null;
}

export interface ListControlsState<F, T> {
	filters: F;
	setFilter: <K extends keyof F>(key: K, value: F[K]) => void;
	setFilters: (next: Partial<F>) => void;
	resetFilters: () => void;

	items: T[];
	loading: boolean;
	error: string | null;
	hasMore: boolean;
	cursor: string | null;

	reload: () => Promise<void>;
	loadMore: () => Promise<void>;
}

export interface PaginatedListResponse<T> {
	items?: T[];
	cursor?: string | null;
	hasMore?: boolean;
}

function queryString(params: QueryRecord): string {
	const usp = new URLSearchParams();
	for (const [key, raw] of Object.entries(params)) {
		if (raw === undefined || raw === null || raw === "") continue;
		usp.set(key, String(raw));
	}
	const s = usp.toString();
	return s ? `?${s}` : "";
}

function syncUrl(key: string, value: string | null): void {
	if (typeof window === "undefined") return;
	try {
		const url = new URL(window.location.href);
		if (value && value.length > 0) {
			url.searchParams.set(key, value);
		} else {
			url.searchParams.delete(key);
		}
		window.history.replaceState(window.history.state, "", url.toString());
	} catch {
		// History API unavailable (e.g. sandboxed iframe) — ignore.
	}
}

function readUrl(key: string): string | null {
	if (typeof window === "undefined") return null;
	try {
		return new URL(window.location.href).searchParams.get(key);
	} catch {
		return null;
	}
}

export function useListControls<F extends object, T>(
	opts: ListControlsOptions<F, T>,
): ListControlsState<F, T> {
	const {
		api,
		endpoint,
		initialFilters,
		buildQuery,
		limit = 50,
		debounceMs = 300,
		urlKey,
		parseFilters,
		serializeFilters,
	} = opts;

	const initialHydrated = useMemo<F>(() => {
		if (!urlKey || !parseFilters) return initialFilters;
		const raw = readUrl(urlKey);
		if (!raw) return initialFilters;
		const parsed = parseFilters(raw);
		if (!parsed) return initialFilters;
		return { ...initialFilters, ...parsed };
		// Hydrate once on mount.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	const [filters, setFiltersState] = useState<F>(initialHydrated);
	const [items, setItems] = useState<T[]>([]);
	const [cursor, setCursor] = useState<string | null>(null);
	const [hasMore, setHasMore] = useState(false);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	const abortRef = useRef<AbortController | null>(null);
	const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const epochRef = useRef(0);

	const filtersRef = useRef(filters);
	filtersRef.current = filters;

	const fetchPage = useCallback(
		async (pageCursor: string | null, append: boolean): Promise<void> => {
			abortRef.current?.abort();
			const controller = new AbortController();
			abortRef.current = controller;

			const epoch = ++epochRef.current;
			setLoading(true);
			setError(null);
			try {
				const params: QueryRecord = {
					...buildQuery(filtersRef.current),
					limit,
				};
				if (pageCursor) params.cursor = pageCursor;
			const qs = queryString(params);
			const res = await api.get<PaginatedListResponse<T>>(
				`${endpoint}${qs}`,
				undefined,
				{ signal: controller.signal },
			);
				if (epoch !== epochRef.current) return; // stale
				const nextItems = res.items ?? [];
				setItems((prev) => (append ? [...prev, ...nextItems] : nextItems));
				setCursor(res.cursor ?? null);
				setHasMore(Boolean(res.hasMore));
			} catch (err) {
				if (controller.signal.aborted) return;
				if (epoch !== epochRef.current) return;
				setError(err instanceof Error ? err.message : String(err));
				if (!append) setItems([]);
			} finally {
				if (epoch === epochRef.current) setLoading(false);
			}
		},
		[api, endpoint, buildQuery, limit],
	);

	// Debounced refetch whenever filters change.
	useEffect(() => {
		if (debounceRef.current) clearTimeout(debounceRef.current);
		debounceRef.current = setTimeout(() => {
			void fetchPage(null, false);
		}, debounceMs);
		return () => {
			if (debounceRef.current) clearTimeout(debounceRef.current);
		};
	}, [filters, debounceMs, fetchPage]);

	// URL sync.
	useEffect(() => {
		if (!urlKey || !serializeFilters) return;
		syncUrl(urlKey, serializeFilters(filters));
	}, [filters, urlKey, serializeFilters]);

	// Cancel any in-flight request on unmount.
	useEffect(() => {
		return () => {
			abortRef.current?.abort();
			if (debounceRef.current) clearTimeout(debounceRef.current);
		};
	}, []);

	const setFilter = useCallback(
		<K extends keyof F>(key: K, value: F[K]): void => {
			setFiltersState((prev) => ({ ...prev, [key]: value }));
		},
		[],
	);

	const setFilters = useCallback((next: Partial<F>): void => {
		setFiltersState((prev) => ({ ...prev, ...next }));
	}, []);

	const resetFilters = useCallback((): void => {
		setFiltersState(initialFilters);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	const reload = useCallback(async (): Promise<void> => {
		await fetchPage(null, false);
	}, [fetchPage]);

	const loadMore = useCallback(async (): Promise<void> => {
		if (!cursor || loading) return;
		await fetchPage(cursor, true);
	}, [cursor, loading, fetchPage]);

	return {
		filters,
		setFilter,
		setFilters,
		resetFilters,
		items,
		loading,
		error,
		hasMore,
		cursor,
		reload,
		loadMore,
	};
}
