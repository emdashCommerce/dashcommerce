import { afterEach, describe, expect, it } from "vitest";

import {
	createPluginRuntimeTestHost,
	createPluginTestHost,
	type PluginRuntimeTestHost,
	type PluginTestHost,
} from "@emdash-cms/plugin-test";

let host: PluginTestHost | undefined;
let runtime: PluginRuntimeTestHost | undefined;

afterEach(async () => {
	await host?.dispose();
	await runtime?.dispose();
	host = undefined;
	runtime = undefined;
});

/** Every string value in a JSON-like tree. */
function strings(value: unknown): string[] {
	if (typeof value === "string") return [value];
	if (Array.isArray(value)) return value.flatMap(strings);
	if (value && typeof value === "object") return Object.values(value).flatMap(strings);
	return [];
}

describe("trust contract", () => {
	it("asks for no capabilities, hosts or storage", async () => {
		host = await createPluginTestHost();
		expect(host.manifest.capabilities).toEqual([]);
		expect(host.manifest.allowedHosts).toEqual([]);
		expect(Object.keys(host.manifest.storage ?? {})).toEqual([]);
	});
});

describe("setup page", () => {
	it("passes the host's Block Kit validation through the production page path", async () => {
		runtime = await createPluginRuntimeTestHost();
		const page = await runtime.admin.loadPage("/setup");
		expect(page.blocks.length).toBeGreaterThan(10);
		expect(page.blocks[0]).toEqual({ type: "header", text: "DashCommerce setup" });
	});

	it("covers the install steps and links", async () => {
		runtime = await createPluginRuntimeTestHost();
		const page = await runtime.admin.loadPage("/setup");
		const text = strings(page.blocks).join("\n");

		expect(text).toContain("npm install @dashcommerce/core");
		expect(text).toContain("npm create @dashcommerce@latest");
		expect(text).toContain("plugins: [dashcommerce()]");
		expect(text).toContain("emdash@1.4.0.patch");
		expect(text).toContain("https://demo.dashcommerce.dev");
		expect(text).toContain("https://dashcommerce.dev/docs");
		expect(text).toContain("https://github.com/emdashCommerce/dashcommerce");
		expect(text).toContain("DashCommerce Lite");
		expect(text).toContain("dashcommerce-lite");
		expect(text).toContain("Don't install Lite alongside core.");
		expect(text).not.toMatch(/in progress/i);
	});

	it("keeps copy plain", async () => {
		runtime = await createPluginRuntimeTestHost();
		const page = await runtime.admin.loadPage("/setup");
		const text = strings(page.blocks).join("\n");

		expect(text).not.toMatch(/\u2014|\u2013/);
		expect(text).not.toMatch(/seamless|unlock|elevate|supercharge|effortless|woocommerce/i);
	});

	it("returns the same page for other interactions and nothing for bad input", async () => {
		host = await createPluginTestHost();
		const loaded = await host.invokeRoute("admin", { type: "page_load", page: "/setup" });
		const clicked = await host.invokeRoute("admin", {
			type: "block_action",
			action_id: "anything",
		});
		expect(clicked).toEqual(loaded);
		expect(await host.invokeRoute("admin", "nope")).toEqual({ blocks: [] });
	});
});
