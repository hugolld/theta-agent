// eslint local rule: a child_process spawn/exec call whose option object
// carries an `env` property must inherit the environment. Node's env option
// replaces the child environment rather than merging — an opts.env riding
// alone wipes PATH, and every later spawn dies ENOENT far from the cause
// (the rig strike's longest debug arc, #72). Passing forms: an inline
// object spreading process.env, `env: process.env` itself, or an identifier
// whose declarator in this file built it from a process.env spread. The
// tracking is file-local and assignment-blind — a deliberate environment
// replacement takes an eslint-disable comment with its reason. Direct call
// sites only; wrapper authors are covered by the CLAUDE.md failure-path
// bullet.

const SPAWN_NAMES = new Set([
	"exec",
	"execFile",
	"execFileSync",
	"execSync",
	"spawn",
	"spawnSync",
]);

function isProcessEnv(node) {
	return (
		node?.type === "MemberExpression" &&
		node.object?.type === "Identifier" &&
		node.object.name === "process" &&
		node.property?.type === "Identifier" &&
		node.property.name === "env"
	);
}

export default {
	meta: {
		docs: {
			description:
				"child_process spawns must inherit the environment: spread process.env into any env option",
		},
		schema: [],
	},
	create(context) {
		const inheriting = new Set();
		return {
			VariableDeclarator(node) {
				if (node.id?.type !== "Identifier") return;
				if (
					node.init?.type === "ObjectExpression" &&
					node.init.properties.some((p) => p.type === "SpreadElement" && isProcessEnv(p.argument))
				) {
					inheriting.add(node.id.name);
				}
			},
			CallExpression(node) {
				const callee = node.callee;
				const name =
					callee.type === "MemberExpression" ? callee.property?.name : callee.name;
				if (!SPAWN_NAMES.has(name)) return;
				for (const arg of node.arguments.slice(1)) {
					if (arg.type !== "ObjectExpression") continue;
					const envProp = arg.properties.find(
						(p) => p.type === "Property" && (p.key?.name === "env" || p.key?.value === "env"),
					);
					if (!envProp) continue;
					const value = envProp.value;
					const inherits =
						(value.type === "ObjectExpression" &&
							value.properties.some((p) => p.type === "SpreadElement" && isProcessEnv(p.argument))) ||
						(value.type === "Identifier" && inheriting.has(value.name)) ||
						isProcessEnv(value);
					if (!inherits) {
						context.report({
							node: envProp,
							message:
								"spawn env replaces the child environment — spread process.env: { ...process.env, ...opts.env }",
						});
					}
				}
			},
		};
	},
};
