/**
 * Admin UI kit: primitives (Card, Button, Input, Select, Toggle,
 * Table, Loading, Alert) + a typed `usePluginAPI()` client.
 *
 * Every admin page + widget in this plugin imports from here. The kit
 * is deliberately small — inline styles, no external dep beyond
 * `@emdash-cms/admin` for `apiFetch` + `API_BASE`. If the host ever
 * ships a richer primitive library, we can swap callers in one pass.
 *
 * Keep this file free of plugin-specific logic.
 */

import {
	type ButtonHTMLAttributes,
	type CSSProperties,
	type InputHTMLAttributes,
	type ReactNode,
	type SelectHTMLAttributes,
	type ChangeEvent,
	type KeyboardEvent,
	useEffect,
	useId,
	useMemo,
	useRef,
	useState,
} from "react";
import { apiFetch, API_BASE, throwResponseError } from "@emdash-cms/admin";
export {
	confirm,
	toast,
	useToast,
	useConfirm,
	KitPortals,
	type ConfirmOptions,
	type ToastApi,
	type ToastKind,
} from "./kit-feedback";
import {
	CURRENCY_TABLE,
	getCurrencyInfo,
	type CurrencyInfo,
} from "../data/currencies";

export { getCurrencyInfo } from "../data/currencies";
import { COUNTRY_TABLE, type CountryInfo } from "../data/countries";
import { format as formatMoney, type Money as MoneyValue } from "../money";

// ────────────────────────────────────────────────────────────────────────────
// API client
// ────────────────────────────────────────────────────────────────────────────

/**
 * Plugin id owning this admin bundle. Exposed as a module-level constant
 * rather than a hook because every page in this plugin is hardwired to
 * the same id — no need for contextual resolution.
 */
const PLUGIN_ID = "dashcommerce";

function pluginRoute(path: string): string {
	// `path` may include a leading slash, a leading "admin/", or neither.
	// Normalize to a single "/plugins/<id>/<path>" form.
	const trimmed = path.replace(/^\/+/, "");
	return `${API_BASE}/plugins/${PLUGIN_ID}/${trimmed}`;
}

/**
 * Unwrap JSON from plugin routes. EmDash's `apiSuccess()` wraps payloads as
 * `{ data: T }`, but handlers that return a raw `Response` (DashCommerce
 * admin routes) serialize the body directly — no `data` envelope. Support
 * both so `parseApiResponse` and passthrough responses work.
 */
async function parse<T>(res: Response): Promise<T> {
	if (!res.ok) {
		await throwResponseError(res, `Request failed with ${res.status}`);
	}
	const body = (await res.json()) as Record<string, unknown> | null;
	if (
		body &&
		typeof body === "object" &&
		"data" in body &&
		body.data !== undefined
	) {
		return body.data as T;
	}
	return body as T;
}

export interface PluginAPI {
	get<T = unknown>(
		path: string,
		params?: Record<string, unknown>,
		init?: { signal?: AbortSignal },
	): Promise<T>;
	post<T = unknown>(
		path: string,
		body?: unknown,
		init?: { signal?: AbortSignal },
	): Promise<T>;
	patch<T = unknown>(
		path: string,
		body?: unknown,
		init?: { signal?: AbortSignal },
	): Promise<T>;
	delete<T = unknown>(
		path: string,
		init?: { signal?: AbortSignal },
	): Promise<T>;
}

function withQuery(path: string, params?: Record<string, unknown>): string {
	if (!params || Object.keys(params).length === 0) return path;
	// If `path` already carries query string, append with `&`; otherwise `?`.
	const hasQ = path.includes("?");
	const qs = new URLSearchParams();
	for (const [k, v] of Object.entries(params)) {
		if (v === undefined || v === null) continue;
		qs.append(k, String(v));
	}
	return `${path}${hasQ ? "&" : "?"}${qs.toString()}`;
}

