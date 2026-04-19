import type { ProductFields, ProductType } from "../types";

export function isPurchasable(product: ProductFields): boolean {
	if (product.type === "external") return false;
	if (product.type === "grouped") return false; // customer buys children individually
	if (!product.manageStock) return product.stockStatus !== "outofstock";
	if (product.stockStatus === "outofstock" && product.backorders === "no") return false;
	return true;
}

export function requiresShipping(product: ProductFields): boolean {
	return !product.isVirtual && product.type !== "external";
}

export function productTypeRequiresVariants(type: ProductType): boolean {
	return type === "variable";
}

export function productTypeRequiresSubscriptionConfig(type: ProductType): boolean {
	return type === "subscription";
}

export function productTypeRequiresChildren(type: ProductType): boolean {
	return type === "grouped";
}

export function productTypeRequiresExternalUrl(type: ProductType): boolean {
	return type === "external";
}
