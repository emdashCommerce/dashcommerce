/**
 * Feedback primitives — confirm dialog + toasts.
 *
 * Both are module-level singletons driven by a lightweight observable store
 * so call sites can use them without wiring a React provider. The portal
 * root is created lazily on first use (SSR-safe: falls through silently
 * when `window` is undefined).
 */

import {
	type ReactNode,
	useEffect,
	useState,
	useSyncExternalStore,
} from "react";
import { createPortal } from "react-dom";

// ────────────────────────────────────────────────────────────────────────────
// Confirm dialog
// ────────────────────────────────────────────────────────────────────────────

export interface ConfirmOptions {
	title: string;
	description?: ReactNode;
	confirmLabel?: string;
	cancelLabel?: string;
	destructive?: boolean;
}

interface ConfirmState extends ConfirmOptions {
	id: number;
	resolve: (value: boolean) => void;
}

type ConfirmListener = (state: ConfirmState | null) => void;

const confirmListeners = new Set<ConfirmListener>();
let currentConfirm: ConfirmState | null = null;
let confirmSeq = 0;

function notifyConfirm(): void {
	for (const l of confirmListeners) l(currentConfirm);
}

function subscribeConfirm(l: ConfirmListener): () => void {
	confirmListeners.add(l);
	return () => {
		confirmListeners.delete(l);
	};
}

export function confirm(opts: ConfirmOptions): Promise<boolean> {
	return new Promise((resolve) => {
		confirmSeq += 1;
		currentConfirm = { ...opts, id: confirmSeq, resolve };
		notifyConfirm();
	});
}

export function useConfirm(): (opts: ConfirmOptions) => Promise<boolean> {
	return confirm;
}