const api: PluginAPI = {
	async get<T>(
		path: string,
		params?: Record<string, unknown>,
		init?: { signal?: AbortSignal },
	): Promise<T> {
		const url = withQuery(pluginRoute(path), params);
		return parse<T>(
			await apiFetch(url, init?.signal ? { signal: init.signal } : undefined),
		);
	},
	async post<T>(
		path: string,
		body?: unknown,
		init?: { signal?: AbortSignal },
	): Promise<T> {
		return parse<T>(
			await apiFetch(pluginRoute(path), {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: body === undefined ? "{}" : JSON.stringify(body),
				...(init?.signal ? { signal: init.signal } : {}),
			}),
		);
	},
	async patch<T>(
		path: string,
		body?: unknown,
		init?: { signal?: AbortSignal },
	): Promise<T> {
		return parse<T>(
			await apiFetch(pluginRoute(path), {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: body === undefined ? "{}" : JSON.stringify(body),
				...(init?.signal ? { signal: init.signal } : {}),
			}),
		);
	},
	async delete<T>(
		path: string,
		init?: { signal?: AbortSignal },
	): Promise<T> {
		return parse<T>(
			await apiFetch(pluginRoute(path), {
				method: "DELETE",
				...(init?.signal ? { signal: init.signal } : {}),
			}),
		);
	},
};

export function usePluginAPI(): PluginAPI {
	return api;
}

// ────────────────────────────────────────────────────────────────────────────
// Primitives — minimal styled components that match the skill's contract
// ────────────────────────────────────────────────────────────────────────────

export interface CardProps {
	title?: ReactNode;
	children?: ReactNode;
	style?: CSSProperties;
}

export function Card({ title, children, style }: CardProps) {
	return (
		<section
			style={{
				border: "1px solid var(--dc-border, #e4e4e7)",
				borderRadius: 8,
				padding: "1rem 1.25rem",
				background: "var(--dc-card-bg, #fff)",
				boxShadow: "0 1px 2px rgba(0,0,0,0.02)",
				...style,
			}}
		>
			{title && (
				<header
					style={{
						marginBottom: "0.75rem",
						fontSize: "1rem",
						fontWeight: 600,
					}}
				>
					{title}
				</header>
			)}
			{children}
		</section>
	);
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
	variant?: "primary" | "secondary" | "danger";
	size?: "sm" | "md" | "lg";
}

const BUTTON_VARIANTS: Record<string, CSSProperties> = {
	primary: { background: "#111", color: "#fff", borderColor: "#111" },
	secondary: { background: "#f4f4f5", color: "#111", borderColor: "#d4d4d8" },
	danger: { background: "#b91c1c", color: "#fff", borderColor: "#991b1b" },
};

const BUTTON_SIZES: Record<string, CSSProperties> = {
	sm: { padding: "4px 10px", fontSize: "0.85em" },
	md: { padding: "8px 14px", fontSize: "0.95em" },
	lg: { padding: "12px 20px", fontSize: "1em" },
};

export function Button({
	variant = "secondary",
	size = "md",
	style,
	children,
	...rest
}: ButtonProps) {
	return (
		<button
			type="button"
			style={{
				border: "1px solid",
				borderRadius: 6,
				cursor: rest.disabled ? "not-allowed" : "pointer",
				opacity: rest.disabled ? 0.5 : 1,
				fontWeight: 500,
				transition: "filter 0.1s",
				...BUTTON_VARIANTS[variant],
				...BUTTON_SIZES[size],
				...style,
			}}
			{...rest}
		>
			{children}
		</button>
	);
}

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
	label?: string;
}

export function Input({ label, style, ...rest }: InputProps) {
	const input = (
		<input
			style={{
				border: "1px solid var(--dc-border, #d4d4d8)",
				borderRadius: 6,
				padding: "6px 10px",
				fontSize: "0.95em",
				width: "100%",
				boxSizing: "border-box",
				...style,
			}}
			{...rest}
		/>
	);
	if (!label) return input;
	return (
		<label
			style={{
				display: "flex",
				flexDirection: "column",
				gap: 4,
				margin: "0.5rem 0",
				fontSize: "0.85em",
				color: "#444",
			}}
		>
			<span>{label}</span>
			{input}
		</label>
	);
}

export interface SelectOption {
	value: string;
	label: string;
}

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
	label?: string;
	options?: SelectOption[];
}

export function Select({ label, options, style, children, ...rest }: SelectProps) {
	const select = (
		<select
			style={{
				border: "1px solid var(--dc-border, #d4d4d8)",
				borderRadius: 6,
				padding: "6px 10px",
				fontSize: "0.95em",
				background: "#fff",
				...style,
			}}
			{...rest}
		>
			{options
				? options.map((o) => (
						<option key={o.value} value={o.value}>
							{o.label}
						</option>
					))
				: children}
		</select>
	);
	if (!label) return select;
	return (
		<label
			style={{
				display: "flex",
				flexDirection: "column",
				gap: 4,
				margin: "0.5rem 0",
				fontSize: "0.85em",
				color: "#444",
			}}
		>
			<span>{label}</span>
			{select}
		</label>
	);
}

