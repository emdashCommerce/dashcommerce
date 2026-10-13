/**
 * Duck-type a Web API `Response`.
 *
 * `instanceof Response` fails across realms (vm, iframe, some Workers
 * isolates). EmDash patches must use the same check so cart `Set-Cookie`
 * and webhook 200s survive dispatch.
 */
export function isWebResponse(value: unknown): value is Response {
	if (value === null || typeof value !== "object") return false;
	const candidate = value as {
		status?: unknown;
		clone?: unknown;
		headers?: { get?: unknown };
	};
	return (
		typeof candidate.status === "number" &&
		typeof candidate.clone === "function" &&
		typeof candidate.headers?.get === "function"
	);
}
