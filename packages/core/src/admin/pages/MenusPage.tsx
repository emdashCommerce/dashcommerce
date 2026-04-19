/**
 * DashCommerce menus admin page.
 *
 * EmDash's core admin UI ships a menus page that only lets you manage a
 * flat list of items; it has no affordance for nesting children under a
 * parent. This page uses the same `/_emdash/api/menus/*` endpoints but
 * renders items as a tree with explicit Indent/Outdent/Reorder buttons
 * and a Parent selector in the editor modal, so admins can build the
 * sub-menus the storefront header already supports.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { API_BASE, apiFetch, throwResponseError } from "@emdash-cms/admin";
import {
	Alert,
	Button,
	Card,
	FormField,
	Input,
	Loading,
	Select,
	confirm,
	toast,
} from "../kit";
import { EmptyState } from "../ui/EmptyState";

// ────────────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────────────

type MenuItemType = "custom" | "page" | "post" | "taxonomy" | "collection";

interface MenuRow {
	id: string;
	name: string;
	label: string;
	itemCount?: number;
	created_at?: string;
	updated_at?: string;
}

interface MenuItemRow {
	id: string;
	menu_id: string;
	parent_id: string | null;
	sort_order: number;
	type: string;
	reference_collection: string | null;
	reference_id: string | null;
	custom_url: string | null;
	label: string;
	title_attr: string | null;
	target: string | null;
	css_classes: string | null;
}

interface MenuWithItems extends MenuRow {
	items: MenuItemRow[];
}

interface ItemFormInput {
	type: MenuItemType;
	label: string;
	customUrl: string;
	referenceCollection: string;
	referenceId: string;
	target: string;
	titleAttr: string;
	cssClasses: string;
	parentId: string | null;
}

// ────────────────────────────────────────────────────────────────────────────
// Small API wrappers over the emdash admin endpoints. Duplicated rather
// than imported because `@emdash-cms/admin` doesn't currently re-export
// the menu helpers.
// ────────────────────────────────────────────────────────────────────────────

async function parse<T>(res: Response, fallback: string): Promise<T> {
	if (!res.ok) await throwResponseError(res, fallback);
	return (await res.json()).data as T;
}

async function listMenus(): Promise<MenuRow[]> {
	return parse<MenuRow[]>(
		await apiFetch(`${API_BASE}/menus`),
		"Failed to load menus",
	);
}

async function loadMenu(name: string): Promise<MenuWithItems> {
	return parse<MenuWithItems>(
		await apiFetch(`${API_BASE}/menus/${encodeURIComponent(name)}`),
		"Failed to load menu",
	);
}

async function createMenu(input: {
	name: string;
	label: string;
}): Promise<MenuRow> {
	return parse<MenuRow>(
		await apiFetch(`${API_BASE}/menus`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(input),
		}),
		"Failed to create menu",
	);
}

async function updateMenu(
	name: string,
	input: { label?: string },
): Promise<MenuRow> {
	return parse<MenuRow>(
		await apiFetch(`${API_BASE}/menus/${encodeURIComponent(name)}`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(input),
		}),
		"Failed to update menu",
	);
}

async function deleteMenu(name: string): Promise<void> {
	const res = await apiFetch(
		`${API_BASE}/menus/${encodeURIComponent(name)}`,
		{ method: "DELETE" },
	);
	if (!res.ok) await throwResponseError(res, "Failed to delete menu");
}

async function createItem(
	menuName: string,
	input: {
		type: string;
		label: string;
		parentId?: string | null;
		customUrl?: string;
		referenceCollection?: string;
		referenceId?: string;
		target?: string;
		titleAttr?: string;
		cssClasses?: string;
		sortOrder?: number;
	},
): Promise<MenuItemRow> {
	// Null parentId confuses the server's optional schema; omit instead.
	const body: Record<string, unknown> = { ...input };
	if (body.parentId === null) delete body.parentId;
	return parse<MenuItemRow>(
		await apiFetch(`${API_BASE}/menus/${encodeURIComponent(menuName)}/items`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		}),
		"Failed to add item",
	);
}

async function updateItem(
	menuName: string,
	itemId: string,
	input: {
		label?: string;
		customUrl?: string;
		target?: string;
		titleAttr?: string;
		cssClasses?: string;
		parentId?: string | null;
		sortOrder?: number;
	},
): Promise<MenuItemRow> {
	return parse<MenuItemRow>(
		await apiFetch(
			`${API_BASE}/menus/${encodeURIComponent(menuName)}/items?id=${encodeURIComponent(itemId)}`,
			{
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(input),
			},
		),
		"Failed to update item",
	);
}

async function deleteItem(menuName: string, itemId: string): Promise<void> {
	const res = await apiFetch(
		`${API_BASE}/menus/${encodeURIComponent(menuName)}/items?id=${encodeURIComponent(itemId)}`,
		{ method: "DELETE" },
	);
	if (!res.ok) await throwResponseError(res, "Failed to delete item");
}

async function reorderItems(
	menuName: string,
	items: Array<{ id: string; parentId: string | null; sortOrder: number }>,
): Promise<void> {
	const res = await apiFetch(
		`${API_BASE}/menus/${encodeURIComponent(menuName)}/reorder`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ items }),
		},
	);
	if (!res.ok) await throwResponseError(res, "Failed to reorder items");
}

// ────────────────────────────────────────────────────────────────────────────
// Tree helpers
// ────────────────────────────────────────────────────────────────────────────

interface TreeNode {
	item: MenuItemRow;
	depth: number;
	children: TreeNode[];
}

function buildTree(items: MenuItemRow[]): TreeNode[] {
	const byParent = new Map<string | null, MenuItemRow[]>();
	for (const it of items) {
		const key = it.parent_id ?? null;
		const bucket = byParent.get(key);
		if (bucket) bucket.push(it);
		else byParent.set(key, [it]);
	}
	for (const bucket of byParent.values()) {
		bucket.sort((a, b) => a.sort_order - b.sort_order);
	}
	function pack(parent: string | null, depth: number): TreeNode[] {
		const rows = byParent.get(parent) ?? [];
		return rows.map((item) => ({
			item,
			depth,
			children: pack(item.id, depth + 1),
		}));
	}
	return pack(null, 0);
}

function flatten(tree: TreeNode[]): TreeNode[] {
	const out: TreeNode[] = [];
	const walk = (nodes: TreeNode[]) => {
		for (const n of nodes) {
			out.push(n);
			if (n.children.length > 0) walk(n.children);
		}
	};
	walk(tree);
	return out;
}

/**
 * Collect all descendant ids (including self) so we can exclude them
 * from the parent picker — otherwise a caller could nest an item under
 * its own child and produce a cycle.
 */