export interface ToggleProps {
	checked: boolean;
	onChange: (next: boolean) => void;
	label?: string;
	disabled?: boolean;
}

export function Toggle({ checked, onChange, label, disabled }: ToggleProps) {
	return (
		<label
			style={{
				display: "inline-flex",
				alignItems: "center",
				gap: 8,
				cursor: disabled ? "not-allowed" : "pointer",
				opacity: disabled ? 0.5 : 1,
			}}
		>
			<input
				type="checkbox"
				checked={checked}
				disabled={disabled}
				onChange={(e) => onChange(e.currentTarget.checked)}
				style={{ width: 18, height: 18 }}
			/>
			{label && <span>{label}</span>}
		</label>
	);
}

export interface TableColumn<T> {
	key: string;
	header: ReactNode;
	render?: (row: T) => ReactNode;
	width?: string | number;
}

export interface TableProps<T> {
	columns: TableColumn<T>[];
	data: T[];
	getRowKey?: (row: T) => string;
	emptyMessage?: string;
	onRowClick?: (row: T) => void;
}

export function Table<T>({
	columns,
	data,
	getRowKey,
	emptyMessage = "No data",
	onRowClick,
}: TableProps<T>) {
	if (data.length === 0) {
		return (
			<p style={{ color: "#888", fontStyle: "italic", margin: "1rem 0" }}>
				{emptyMessage}
			</p>
		);
	}
	return (
		<div style={{ overflowX: "auto" }}>
			<table
				style={{
					width: "100%",
					borderCollapse: "collapse",
					fontSize: "0.9em",
				}}
			>
				<thead>
					<tr>
						{columns.map((c) => (
							<th
								key={c.key}
								style={{
									textAlign: "left",
									padding: "8px 10px",
									borderBottom: "2px solid #e4e4e7",
									color: "#555",
									fontWeight: 600,
									...(c.width ? { width: c.width } : {}),
								}}
							>
								{c.header}
							</th>
						))}
					</tr>
				</thead>
				<tbody>
					{data.map((row, rowIdx) => {
						const key = getRowKey ? getRowKey(row) : String(rowIdx);
						return (
							<tr
								key={key}
								onClick={onRowClick ? () => onRowClick(row) : undefined}
								style={{
									cursor: onRowClick ? "pointer" : "default",
									borderBottom: "1px solid #f4f4f5",
								}}
							>
								{columns.map((c) => (
									<td
										key={c.key}
										style={{ padding: "8px 10px" }}
									>
										{c.render
											? c.render(row)
											: // @ts-expect-error — untyped row[key] access is intentional
												(row[c.key] ?? "")}
									</td>
								))}
							</tr>
						);
					})}
				</tbody>
			</table>
		</div>
	);
}

export function Loading({ label = "Loading…" }: { label?: string }) {
	return (
		<div
			style={{
				display: "flex",
				alignItems: "center",
				gap: 8,
				color: "#888",
				padding: "1rem 0",
			}}
		>
			<span
				aria-hidden
				style={{
					display: "inline-block",
					width: 14,
					height: 14,
					border: "2px solid #d4d4d8",
					borderTopColor: "#888",
					borderRadius: "50%",
					animation: "dc-spin 0.8s linear infinite",
				}}
			/>
			<span>{label}</span>
			<style>{`@keyframes dc-spin { to { transform: rotate(360deg); } }`}</style>
		</div>
	);
}

export interface AlertProps {
	type?: "info" | "success" | "warning" | "error";
	title?: ReactNode;
	children?: ReactNode;
}

const ALERT_COLORS: Record<string, { bg: string; border: string; fg: string }> = {
	info: { bg: "#eff6ff", border: "#93c5fd", fg: "#1e3a8a" },
	success: { bg: "#f0fdf4", border: "#86efac", fg: "#14532d" },
	warning: { bg: "#fffbeb", border: "#fde68a", fg: "#78350f" },
	error: { bg: "#fef2f2", border: "#fca5a5", fg: "#7f1d1d" },
};

export function Alert({ type = "info", title, children }: AlertProps) {
	const c = ALERT_COLORS[type] ?? ALERT_COLORS.info;
	if (!c) return null;
	return (
		<div
			role={type === "error" ? "alert" : "status"}
			style={{
				padding: "0.75rem 1rem",
				background: c.bg,
				border: `1px solid ${c.border}`,
				color: c.fg,
				borderRadius: 6,
				margin: "0.75rem 0",
			}}
		>
			{title && <div style={{ fontWeight: 600, marginBottom: 4 }}>{title}</div>}
			{children && <div>{children}</div>}
		</div>
	);
}

