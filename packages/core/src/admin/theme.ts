/** EmDash admin/Kumo colors with light-dark fallbacks for older hosts. */
export const adminColors = {
	base: "var(--color-kumo-base, light-dark(#fff, #18181b))",
	fill: "var(--color-kumo-fill, light-dark(#f4f4f5, #27272a))",
	border: "var(--color-kumo-fill, light-dark(#e4e4e7, #3f3f46))",
	text: "var(--text-color-kumo-default, light-dark(#111, #f4f4f5))",
	subtle: "var(--text-color-kumo-subtle, light-dark(#666, #a3a3a3))",
	brand: "var(--color-kumo-brand, light-dark(#0066cc, #1d4ed8))",
	onBrand: "var(--text-color-kumo-on-brand, light-dark(#fff, #fff))",
	danger: "var(--text-color-kumo-danger, light-dark(#b91c1c, #fca5a5))",
} as const;
