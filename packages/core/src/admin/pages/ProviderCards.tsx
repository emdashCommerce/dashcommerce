/**
 * Payment provider choice in Settings, as cards side by side: logo (or a
 * lettered tile), name and one line each. Native radio inputs, so keyboard
 * arrows and screen readers work as for any radio group.
 */

import { useState } from "react";
import { T } from "../theme";

export interface ProviderCard {
	id: string;
	label: string;
	description: string | null;
	logo: string | null;
	brandColour: string | null;
}

export interface ProviderCardsProps {
	providers: ProviderCard[];
	/** null: nothing chosen yet (a new store). */
	selectedId: string | null;
	onSelect: (id: string) => void;
	disabled: boolean;
}

const srOnly: React.CSSProperties = {
	position: "absolute",
	width: 1,
	height: 1,
	margin: -1,
	overflow: "hidden",
	clip: "rect(0 0 0 0)",
	whiteSpace: "nowrap",
	border: 0,
};

function Logo({ card }: { card: ProviderCard }) {
	if (card.logo) {
		return (
			<img
				src={card.logo}
				alt=""
				style={{ width: 44, height: 44, borderRadius: 10, objectFit: "contain", flex: "none" }}
			/>
		);
	}
	return (
		<span
			aria-hidden="true"
			style={{
				width: 44,
				height: 44,
				borderRadius: 10,
				flex: "none",
				display: "flex",
				alignItems: "center",
				justifyContent: "center",
				fontSize: 20,
				fontWeight: 700,
				color: T.onFill,
				background: card.brandColour ?? T.neutralFill,
			}}
		>
			{card.label.charAt(0).toUpperCase()}
		</span>
	);
}

export function ProviderCards({ providers, selectedId, onSelect, disabled }: ProviderCardsProps) {
	const [focused, setFocused] = useState<string | null>(null);
	return (
		<fieldset style={{ border: 0, margin: "0 0 1rem", padding: 0, minWidth: 0 }}>
			<legend style={srOnly}>Payment provider</legend>
			<div
				style={{
					display: "grid",
					gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
					gap: 12,
				}}
			>
				{providers.map((card) => {
					const on = card.id === selectedId;
					return (
						<label
							key={card.id}
							style={{
								position: "relative",
								display: "flex",
								flexDirection: "column",
								gap: 10,
								padding: 16,
								borderRadius: 12,
								cursor: disabled ? "default" : "pointer",
								background: on ? T.selected : T.surface,
								border: on ? `2px solid ${T.accent}` : `1px solid ${T.border}`,
								boxShadow: on ? `0 0 0 4px ${T.accentSoft}` : "none",
								outline: focused === card.id ? `3px solid ${T.accent}` : "none",
								outlineOffset: 2,
							}}
						>
							<input
								type="radio"
								name="dashcommerce-payment-provider"
								value={card.id}
								checked={on}
								disabled={disabled}
								onChange={() => onSelect(card.id)}
								onFocus={() => setFocused(card.id)}
								onBlur={() => setFocused(null)}
								style={srOnly}
							/>
							<span style={{ display: "flex", alignItems: "center", gap: 12 }}>
								<Logo card={card} />
								<span style={{ flex: 1, fontSize: 16, fontWeight: 600, color: T.textStrong }}>
									{card.label}
								</span>
								{on && (
									<svg aria-hidden="true" width="22" height="22" viewBox="0 0 24 24" fill={T.accent}>
										<circle cx="12" cy="12" r="11" />
										<path
											d="M7 12.5l3.2 3.2L17 9"
											fill="none"
											stroke={T.onFill}
											strokeWidth="2.4"
											strokeLinecap="round"
											strokeLinejoin="round"
										/>
									</svg>
								)}
							</span>
							{card.description && (
								<span style={{ fontSize: 14, color: T.text, lineHeight: 1.5 }}>
									{card.description}
								</span>
							)}
						</label>
					);
				})}
			</div>
		</fieldset>
	);
}