// ────────────────────────────────────────────────────────────────────────────
// FormField — labelled wrapper with description + inline error
// ────────────────────────────────────────────────────────────────────────────

export interface FormFieldProps {
	label?: ReactNode;
	description?: ReactNode;
	error?: ReactNode;
	required?: boolean;
	htmlFor?: string;
	children: ReactNode;
	style?: CSSProperties;
}

export function FormField({
	label,
	description,
	error,
	required,
	htmlFor,
	children,
	style,
}: FormFieldProps) {
	const fallbackId = useId();
	const fieldId = htmlFor ?? fallbackId;
	const descId = description ? `${fieldId}-desc` : undefined;
	const errId = error ? `${fieldId}-err` : undefined;
	return (
		<div
			style={{
				display: "flex",
				flexDirection: "column",
				gap: 4,
				margin: "0.5rem 0",
				...style,
			}}
		>
			{label && (
				<label
					htmlFor={fieldId}
					style={{ fontSize: "0.85em", color: "#444", fontWeight: 500 }}
				>
					{label}
					{required && <span style={{ color: "#b91c1c", marginLeft: 4 }}>*</span>}
				</label>
			)}
			{children}
			{description && !error && (
				<p
					id={descId}
					style={{ fontSize: "0.78em", color: "#666", margin: "2px 0 0" }}
				>
					{description}
				</p>
			)}
			{error && (
				<p
					id={errId}
					role="alert"
					style={{
						fontSize: "0.78em",
						color: "#b91c1c",
						margin: "2px 0 0",
						fontWeight: 500,
					}}
				>
					{typeof error === "string" ? error : error}
				</p>
			)}
		</div>
	);
}

// ────────────────────────────────────────────────────────────────────────────
// NumberInput — strict numeric input with bounds + suffix
// ────────────────────────────────────────────────────────────────────────────

export interface NumberInputProps
	extends Omit<
		InputHTMLAttributes<HTMLInputElement>,
		"value" | "onChange" | "type" | "prefix" | "min" | "max" | "step"
	> {
	value: number | null | undefined;
	onChange: (next: number | undefined) => void;
	min?: number;
	max?: number;
	step?: number;
	suffix?: ReactNode;
	prefix?: ReactNode;
	invalid?: boolean;
}

export function NumberInput({
	value,
	onChange,
	min,
	max,
	step,
	suffix,
	prefix,
	invalid,
	disabled,
	style,
	...rest
}: NumberInputProps) {
	// Keep a local string buffer so users can type intermediate values like
	// "1." or "-" without being snapped back by the controlled value.
	const [buffer, setBuffer] = useState(() =>
		value === null || value === undefined ? "" : String(value),
	);

	// Only resync the buffer from the parent-provided `value`. We intentionally
	// do NOT include `buffer` in the dep list: while the user is typing, the
	// local buffer (e.g. "19") differs from the not-yet-committed parent value
	// (still null or the old number), and including `buffer` would cause the
	// effect to fire on every keystroke and snap the input back — which makes
	// the field feel frozen (keys appear to do nothing). commit() handles
	// bouncing back from invalid input on blur/Enter.
	// biome-ignore lint/correctness/useExhaustiveDependencies: see comment above
	useEffect(() => {
		setBuffer(value === null || value === undefined ? "" : String(value));
	}, [value]);

	function commit(raw: string): void {
		const trimmed = raw.trim();
		if (trimmed === "" || trimmed === "-" || trimmed === "+") {
			onChange(undefined);
			return;
		}
		const parsed = Number(trimmed);
		if (!Number.isFinite(parsed)) {
			onChange(undefined);
			return;
		}
		let clamped = parsed;
		if (min !== undefined && clamped < min) clamped = min;
		if (max !== undefined && clamped > max) clamped = max;
		setBuffer(String(clamped));
		onChange(clamped);
	}

	const border = invalid ? "#b91c1c" : "var(--dc-border, #d4d4d8)";
	return (
		<div
			style={{
				display: "inline-flex",
				alignItems: "stretch",
				border: `1px solid ${border}`,
				borderRadius: 6,
				background: disabled ? "#f4f4f5" : "#fff",
				opacity: disabled ? 0.6 : 1,
				overflow: "hidden",
				width: "100%",
				boxSizing: "border-box",
			}}
		>
			{prefix && (
				<span
					style={{
						padding: "6px 8px",
						background: "#f4f4f5",
						color: "#555",
						fontSize: "0.85em",
						display: "flex",
						alignItems: "center",
					}}
				>
					{prefix}
				</span>
			)}
			<input
				type="number"
				inputMode="decimal"
				value={buffer}
				disabled={disabled}
				onChange={(e) => setBuffer(e.currentTarget.value)}
				onBlur={(e) => commit(e.currentTarget.value)}
				onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
					if (e.key === "Enter") commit(e.currentTarget.value);
				}}
				{...(min !== undefined ? { min } : {})}
				{...(max !== undefined ? { max } : {})}
				{...(step !== undefined ? { step } : {})}
				style={{
					flex: 1,
					border: "none",
					outline: "none",
					padding: "6px 10px",
					fontSize: "0.95em",
					background: "transparent",
					width: "100%",
					minWidth: 0,
					...style,
				}}
				{...rest}
			/>
			{suffix && (
				<span
					style={{
						padding: "6px 8px",
						background: "#f4f4f5",
						color: "#555",
						fontSize: "0.85em",
						display: "flex",
						alignItems: "center",
					}}
				>
					{suffix}
				</span>
			)}
		</div>
	);
}

