import type { SandboxedPlugin } from "emdash/plugin";

import { renderSetupPage } from "./page";

/**
 * DashCommerce Setup: a registry listing for DashCommerce.
 *
 * The full store is a native EmDash plugin published to npm as
 * `@dashcommerce/core`. The registry only accepts sandboxed plugins, so this
 * package renders one static Block Kit page with the install steps. It asks
 * for no capabilities and makes no network requests.
 */
const plugin: SandboxedPlugin = {
	routes: {
		admin: {
			handler: async (routeCtx) => {
				// The page is static, so every interaction (page_load or anything
				// else) gets the same blocks back. Non-object input gets nothing.
				if (typeof routeCtx.input !== "object" || routeCtx.input === null) {
					return { blocks: [] };
				}
				return renderSetupPage();
			},
		},
	},
};

export default plugin;
