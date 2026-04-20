import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { downloadTemplate } from "giget";
import pc from "picocolors";
import prompts from "prompts";

interface TemplateDef {
	label: string;
	description: string;
	/** giget source — any format the `giget` docs support. */
	source: string;
}

/**
 * Registry of available templates. Add new entries when new flat template
 * repos ship — the CLI gets a menu option for free.
 */
const TEMPLATES: Record<string, TemplateDef> = {
	starter: {
		label: "DashCommerce Starter",
		description:
			"Full Astro commerce site. 6 demo products, Stripe checkout, blog, subscriptions.",
		source: "github:emdashCommerce/starter",
	},
};

interface ParsedArgs {
	directory?: string;
	template?: string;
	help?: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
	const args: ParsedArgs = {};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === undefined) continue;
		if (a === "-h" || a === "--help") {
			args.help = true;
		} else if (a === "-t" || a === "--template") {
			args.template = argv[++i];
		} else if (!a.startsWith("-") && !args.directory) {
			args.directory = a;
		}
	}
	return args;
}

function printHelp(): void {
	const lines = [
		"",
		`  ${pc.bold(pc.magenta("create-dashcommerce"))} · scaffold a new DashCommerce project`,
		"",
		`  ${pc.dim("Usage")}`,
		`    npm create @dashcommerce@latest ${pc.dim("[directory]")} ${pc.dim("[--template name]")}`,
		"",
		`  ${pc.dim("Examples")}`,
		`    npm create @dashcommerce@latest ${pc.cyan("my-shop")}`,
		`    npm create @dashcommerce@latest my-shop ${pc.cyan("-- --template starter")}`,
		"",
		`  ${pc.dim("Templates")}`,
		...Object.entries(TEMPLATES).map(
			([k, v]) => `    ${pc.cyan(k.padEnd(10))} ${v.description}`,
		),
		"",
	];
	console.log(lines.join("\n"));
}

/**
 * Detect the package manager that invoked us. `npm_config_user_agent` is set
 * by every modern Node package manager and looks like
 * "pnpm/9.4.0 npm/? node/v22.0.0 ...". Falls back to npm.
 */
function detectPackageManager(): "bun" | "pnpm" | "yarn" | "npm" {
	const ua = process.env.npm_config_user_agent ?? "";
	if (ua.startsWith("bun")) return "bun";
	if (ua.startsWith("pnpm")) return "pnpm";
	if (ua.startsWith("yarn")) return "yarn";
	return "npm";
}

function run(
	cmd: string,
	args: string[],
	cwd: string,
	stdio: "inherit" | "ignore" = "inherit",
): boolean {
	const result = spawnSync(cmd, args, { cwd, stdio, shell: false });
	return result.status === 0;
}

async function main(): Promise<void> {
	const parsed = parseArgs(process.argv.slice(2));

	if (parsed.help) {
		printHelp();
		return;
	}

	console.log(
		`\n  ${pc.bold(pc.magenta("DashCommerce"))} ${pc.dim("· create a new project")}\n`,
	);

	// Validate --template up front so we can fail before prompting.
	if (parsed.template && !TEMPLATES[parsed.template]) {
		console.error(
			pc.red(
				`Unknown template: ${parsed.template}. Available: ${Object.keys(TEMPLATES).join(", ")}`,
			),
		);
		process.exit(1);
	}

	const onCancel = () => {
		console.log(pc.yellow("\n  Cancelled.\n"));
		process.exit(0);
	};

	const response = await prompts(
		[
			{
				type: parsed.directory ? null : "text",
				name: "directory",
				message: "Project directory",
				initial: "my-dashcommerce-shop",
				validate: (v: string) =>
					v.trim().length > 0 || "Directory name required",
			},
			{
				type: parsed.template ? null : "select",
				name: "template",
				message: "Template",
				choices: Object.entries(TEMPLATES).map(([value, def]) => ({
					title: def.label,
					description: def.description,
					value,
				})),
				initial: 0,
			},
			{
				type: "confirm",
				name: "install",
				message: "Install dependencies now?",
				initial: true,
			},
			{
				type: "confirm",
				name: "git",
				message: "Initialize a git repository?",
				initial: true,
			},
		],
		{ onCancel },
	);

	const directory = parsed.directory ?? (response.directory as string);
	const templateKey = parsed.template ?? (response.template as string);
	const template = TEMPLATES[templateKey];
	if (!template) {
		console.error(
			pc.red(
				`\n  Template "${templateKey}" is not in the registry. Available: ${Object.keys(TEMPLATES).join(", ")}\n`,
			),
		);
		process.exit(1);
	}
	const targetDir = resolve(process.cwd(), directory);

	// Refuse to overwrite a non-empty target. Empty dirs are fine — users
	// sometimes `mkdir` first.
	if (existsSync(targetDir) && readdirSync(targetDir).length > 0) {
		console.error(
			pc.red(
				`\n  Target directory "${directory}" exists and is not empty. Aborting.\n`,
			),
		);
		process.exit(1);
	}

	console.log(`\n  ${pc.cyan("↳")} Downloading ${pc.bold(template.label)}...`);
	try {
		await downloadTemplate(template.source, {
			dir: targetDir,
			force: false,
		});
	} catch (err) {
		console.error(
			pc.red(`\n  Failed to download template: ${(err as Error).message}\n`),
		);
		process.exit(1);
	}

	const pm = detectPackageManager();

	if (response.install) {
		console.log(`  ${pc.cyan("↳")} Installing dependencies (${pm})...`);
		if (!run(pm, ["install"], targetDir)) {
			console.error(
				pc.red(
					`\n  Install failed. You can retry manually: cd ${directory} && ${pm} install\n`,
				),
			);
			process.exit(1);
		}
	}

	if (response.git) {
		console.log(`  ${pc.cyan("↳")} Initializing git...`);
		run("git", ["init", "-q"], targetDir, "ignore");
		run("git", ["add", "-A"], targetDir, "ignore");
		run(
			"git",
			[
				"commit",
				"-q",
				"--no-gpg-sign",
				"-m",
				`init: scaffold from @dashcommerce/create (${templateKey})`,
			],
			targetDir,
			"ignore",
		);
	}

	const runCmd = pm === "npm" ? "npm run" : pm;

	console.log(`\n  ${pc.green("✓")} Done. Next steps:\n`);
	console.log(`    ${pc.dim("cd")} ${directory}`);
	if (!response.install) {
		console.log(`    ${pc.dim(`${pm} install`)}`);
	}
	console.log(
		`    ${pc.dim(`${runCmd} bootstrap`)}   ${pc.dim("# seed DB + demo catalog")}`,
	);
	console.log(
		`    ${pc.dim(`${runCmd} dev`)}         ${pc.dim("# dev server at :4321")}`,
	);
	console.log("");
	console.log(
		`  Stripe test keys: ${pc.cyan("https://dashboard.stripe.com/test/apikeys")}`,
	);
	console.log(
		`  Then paste them into ${pc.cyan("http://localhost:4321/_emdash/admin/plugins/dashcommerce/settings")}\n`,
	);
}

main().catch((err) => {
	console.error(pc.red(`\n  Unexpected error: ${(err as Error).message}\n`));
	process.exit(1);
});