// ────────────────────────────────────────────────────────────────────────────
// Combobox — searchable single-select dropdown
// ────────────────────────────────────────────────────────────────────────────

export interface ComboboxOption {
	value: string;
	label: string;
	hint?: string;
	disabled?: boolean;
}

export interface ComboboxProps {
	value: string | null | undefined;
	onChange: (next: string | null) => void;
	options: readonly ComboboxOption[];
	placeholder?: string;
	disabled?: boolean;
	allowClear?: boolean;
	invalid?: boolean;
	id?: string;
}

export function Combobox({
	value,
	onChange,
	options,
	placeholder = "Select…",
	disabled,
	allowClear = false,
	invalid,
	id,
}: ComboboxProps) {
	const fallbackId = useId();
	const inputId = id ?? fallbackId;
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState("");
	const rootRef = useRef<HTMLDivElement>(null);

	const selected = useMemo(
		() => options.find((o) => o.value === value) ?? null,
		[options, value],
	);

	useEffect(() => {
		if (!open) return;
		function onDoc(e: MouseEvent): void {
			if (!rootRef.current) return;
			if (!rootRef.current.contains(e.target as Node)) {
				setOpen(false);
				setQuery("");
			}
		}
		document.addEventListener("mousedown", onDoc);
		return () => document.removeEventListener("mousedown", onDoc);
	}, [open]);

	const q = query.trim().toLowerCase();
	const filtered = q
		? options.filter(
				(o) =>
					o.label.toLowerCase().includes(q) ||
					o.value.toLowerCase().includes(q) ||
					(o.hint ? o.hint.toLowerCase().includes(q) : false),
			)
		: options;

	function choose(opt: ComboboxOption): void {
		if (opt.disabled) return;
		onChange(opt.value);
		setOpen(false);
		setQuery("");
	}

	const border = invalid ? "#b91c1c" : "var(--dc-border, #d4d4d8)";
	return (
		<div ref={rootRef} style={{ position: "relative", width: "100%" }}>
			<button
				id={inputId}
				type="button"
				disabled={disabled}
				onClick={() => !disabled && setOpen((o) => !o)}
				style={{
					width: "100%",
					textAlign: "left",
					border: `1px solid ${border}`,
					background: disabled ? "#f4f4f5" : "#fff",
					padding: "6px 30px 6px 10px",
					borderRadius: 6,
					fontSize: "0.95em",
					cursor: disabled ? "not-allowed" : "pointer",
					position: "relative",
					color: selected ? "#111" : "#888",
				}}
				aria-haspopup="listbox"
				aria-expanded={open}
			>
				{selected ? selected.label : placeholder}
				<span
					aria-hidden
					style={{
						position: "absolute",
						right: 10,
						top: "50%",
						transform: "translateY(-50%)",
						color: "#888",
					}}
				>
					▾
				</span>
			</button>
			{open && (
				<div
					style={{
						position: "absolute",
						top: "calc(100% + 4px)",
						left: 0,
						right: 0,
						zIndex: 50,
						background: "#fff",
						border: "1px solid #e4e4e7",
						borderRadius: 6,
						boxShadow: "0 6px 20px rgba(0,0,0,0.08)",
						maxHeight: 280,
						display: "flex",
						flexDirection: "column",
						overflow: "hidden",
					}}
				>
					<div style={{ padding: 6, borderBottom: "1px solid #f4f4f5" }}>
						<input
							autoFocus
							value={query}
							placeholder="Search…"
							onChange={(e) => setQuery(e.currentTarget.value)}
							onKeyDown={(e) => {
								if (e.key === "Enter" && filtered[0]) {
									e.preventDefault();
									choose(filtered[0]);
								}
								if (e.key === "Escape") {
									setOpen(false);
									setQuery("");
								}
							}}
							style={{
								width: "100%",
								border: "1px solid #e4e4e7",
								borderRadius: 4,
								padding: "4px 8px",
								fontSize: "0.9em",
								boxSizing: "border-box",
							}}
						/>
					</div>
					<ul
						role="listbox"
						style={{
							margin: 0,
							padding: 0,
							listStyle: "none",
							overflowY: "auto",
							maxHeight: 240,
						}}
					>
						{allowClear && value && (
							<li>
								<button
									type="button"
									onClick={() => {
										onChange(null);
										setOpen(false);
										setQuery("");
									}}
									style={{
										width: "100%",
										textAlign: "left",
										background: "transparent",
										border: "none",
										padding: "6px 10px",
										fontSize: "0.9em",
										color: "#888",
										fontStyle: "italic",
										cursor: "pointer",
									}}
								>
									Clear selection
								</button>
							</li>
						)}
						{filtered.length === 0 ? (
							<li
								style={{
									padding: "8px 10px",
									color: "#888",
									fontSize: "0.9em",
								}}
							>
								No matches
							</li>
						) : (
							filtered.map((opt) => (
								<li key={opt.value}>
									<button
										type="button"
										disabled={opt.disabled}
										onClick={() => choose(opt)}
										style={{
											width: "100%",
											textAlign: "left",
											background:
												opt.value === value ? "#f0f9ff" : "transparent",
											border: "none",
											padding: "6px 10px",
											fontSize: "0.9em",
											cursor: opt.disabled ? "not-allowed" : "pointer",
											opacity: opt.disabled ? 0.5 : 1,
											display: "flex",
											justifyContent: "space-between",
											gap: 8,
										}}
									>
										<span>{opt.label}</span>
										{opt.hint && (
											<span style={{ color: "#888", fontSize: "0.85em" }}>
												{opt.hint}
											</span>
										)}
									</button>
								</li>
							))
						)}
					</ul>
				</div>
			)}
		</div>
	);
}

