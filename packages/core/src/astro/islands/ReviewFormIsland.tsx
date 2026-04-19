import { useState, type FormEvent } from "react";

export interface ReviewFormIslandProps {
	productId: string;
}

export default function ReviewFormIsland({ productId }: ReviewFormIslandProps) {
	const [rating, setRating] = useState(5);
	const [title, setTitle] = useState("");
	const [body, setBody] = useState("");
	const [customerName, setCustomerName] = useState("");
	const [customerEmail, setCustomerEmail] = useState("");
	const [state, setState] = useState<"idle" | "submitting" | "submitted">(
		"idle",
	);
	const [error, setError] = useState<string | null>(null);

	async function onSubmit(e: FormEvent) {
		e.preventDefault();
		setError(null);
		setState("submitting");
		try {
			const res = await fetch("/_emdash/api/plugins/dashcommerce/reviews", {
				method: "POST",
				credentials: "include",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					productId,
					rating,
					title: title || undefined,
					body,
					customerName,
					customerEmail,
				}),
			});
			const json = (await res.json()) as { error?: string };
			if (!res.ok) {
				setError(json.error ?? "Could not submit review");
				setState("idle");
				return;
			}
			setState("submitted");
		} catch (err) {
			setError(err instanceof Error ? err.message : "Network error");
			setState("idle");
		}
	}

	if (state === "submitted") {
		return (
			<div
				className="dc-review-thanks"
				style={{
					color: "var(--text, #111)",
					padding: "1rem",
					border: "1px solid var(--success, #b8d9bf)",
					background: "var(--success-bg, rgba(76, 175, 120, 0.08))",
					borderRadius: "var(--radius-lg, 8px)",
				}}
			>
				<p>Thanks for your review! It'll appear once a moderator approves it.</p>
			</div>
		);
	}

	return (
		<form onSubmit={onSubmit} className="dc-review-form">
			<h3>Leave a review</h3>
			{error && <p role="alert" className="dc-review-form__error">{error}</p>}
			<label>
				Rating{" "}
				<select
					value={rating}
					onChange={(e) => setRating(Number(e.currentTarget.value))}
				>
					<option value={5}>★★★★★</option>
					<option value={4}>★★★★☆</option>
					<option value={3}>★★★☆☆</option>
					<option value={2}>★★☆☆☆</option>
					<option value={1}>★☆☆☆☆</option>
				</select>
			</label>
			<label>
				Your name{" "}
				<input
					required
					value={customerName}
					onChange={(e) => setCustomerName(e.currentTarget.value)}
				/>
			</label>
			<label>
				Your email{" "}
				<input
					required
					type="email"
					value={customerEmail}
					onChange={(e) => setCustomerEmail(e.currentTarget.value)}
				/>
			</label>
			<label>
				Title (optional){" "}
				<input
					value={title}
					onChange={(e) => setTitle(e.currentTarget.value)}
				/>
			</label>
			<label>
				Review{" "}
				<textarea
					required
					rows={4}
					value={body}
					onChange={(e) => setBody(e.currentTarget.value)}
				/>
			</label>
			<button type="submit" disabled={state === "submitting"} className="dc-review-form__submit">
				{state === "submitting" ? "Submitting…" : "Submit review"}
			</button>
			<style>{`
				.dc-review-form { color: var(--text, #111); }
				.dc-review-form h3 { color: var(--text, #111); }
				.dc-review-form label { display: block; margin: 0.5rem 0; color: var(--text-mid, #444); font-size: 0.9em; }
				.dc-review-form input, .dc-review-form select, .dc-review-form textarea {
					margin-top: 0.25rem;
					padding: 0.45rem 0.6rem;
					width: 100%;
					background: var(--surface, #fff);
					color: var(--text, #111);
					border: 1px solid var(--border-strong, #d4d4d8);
					border-radius: var(--radius, 4px);
					font: inherit;
				}
				.dc-review-form__submit {
					margin-top: 0.5rem;
					padding: 0.6rem 1.25rem;
					background: var(--accent, var(--gold, #111));
					color: var(--accent-on, #fff);
					border: 0;
					border-radius: var(--radius, 4px);
					cursor: pointer;
					font-weight: 500;
				}
				.dc-review-form__submit:hover:not(:disabled) { background: var(--gold-light, var(--accent, #333)); }
				.dc-review-form__submit:disabled { opacity: 0.6; cursor: not-allowed; }
				.dc-review-form__error { color: var(--ember, #a00); margin: 0.25rem 0 0.5rem; }
				.dc-review-thanks { color: var(--text, #111); padding: 1rem; border: 1px solid var(--success, #b8d9bf); background: var(--success-bg, rgba(76, 175, 120, 0.08)); border-radius: var(--radius-lg, 8px); }
			`}</style>
		</form>
	);
}
