import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";
import spawnEnvInherit from "./scripts/eslint-rules/spawn-env-inherit.mjs";

export default defineConfig([
	{ ignores: ["node_modules/"] },
	tseslint.configs.recommended,
	{
		plugins: { local: { rules: { "spawn-env-inherit": spawnEnvInherit } } },
		rules: { "local/spawn-env-inherit": "error" },
	},
]);
