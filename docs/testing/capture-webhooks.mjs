#!/usr/bin/env node
/**
 * Webhook capture proxy for the Paystack end-to-end test (FIK-57).
 *
 * Point the tunnel at this proxy instead of the dev server. Every request is
 * saved, with all headers and the exact raw body, to
 * docs/testing/webhook-captures/ (git-ignored), then forwarded unchanged to
 * the dev server, whose response goes back to Paystack.
 *
 *   node docs/testing/capture-webhooks.mjs            # listens on 4322, forwards to 4321
 *   PORT=4322 TARGET=http://127.0.0.1:4321 node docs/testing/capture-webhooks.mjs
 *   node docs/testing/capture-webhooks.mjs replay <capture.json>   # resend exact bytes + headers
 *
 * Captures hold test-mode customer details. Do not commit or share them;
 * fixtures are made from them only after sanitising.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const port = Number(process.env.PORT ?? 4322);
const target = process.env.TARGET ?? "http://127.0.0.1:4321";
const outDir = join(dirname(fileURLToPath(import.meta.url)), "webhook-captures");
mkdirSync(outDir, { recursive: true });

if (process.argv[2] === "replay") {
	const { readFileSync } = await import("node:fs");
	const saved = JSON.parse(readFileSync(process.argv[3], "utf8"));
	const headers = {};
	for (const [k, v] of Object.entries(saved.headers)) {
		if (k === "host" || k === "content-length" || k === "connection") continue;
		headers[k] = v;
	}
	const res = await fetch(new URL(saved.path, target), {
		method: saved.method,
		headers,
		body: saved.rawBody,
	});
	console.log(`replayed → ${res.status} ${await res.text()}`);
	process.exit(0);
}

let count = 0;

createServer((req, res) => {
	const chunks = [];
	req.on("data", (c) => chunks.push(c));
	req.on("end", async () => {
		const raw = Buffer.concat(chunks);
		const text = raw.toString("utf8");
		let event = "unknown";
		try {
			event = JSON.parse(text).event ?? "unknown";
		} catch {}

		const headers = {};
		for (const [k, v] of Object.entries(req.headers)) {
			if (k === "host" || k === "content-length" || k === "connection") continue;
			headers[k] = v;
		}

		let status = 502;
		let responseText = "";
		try {
			const upstream = await fetch(new URL(req.url ?? "/", target), {
				method: req.method,
				headers,
				body: req.method === "GET" || req.method === "HEAD" ? undefined : raw,
			});
			status = upstream.status;
			responseText = await upstream.text();
		} catch (err) {
			responseText = JSON.stringify({ proxyError: String(err) });
		}

		count += 1;
		const stamp = new Date().toISOString().replace(/[:.]/g, "-");
		const file = join(outDir, `${stamp}-${String(count).padStart(3, "0")}-${event}.json`);
		writeFileSync(
			file,
			JSON.stringify(
				{
					receivedAt: new Date().toISOString(),
					method: req.method,
					path: req.url,
					headers: req.headers,
					rawBody: text,
					forwardedTo: target,
					response: { status, body: responseText },
				},
				null,
				2,
			),
		);
		console.log(`${count}  ${event}  → ${status}  ${file}`);

		res.writeHead(status, { "Content-Type": "application/json" });
		res.end(responseText);
	});
}).listen(port, "127.0.0.1", () => {
	console.log(`Capturing on http://127.0.0.1:${port}, forwarding to ${target}`);
});