function ConfirmDialog() {
	const state = useSyncExternalStore(
		subscribeConfirm,
		() => currentConfirm,
		() => null,
	);
	useEffect(() => {
		if (!state) return;
		function onKey(e: KeyboardEvent): void {
			if (e.key === "Escape") finish(false);
			if (e.key === "Enter") finish(true);
		}
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [state]);

	if (!state) return null;

	function finish(ok: boolean): void {
		if (!currentConfirm) return;
		const r = currentConfirm.resolve;
		currentConfirm = null;
		notifyConfirm();
		r(ok);
	}

	return (
		<div
			role="dialog"
			aria-modal="true"
			aria-labelledby={`dc-confirm-${state.id}-title`}
			style={{
				position: "fixed",
				inset: 0,
				background: "rgba(17, 17, 17, 0.5)",
				display: "flex",
				alignItems: "center",
				justifyContent: "center",
				zIndex: 10000,
				padding: 16,
			}}
			onClick={() => finish(false)}
		>
			<div
				onClick={(e) => e.stopPropagation()}
				style={{
					background: "#fff",
					borderRadius: 8,
					maxWidth: 440,
					width: "100%",
					padding: "20px 24px",
					boxShadow: "0 20px 60px rgba(0,0,0,0.25)",
				}}
			>
				<h2
					id={`dc-confirm-${state.id}-title`}
					style={{ margin: "0 0 8px", fontSize: "1.05rem", fontWeight: 600 }}
				>
					{state.title}
				</h2>
				{state.description && (
					<div style={{ color: "#444", fontSize: "0.95em", lineHeight: 1.4 }}>
						{state.description}
					</div>
				)}
				<div
					style={{
						display: "flex",
						justifyContent: "flex-end",
						gap: 8,
						marginTop: 20,
					}}
				>
					<button
						type="button"
						onClick={() => finish(false)}
						autoFocus
						style={{
							border: "1px solid #d4d4d8",
							background: "#f4f4f5",
							color: "#111",
							padding: "8px 14px",
							borderRadius: 6,
							fontWeight: 500,
							cursor: "pointer",
						}}
					>
						{state.cancelLabel ?? "Cancel"}
					</button>
					<button
						type="button"
						onClick={() => finish(true)}
						style={{
							border: "1px solid",
							borderColor: state.destructive ? "#991b1b" : "#111",
							background: state.destructive ? "#b91c1c" : "#111",
							color: "#fff",
							padding: "8px 14px",
							borderRadius: 6,
							fontWeight: 500,
							cursor: "pointer",
						}}
					>
						{state.confirmLabel ?? (state.destructive ? "Delete" : "Confirm")}
					</button>
				</div>
			</div>
		</div>
	);
}

// ────────────────────────────────────────────────────────────────────────────
// Toasts
// ────────────────────────────────────────────────────────────────────────────

export type ToastKind = "info" | "success" | "warning" | "error";

export interface ToastItem {
	id: number;
	kind: ToastKind;
	title: string;
	description?: ReactNode;
	timeoutMs: number;
}

type ToastListener = (items: ToastItem[]) => void;

const toastListeners = new Set<ToastListener>();
let toasts: ToastItem[] = [];
let toastSeq = 0;

function notifyToasts(): void {
	for (const l of toastListeners) l(toasts);
}

function subscribeToasts(l: ToastListener): () => void {
	toastListeners.add(l);
	return () => {
		toastListeners.delete(l);
	};
}

function pushToast(item: Omit<ToastItem, "id">): number {
	toastSeq += 1;
	const id = toastSeq;
	toasts = [...toasts, { ...item, id }];
	notifyToasts();
	if (item.timeoutMs > 0 && typeof window !== "undefined") {
		window.setTimeout(() => dismissToast(id), item.timeoutMs);
	}
	return id;
}

function dismissToast(id: number): void {
	toasts = toasts.filter((t) => t.id !== id);
	notifyToasts();
}

export interface ToastApi {
	info(title: string, description?: ReactNode): number;
	success(title: string, description?: ReactNode): number;
	warning(title: string, description?: ReactNode): number;
	error(title: string, description?: ReactNode): number;
	dismiss(id: number): void;
}

const defaultTimeout = 4000;
const errorTimeout = 7000;

export const toast: ToastApi = {
	info: (title, description) =>
		pushToast({
			kind: "info",
			title,
			...(description !== undefined ? { description } : {}),
			timeoutMs: defaultTimeout,
		}),
	success: (title, description) =>
		pushToast({
			kind: "success",
			title,
			...(description !== undefined ? { description } : {}),
			timeoutMs: defaultTimeout,
		}),
	warning: (title, description) =>
		pushToast({
			kind: "warning",
			title,
			...(description !== undefined ? { description } : {}),
			timeoutMs: defaultTimeout,
		}),
	error: (title, description) =>
		pushToast({
			kind: "error",
			title,
			...(description !== undefined ? { description } : {}),
			timeoutMs: errorTimeout,
		}),
	dismiss: dismissToast,
};

export function useToast(): ToastApi {
	return toast;
}

const TOAST_COLORS: Record<ToastKind, { bg: string; fg: string; border: string }> = {
	info: { bg: "#eff6ff", fg: "#1e3a8a", border: "#93c5fd" },
	success: { bg: "#f0fdf4", fg: "#14532d", border: "#86efac" },
	warning: { bg: "#fffbeb", fg: "#78350f", border: "#fde68a" },
	error: { bg: "#fef2f2", fg: "#7f1d1d", border: "#fca5a5" },
};

function Toaster() {
	const items = useSyncExternalStore(
		subscribeToasts,
		() => toasts,
		() => [],
	);
	if (items.length === 0) return null;
	return (
		<div
			style={{
				position: "fixed",
				bottom: 20,
				right: 20,
				zIndex: 10001,
				display: "flex",
				flexDirection: "column",
				gap: 8,
				maxWidth: 380,
			}}
		>
			{items.map((t) => {
				const c = TOAST_COLORS[t.kind];
				return (
					<div
						key={t.id}
						role={t.kind === "error" ? "alert" : "status"}
						style={{
							background: c.bg,
							color: c.fg,
							border: `1px solid ${c.border}`,
							borderRadius: 6,
							padding: "10px 14px",
							boxShadow: "0 6px 16px rgba(0,0,0,0.08)",
							fontSize: "0.9em",
							display: "flex",
							flexDirection: "column",
							gap: 4,
						}}
					>
						<div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
							<strong style={{ flex: 1 }}>{t.title}</strong>
							<button
								type="button"
								aria-label="Dismiss"
								onClick={() => dismissToast(t.id)}
								style={{
									border: "none",
									background: "transparent",
									color: c.fg,
									cursor: "pointer",
									fontSize: "1em",
									padding: 0,
									lineHeight: 1,
								}}
							>
								×
							</button>
						</div>
						{t.description && <div>{t.description}</div>}
					</div>
				);
			})}
		</div>
	);
}

// ────────────────────────────────────────────────────────────────────────────
// Host mount — attach once per admin page via <KitPortals/>.
// ────────────────────────────────────────────────────────────────────────────

let portalRoot: HTMLDivElement | null = null;

function ensurePortalRoot(): HTMLDivElement | null {
	if (typeof document === "undefined") return null;
	if (portalRoot && document.body.contains(portalRoot)) return portalRoot;
	portalRoot = document.createElement("div");
	portalRoot.id = "dashcommerce-kit-portal";
	document.body.appendChild(portalRoot);
	return portalRoot;
}

/**
 * Renders the toast + confirm portals. Safe to mount multiple times — a
 * single state machine drives the visible markup. Import and render at the
 * top of every admin page (or wrap pages in a HOC that does so).
 */
export function KitPortals() {
	const [mounted, setMounted] = useState(false);
	useEffect(() => {
		setMounted(true);
	}, []);
	if (!mounted) return null;
	const root = ensurePortalRoot();
	if (!root) return null;
	return createPortal(
		<>
			<Toaster />
			<ConfirmDialog />
		</>,
		root,
	);
}
