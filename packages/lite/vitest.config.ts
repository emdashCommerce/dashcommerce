import { emdashPluginTest } from "@emdash-cms/plugin-test/config";
import { defineConfig } from "vitest/config";

// Sandbox tests: build the plugin and run it in workerd through EmDash's
// production Cloudflare sandbox runner and PluginBridge.
export default defineConfig({
	plugins: [emdashPluginTest()],
	test: { include: ["test/sandbox/**/*.test.ts"], testTimeout: 60_000, hookTimeout: 60_000 },
});