// ────────────────────────────────────────────────────────────────────────────
// MultiSelect — chip-style multi-pick from fixed options (no free text)
// ────────────────────────────────────────────────────────────────────────────

export interface MultiSelectProps {
	value: readonly string[];
	onChange: (next: string[]) => void;
	options: readonly ComboboxOption[];
	placeholder?: string;
	disabled?: boolean;
	invalid?: boolean;
	id?: string;
	minItems?: number;
}

export function MultiSelect({
	value,
	onChange,
	options,
	placeholder = "Add…",
	disabled,
	invalid,
	id,
	minItems = 0,
}: MultiSelectProps) {
	const fallbackId = useId();
	const inputId = id ?? fallbackId;
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState("");
	const rootRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (!open) return;
		function onDoc(e: MouseEvent): void {
			if (!rootRef.current) return;
			if (!rootRef.current.contains(e.target as Node)) {
				setOpen(false);
				setQuery("");
			}
		}
		document.addEventListener("mousedown", onDoc);
		return () => document.removeEventListener("mousedown", onDoc);
	}, [open]);

	function toggle(v: string): void {
		if (value.includes(v)) {
			if (value.length <= minItems) return;
			onChange(value.filter((x) => x !== v));
		} else {
			onChange([...value, v]);
		}
	}

	function remove(v: string): void {
		if (value.length <= minItems) return;
		onChange(value.filter((x) => x !== v));
	}

	const q = query.trim().toLowerCase();
	const filtered = options.filter(
		(o) =>
			!q ||
			o.label.toLowerCase().includes(q) ||
			o.value.toLowerCase().includes(q) ||
			(o.hint ? o.hint.toLowerCase().includes(q) : false),
	);

	const optionByValue = useMemo(() => {
		const m = new Map<string, ComboboxOption>();
		for (const o of options) m.set(o.value, o);
		return m;
	}, [options]);

	const border = invalid ? "#b91c1c" : "var(--dc-border, #d4d4d8)";
	return (
		<div ref={rootRef} style={{ position: "relative", width: "100%" }}>
			<div
				id={inputId}
				style={{
					display: "flex",
					flexWrap: "wrap",
					alignItems: "center",
					gap: 4,
					border: `1px solid ${border}`,
					borderRadius: 6,
					padding: 4,
					minHeight: 32,
					background: disabled ? "#f4f4f5" : "#fff",
					cursor: disabled ? "not-allowed" : "text",
				}}
				onClick={() => !disabled && setOpen(true)}
				role="combobox"
				aria-expanded={open}
				aria-haspopup="listbox"
			>
				{value.map((v) => {
					const opt = optionByValue.get(v);
					const canRemove = value.length > minItems;
					return (
						<span
							key={v}
							style={{
								display: "inline-flex",
								alignItems: "center",
								gap: 4,
								background: "#eef2ff",
								color: "#1e3a8a",
								borderRadius: 4,
								padding: "2px 6px",
								fontSize: "0.85em",
							}}
						>
							{opt?.label ?? v}
							{!disabled && canRemove && (
								<button
									type="button"
									aria-label={`Remove ${opt?.label ?? v}`}
									onClick={(e) => {
										e.stopPropagation();
										remove(v);
									}}
									style={{
										border: "none",
										background: "transparent",
										cursor: "pointer",
										padding: 0,
										fontSize: "0.9em",
										color: "#1e3a8a",
									}}
								>
									×
								</button>
							)}
						</span>
					);
				})}
				<input
					value={query}
					placeholder={value.length === 0 ? placeholder : ""}
					onChange={(e) => {
						setQuery(e.currentTarget.value);
						setOpen(true);
					}}
					onFocus={() => setOpen(true)}
					disabled={disabled}
					style={{
						border: "none",
						outline: "none",
						background: "transparent",
						padding: "2px 4px",
						fontSize: "0.9em",
						flex: "1 1 80px",
						minWidth: 80,
					}}
				/>
			</div>
			{open && (
				<div
					style={{
						position: "absolute",
						top: "calc(100% + 4px)",
						left: 0,
						right: 0,
						zIndex: 50,
						background: "#fff",
						border: "1px solid #e4e4e7",
						borderRadius: 6,
						boxShadow: "0 6px 20px rgba(0,0,0,0.08)",
						maxHeight: 280,
						overflowY: "auto",
					}}
				>
					<ul role="listbox" style={{ margin: 0, padding: 0, listStyle: "none" }}>
						{filtered.length === 0 ? (
							<li
								style={{
									padding: "8px 10px",
									color: "#888",
									fontSize: "0.9em",
								}}
							>
								No matches
							</li>
						) : (
							filtered.map((opt) => {
								const active = value.includes(opt.value);
								return (
									<li key={opt.value}>
										<button
											type="button"
											onClick={() => toggle(opt.value)}
											style={{
												width: "100%",
												textAlign: "left",
												background: active ? "#f0f9ff" : "transparent",
												border: "none",
												padding: "6px 10px",
												fontSize: "0.9em",
												cursor: "pointer",
												display: "flex",
												justifyContent: "space-between",
												gap: 8,
											}}
										>
											<span>
												<span
													aria-hidden
													style={{
														display: "inline-block",
														width: 12,
														marginRight: 6,
														color: "#1e3a8a",
													}}
												>
													{active ? "✓" : ""}
												</span>
												{opt.label}
											</span>
											{opt.hint && (
												<span style={{ color: "#888", fontSize: "0.85em" }}>
													{opt.hint}
												</span>
											)}
										</button>
									</li>
								);
							})
						)}
					</ul>
				</div>
			)}
		</div>
	);
}