function collectDescendants(items: MenuItemRow[], rootId: string): Set<string> {
	const children = new Map<string, string[]>();
	for (const it of items) {
		const key = it.parent_id ?? "";
		const bucket = children.get(key);
		if (bucket) bucket.push(it.id);
		else children.set(key, [it.id]);
	}
	const out = new Set<string>([rootId]);
	const stack = [rootId];
	while (stack.length > 0) {
		const id = stack.pop() as string;
		for (const c of children.get(id) ?? []) {
			if (!out.has(c)) {
				out.add(c);
				stack.push(c);
			}
		}
	}
	return out;
}

function describeItem(it: MenuItemRow): string {
	if (it.type === "custom") return it.custom_url ?? "(no URL)";
	if (it.reference_collection && it.reference_id) {
		return `${it.reference_collection} · ${it.reference_id}`;
	}
	return it.type;
}

// ────────────────────────────────────────────────────────────────────────────
// Page
// ────────────────────────────────────────────────────────────────────────────

export function MenusPage() {
	const [menus, setMenus] = useState<MenuRow[] | null>(null);
	const [activeName, setActiveName] = useState<string | null>(null);
	const [menu, setMenu] = useState<MenuWithItems | null>(null);
	const [loadingItems, setLoadingItems] = useState(false);
	const [editingItem, setEditingItem] = useState<MenuItemRow | null>(null);
	const [creatingChildOf, setCreatingChildOf] = useState<string | null | undefined>(
		undefined,
	);
	const [creatingMenu, setCreatingMenu] = useState(false);
	const [editingMenuMeta, setEditingMenuMeta] = useState(false);

	const reloadMenus = useCallback(async () => {
		try {
			const list = await listMenus();
			setMenus(list);
			if (list.length > 0) {
				setActiveName((cur) => {
					if (cur && list.some((m) => m.name === cur)) return cur;
					return list[0]?.name ?? null;
				});
			} else {
				setActiveName(null);
				setMenu(null);
			}
		} catch (err) {
			toast.error(
				"Couldn't load menus",
				err instanceof Error ? err.message : undefined,
			);
			setMenus([]);
		}
	}, []);

	const reloadMenu = useCallback(async () => {
		if (!activeName) return;
		setLoadingItems(true);
		try {
			setMenu(await loadMenu(activeName));
		} catch (err) {
			toast.error(
				"Couldn't load menu",
				err instanceof Error ? err.message : undefined,
			);
		} finally {
			setLoadingItems(false);
		}
	}, [activeName]);

	useEffect(() => {
		reloadMenus();
	}, [reloadMenus]);

	useEffect(() => {
		reloadMenu();
	}, [reloadMenu]);

	const tree = useMemo<TreeNode[]>(() => {
		if (!menu) return [];
		return buildTree(menu.items);
	}, [menu]);

	const flat = useMemo(() => flatten(tree), [tree]);

	// ──────────────────────────────────────────────────────────────────────
	// Reorder actions
	// ──────────────────────────────────────────────────────────────────────

	/** Shift an item up or down among siblings sharing its parent_id. */
	const shift = useCallback(
		async (item: MenuItemRow, direction: -1 | 1) => {
			if (!menu) return;
			const siblings = menu.items
				.filter((it) => (it.parent_id ?? null) === (item.parent_id ?? null))
				.sort((a, b) => a.sort_order - b.sort_order);
			const idx = siblings.findIndex((s) => s.id === item.id);
			const targetIdx = idx + direction;
			if (idx === -1 || targetIdx < 0 || targetIdx >= siblings.length) return;
			const next = [...siblings];
			const removed = next.splice(idx, 1);
			if (removed.length === 0) return;
			next.splice(targetIdx, 0, removed[0] as MenuItemRow);
			const payload = next.map((it, i) => ({
				id: it.id,
				parentId: it.parent_id ?? null,
				sortOrder: i,
			}));
			try {
				await reorderItems(menu.name, payload);
				await reloadMenu();
			} catch (err) {
				toast.error(
					"Reorder failed",
					err instanceof Error ? err.message : undefined,
				);
			}
		},
		[menu, reloadMenu],
	);

	/** Nest an item under the preceding sibling (same parent, one position up). */
	const indent = useCallback(
		async (item: MenuItemRow) => {
			if (!menu) return;
			const siblings = menu.items
				.filter((it) => (it.parent_id ?? null) === (item.parent_id ?? null))
				.sort((a, b) => a.sort_order - b.sort_order);
			const idx = siblings.findIndex((s) => s.id === item.id);
			if (idx <= 0) return;
			const newParent = siblings[idx - 1] as MenuItemRow;
			const newParentKids = menu.items
				.filter((it) => it.parent_id === newParent.id)
				.sort((a, b) => a.sort_order - b.sort_order);
			try {
				await updateItem(menu.name, item.id, {
					parentId: newParent.id,
					sortOrder: newParentKids.length,
				});
				await reloadMenu();
			} catch (err) {
				toast.error(
					"Couldn't nest item",
					err instanceof Error ? err.message : undefined,
				);
			}
		},
		[menu, reloadMenu],
	);

	/** Move an item out of its parent — becomes a sibling of the parent. */
	const outdent = useCallback(
		async (item: MenuItemRow) => {
			if (!menu || !item.parent_id) return;
			const parent = menu.items.find((it) => it.id === item.parent_id);
			if (!parent) return;
			const grandparentId = parent.parent_id ?? null;
			const newSiblings = menu.items
				.filter((it) => (it.parent_id ?? null) === grandparentId)
				.sort((a, b) => a.sort_order - b.sort_order);
			const parentIdx = newSiblings.findIndex((s) => s.id === parent.id);
			const insertAt = parentIdx === -1 ? newSiblings.length : parentIdx + 1;
			try {
				// Place the item right after its former parent, then
				// renumber so sort_order values stay contiguous.
				const before = newSiblings.slice(0, insertAt).map((s) => s.id);
				const after = newSiblings.slice(insertAt).map((s) => s.id);
				const reordered = [...before, item.id, ...after];
				const payload = reordered.map((id, i) => ({
					id,
					parentId: grandparentId,
					sortOrder: i,
				}));
				// The item's parent is changing, so reorderItems must
				// explicitly rewrite its parentId — which it does.
				await reorderItems(menu.name, payload);
				await reloadMenu();
			} catch (err) {
				toast.error(
					"Couldn't outdent item",
					err instanceof Error ? err.message : undefined,
				);
			}
		},
		[menu, reloadMenu],
	);

	// ──────────────────────────────────────────────────────────────────────
	// Render
	// ──────────────────────────────────────────────────────────────────────

	if (!menus) return <Loading />;

	return (
		<div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
			<Card title="Navigation menus">
				<Alert type="info">
					EmDash's core admin menu editor doesn't expose parent/child
					relationships. Use this page to build sub-menus — they're
					rendered by the storefront automatically.
				</Alert>

				<div
					style={{
						display: "flex",
						gap: 12,
						alignItems: "center",
						flexWrap: "wrap",
						marginTop: 12,
					}}
				>
					<Select
						label="Menu"
						value={activeName ?? ""}
						onChange={(e) => setActiveName(e.currentTarget.value || null)}
						options={menus.map((m) => ({
							value: m.name,
							label: `${m.label} (${m.name})`,
						}))}
						disabled={menus.length === 0}
					/>
					<div style={{ display: "flex", gap: 6, marginTop: 14 }}>
						<Button onClick={() => setCreatingMenu(true)}>New menu</Button>
						{activeName && (
							<>
								<Button onClick={() => setEditingMenuMeta(true)}>
									Rename
								</Button>
								<Button
									variant="danger"
									onClick={async () => {
										if (!activeName) return;
										const ok = await confirm({
											title: `Delete menu "${activeName}"?`,
											description:
												"All items in this menu will be removed. This cannot be undone.",
											confirmLabel: "Delete menu",
											destructive: true,
										});
										if (!ok) return;
										try {
											await deleteMenu(activeName);
											toast.success("Menu deleted");
											await reloadMenus();
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
							</>
						)}
					</div>
				</div>

				{menus.length === 0 && (
					<EmptyState
						title="No menus yet"
						description="Create your first menu to start adding navigation links."
						action={
							<Button variant="primary" onClick={() => setCreatingMenu(true)}>
								New menu
							</Button>
						}
					/>
				)}
			</Card>

			{activeName && menu && (
				<Card title={`Items · ${menu.label}`}>
					<div
						style={{
							display: "flex",
							justifyContent: "flex-end",
							marginBottom: 8,
						}}
					>
						<Button
							variant="primary"
							onClick={() => setCreatingChildOf(null)}
						>
							Add top-level item
						</Button>
					</div>

					{loadingItems && <Loading />}

					{!loadingItems && flat.length === 0 && (
						<EmptyState
							title="No items yet"
							description="Add a top-level item, then use the nest button to move items into sub-menus."
						/>
					)}

					{!loadingItems && flat.length > 0 && (
						<div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
							{flat.map((node) => {
								const it = node.item;
								const siblings = menu.items
									.filter(
										(x) =>
											(x.parent_id ?? null) === (it.parent_id ?? null),
									)
									.sort((a, b) => a.sort_order - b.sort_order);
								const siblingIdx = siblings.findIndex((s) => s.id === it.id);
								const canUp = siblingIdx > 0;
								const canDown = siblingIdx >= 0 && siblingIdx < siblings.length - 1;
								const canIndent = canUp;
								const canOutdent = !!it.parent_id;
								return (
									<div
										key={it.id}
										style={{
											display: "flex",
											alignItems: "center",
											gap: 8,
											padding: "8px 10px",
											borderRadius: 6,
											border: "1px solid var(--dc-border, #e4e4e7)",
											background: node.depth === 0 ? "#fff" : "#fafafa",
											marginLeft: node.depth * 24,
										}}
									>
										<div
											style={{
												flex: 1,
												display: "flex",
												flexDirection: "column",
												gap: 2,
												minWidth: 0,
											}}
										>
											<div style={{ display: "flex", gap: 6, alignItems: "center" }}>
												<strong style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
													{it.label}
												</strong>
												<span
													style={{
														fontSize: "0.75em",
														padding: "2px 6px",
														borderRadius: 3,
														background: "#f4f4f5",
														color: "#52525b",
													}}
												>
													{it.type}
												</span>
											</div>
											<span
												style={{
													fontSize: "0.8em",
													color: "#71717a",
													overflow: "hidden",
													textOverflow: "ellipsis",
													whiteSpace: "nowrap",
												}}
											>
												{describeItem(it)}
											</span>
										</div>
										<div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
											<Button
												size="sm"
												disabled={!canUp}
												onClick={() => shift(it, -1)}
												title="Move up"
											>
												↑
											</Button>
											<Button
												size="sm"
												disabled={!canDown}
												onClick={() => shift(it, 1)}
												title="Move down"
											>
												↓
											</Button>
											<Button
												size="sm"
												disabled={!canIndent}
												onClick={() => indent(it)}
												title="Nest under previous sibling"
											>
												→
											</Button>
											<Button
												size="sm"
												disabled={!canOutdent}
												onClick={() => outdent(it)}
												title="Move out of parent"
											>
												←
											</Button>
											<Button
												size="sm"
												onClick={() => setCreatingChildOf(it.id)}
												title="Add child"
											>
												+ child
											</Button>
											<Button size="sm" onClick={() => setEditingItem(it)}>
												Edit
											</Button>
											<Button
												size="sm"
												variant="danger"
												onClick={async () => {
													const ok = await confirm({
														title: `Delete "${it.label}"?`,
														description:
															"Nested children will be removed too.",
														confirmLabel: "Delete",
														destructive: true,
													});
													if (!ok) return;
													try {
														await deleteItem(menu.name, it.id);
														toast.success("Item deleted");
														await reloadMenu();
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
									</div>
								);
							})}
						</div>
					)}
				</Card>
			)}

			{creatingMenu && (
				<MenuMetaEditor
					mode="create"
					onClose={() => setCreatingMenu(false)}
					onSave={async (input) => {
						await createMenu({ name: input.name, label: input.label });
						toast.success("Menu created");
						setCreatingMenu(false);
						setActiveName(input.name);
						await reloadMenus();
					}}
				/>
			)}

			{editingMenuMeta && menu && (
				<MenuMetaEditor
					mode="edit"
					initial={menu}
					onClose={() => setEditingMenuMeta(false)}
					onSave={async (input) => {
						await updateMenu(menu.name, { label: input.label });
						toast.success("Menu updated");
						setEditingMenuMeta(false);
						await reloadMenus();
						await reloadMenu();
					}}
				/>
			)}

			{(creatingChildOf !== undefined || editingItem) && menu && (
				<ItemEditor
					menu={menu}
					initial={editingItem}
					parentId={
						editingItem
							? editingItem.parent_id
							: creatingChildOf ?? null
					}
					onClose={() => {
						setEditingItem(null);
						setCreatingChildOf(undefined);
					}}
					onSave={async (input) => {
						try {
							if (editingItem) {
								await updateItem(menu.name, editingItem.id, {
									label: input.label,
									customUrl:
										input.type === "custom" ? input.customUrl : undefined,
									target: input.target || undefined,
									titleAttr: input.titleAttr || undefined,
									cssClasses: input.cssClasses || undefined,
									parentId: input.parentId,
								});
								toast.success("Item updated");
							} else {
								await createItem(menu.name, {
									type: input.type,
									label: input.label,
									parentId: input.parentId,
									...(input.type === "custom"
										? { customUrl: input.customUrl }
										: {
												referenceCollection: input.referenceCollection,
												referenceId: input.referenceId,
											}),
									target: input.target || undefined,
									titleAttr: input.titleAttr || undefined,
									cssClasses: input.cssClasses || undefined,
								});
								toast.success("Item added");
							}
							setEditingItem(null);
							setCreatingChildOf(undefined);
							await reloadMenu();
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

// ────────────────────────────────────────────────────────────────────────────
// Editor modals
// ────────────────────────────────────────────────────────────────────────────

function MenuMetaEditor({
	mode,
	initial,
	onClose,
	onSave,
}: {
	mode: "create" | "edit";
	initial?: MenuRow;
	onClose: () => void;
	onSave: (input: { name: string; label: string }) => Promise<void>;
}) {
	const [name, setName] = useState(initial?.name ?? "");
	const [label, setLabel] = useState(initial?.label ?? "");
	const [saving, setSaving] = useState(false);

	const valid =
		mode === "edit"
			? label.trim().length > 0
			: /^[a-z0-9_-]+$/i.test(name.trim()) && label.trim().length > 0;

	return (
		<Shell
			title={mode === "create" ? "New menu" : `Rename "${initial?.name}"`}
			onClose={onClose}
			saving={saving}
			canSave={valid}
			onSave={async () => {
				if (!valid) return;
				setSaving(true);
				try {
					await onSave({ name: name.trim(), label: label.trim() });
				} finally {
					setSaving(false);
				}
			}}
		>
			{mode === "create" && (
				<FormField
					label="Name (slug)"
					description="Used by the theme to reference the menu. Letters, numbers, hyphens, underscores."
				>
					<Input
						value={name}
						onChange={(e) => setName(e.currentTarget.value)}
						placeholder="primary"
						disabled={saving}
					/>
				</FormField>
			)}
			<FormField label="Label" description="Shown in the admin.">
				<Input
					value={label}
					onChange={(e) => setLabel(e.currentTarget.value)}
					placeholder="Primary navigation"
					disabled={saving}
				/>
			</FormField>
		</Shell>
	);
}

function ItemEditor({
	menu,
	initial,
	parentId: initialParentId,
	onClose,
	onSave,
}: {
	menu: MenuWithItems;
	initial: MenuItemRow | null;
	parentId: string | null;
	onClose: () => void;
	onSave: (input: ItemFormInput) => Promise<void>;
}) {
	const isEdit = !!initial;
	const [form, setForm] = useState<ItemFormInput>({
		type: (initial?.type as MenuItemType) ?? "custom",
		label: initial?.label ?? "",
		customUrl: initial?.custom_url ?? "",
		referenceCollection: initial?.reference_collection ?? "",
		referenceId: initial?.reference_id ?? "",
		target: initial?.target ?? "",
		titleAttr: initial?.title_attr ?? "",
		cssClasses: initial?.css_classes ?? "",
		parentId: initial ? (initial.parent_id ?? null) : initialParentId,
	});
	const [saving, setSaving] = useState(false);

	const parentOptions = useMemo(() => {
		const forbidden = initial
			? collectDescendants(menu.items, initial.id)
			: new Set<string>();
		const tree = buildTree(menu.items);
		const flat = flatten(tree);
		const opts: { value: string; label: string }[] = [
			{ value: "", label: "— no parent (top level) —" },
		];
		for (const node of flat) {
			if (forbidden.has(node.item.id)) continue;
			opts.push({
				value: node.item.id,
				label: `${"· ".repeat(node.depth)}${node.item.label}`,
			});
		}
		return opts;
	}, [menu.items, initial]);

	const valid =
		form.label.trim().length > 0 &&
		(form.type !== "custom" ||
			// A non-empty custom_url is required for custom-type items.
			form.customUrl.trim().length > 0);

	function set<K extends keyof ItemFormInput>(key: K, value: ItemFormInput[K]) {
		setForm((f) => ({ ...f, [key]: value }));
	}

	return (
		<Shell
			title={isEdit ? `Edit "${initial?.label}"` : "Add item"}
			onClose={onClose}
			saving={saving}
			canSave={valid}
			onSave={async () => {
				if (!valid) return;
				setSaving(true);
				try {
					await onSave({
						...form,
						label: form.label.trim(),
						customUrl: form.customUrl.trim(),
						referenceCollection: form.referenceCollection.trim(),
						referenceId: form.referenceId.trim(),
					});
				} finally {
					setSaving(false);
				}
			}}
		>
			{!isEdit && (
				<FormField label="Type">
					<Select
						value={form.type}
						onChange={(e) => set("type", e.currentTarget.value as MenuItemType)}
						options={[
							{ value: "custom", label: "Custom URL" },
							{ value: "page", label: "Page" },
							{ value: "post", label: "Post" },
							{ value: "taxonomy", label: "Taxonomy term" },
							{ value: "collection", label: "Collection" },
						]}
						disabled={saving}
					/>
				</FormField>
			)}

			<FormField label="Label">
				<Input
					value={form.label}
					onChange={(e) => set("label", e.currentTarget.value)}
					placeholder="Shop"
					disabled={saving}
				/>
			</FormField>

			<FormField
				label="Parent"
				description="Nest this item under another. Leave blank for a top-level link."
			>
				<Select
					value={form.parentId ?? ""}
					onChange={(e) => set("parentId", e.currentTarget.value || null)}
					options={parentOptions}
					disabled={saving}
				/>
			</FormField>

			{form.type === "custom" ? (
				<FormField
					label="URL"
					description="Absolute URL, relative path, #fragment, mailto:, or tel: — no JavaScript allowed."
				>
					<Input
						value={form.customUrl}
						onChange={(e) => set("customUrl", e.currentTarget.value)}
						placeholder="/shop"
						disabled={saving}
					/>
				</FormField>
			) : (
				<>
					<FormField
						label="Reference collection"
						description="The collection the referenced entry lives in (e.g. `pages`, `products`, `product_category`)."
					>
						<Input
							value={form.referenceCollection}
							onChange={(e) => set("referenceCollection", e.currentTarget.value)}
							placeholder="products"
							disabled={saving || isEdit}
						/>
					</FormField>
					<FormField label="Reference id">
						<Input
							value={form.referenceId}
							onChange={(e) => set("referenceId", e.currentTarget.value)}
							placeholder="01KN…"
							disabled={saving || isEdit}
						/>
					</FormField>
				</>
			)}

			<FormField
				label="Open in"
				description="Set to `_blank` to open in a new tab."
			>
				<Select
					value={form.target}
					onChange={(e) => set("target", e.currentTarget.value)}
					options={[
						{ value: "", label: "Same tab" },
						{ value: "_blank", label: "New tab" },
					]}
					disabled={saving}
				/>
			</FormField>

			<FormField label="Title (tooltip)">
				<Input
					value={form.titleAttr}
					onChange={(e) => set("titleAttr", e.currentTarget.value)}
					disabled={saving}
				/>
			</FormField>

			<FormField
				label="CSS classes"
				description="Space-separated class names applied to the link."
			>
				<Input
					value={form.cssClasses}
					onChange={(e) => set("cssClasses", e.currentTarget.value)}
					disabled={saving}
				/>
			</FormField>
		</Shell>
	);
}

function Shell({
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
