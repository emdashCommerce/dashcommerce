import { defineConfig } from "tsdown";

export default defineConfig({
	// checkout-client is the browser entry (Paystack Popup); index is the provider.
	entry: ["src/index.ts", "src/checkout-client.ts"],
	format: ["esm"],
	dts: true,
	clean: true,
});