// ────────────────────────────────────────────────────────────────────────────
// Money display + currency/country option helpers
// ────────────────────────────────────────────────────────────────────────────

export function Money({
	value,
	locale,
	strong,
}: {
	value: MoneyValue | undefined | null;
	locale?: string;
	strong?: boolean;
}): ReactNode {
	if (!value) return <span style={{ color: "#888" }}>—</span>;
	const text = formatMoney(value, locale ?? "en-US");
	if (strong) return <strong>{text}</strong>;
	return <span>{text}</span>;
}

/** Render a minor-unit amount with a currency code. Prefers `Money` when caller already has a `MoneyValue`. */
export function MoneyMinor({
	amount,
	currency,
	locale,
}: {
	amount: number;
	currency: string;
	locale?: string;
}): ReactNode {
	return <Money value={{ amount, currency }} locale={locale ?? "en-US"} />;
}

export function currencyOptions(
	codes?: readonly string[],
): ComboboxOption[] {
	const list: readonly CurrencyInfo[] = codes
		? (codes
				.map((c) => getCurrencyInfo(c))
				.filter(Boolean) as CurrencyInfo[])
		: CURRENCY_TABLE;
	return list.map((c) => ({
		value: c.code,
		label: `${c.code} — ${c.name}`,
		hint: c.symbol,
	}));
}

export function countryOptions(): ComboboxOption[] {
	return COUNTRY_TABLE.map((c: CountryInfo) => ({
		value: c.code,
		label: c.name,
		hint: c.code,
	}));
}

// ────────────────────────────────────────────────────────────────────────────
// DateRangePicker (kit version) — with presets + validation
// ────────────────────────────────────────────────────────────────────────────

export interface DateRange {
	from: string;
	to: string;
}

const DATE_PRESETS: Array<{
	id: string;
	label: string;
	range: () => DateRange;
}> = [
	{
		id: "7d",
		label: "Last 7 days",
		range: () => ({
			from: new Date(Date.now() - 6 * 86_400_000).toISOString().slice(0, 10),
			to: new Date().toISOString().slice(0, 10),
		}),
	},
	{
		id: "30d",
		label: "Last 30 days",
		range: () => ({
			from: new Date(Date.now() - 29 * 86_400_000).toISOString().slice(0, 10),
			to: new Date().toISOString().slice(0, 10),
		}),
	},
	{
		id: "90d",
		label: "Last 90 days",
		range: () => ({
			from: new Date(Date.now() - 89 * 86_400_000).toISOString().slice(0, 10),
			to: new Date().toISOString().slice(0, 10),
		}),
	},
	{
		id: "mtd",
		label: "This month",
		range: () => {
			const now = new Date();
			const first = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
			return {
				from: first.toISOString().slice(0, 10),
				to: now.toISOString().slice(0, 10),
			};
		},
	},
	{
		id: "ytd",
		label: "Year to date",
		range: () => {
			const now = new Date();
			const first = new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
			return {
				from: first.toISOString().slice(0, 10),
				to: now.toISOString().slice(0, 10),
			};
		},
	},
];

export interface DateRangePickerProps {
	value: DateRange;
	onChange: (next: DateRange) => void;
	presets?: boolean;
}

export function DateRangePicker({ value, onChange, presets = true }: DateRangePickerProps) {
	const invalid = value.from && value.to && value.from > value.to;
	const tz =
		typeof Intl !== "undefined"
			? Intl.DateTimeFormat().resolvedOptions().timeZone
			: "UTC";
	return (
		<div
			style={{
				display: "inline-flex",
				flexWrap: "wrap",
				gap: 8,
				alignItems: "center",
			}}
		>
			<input
				type="date"
				value={value.from}
				onChange={(e: ChangeEvent<HTMLInputElement>) =>
					onChange({ ...value, from: e.target.value })
				}
				style={{
					border: `1px solid ${invalid ? "#b91c1c" : "var(--dc-border, #d4d4d8)"}`,
					borderRadius: 6,
					padding: "4px 8px",
				}}
				aria-label="Start date"
			/>
			<span aria-hidden>→</span>
			<input
				type="date"
				value={value.to}
				onChange={(e: ChangeEvent<HTMLInputElement>) =>
					onChange({ ...value, to: e.target.value })
				}
				style={{
					border: `1px solid ${invalid ? "#b91c1c" : "var(--dc-border, #d4d4d8)"}`,
					borderRadius: 6,
					padding: "4px 8px",
				}}
				aria-label="End date"
			/>
			{presets &&
				DATE_PRESETS.map((p) => (
					<button
						key={p.id}
						type="button"
						onClick={() => onChange(p.range())}
						style={{
							border: "1px solid var(--dc-border, #d4d4d8)",
							background: "#fff",
							borderRadius: 4,
							padding: "2px 8px",
							fontSize: "0.8em",
							color: "#444",
							cursor: "pointer",
						}}
					>
						{p.label}
					</button>
				))}
			<span style={{ fontSize: "0.75em", color: "#888" }}>{tz}</span>
			{invalid && (
				<span style={{ fontSize: "0.78em", color: "#b91c1c" }}>
					Start date must be on or before end date.
				</span>
			)}
		</div>
	);
}
