// The annotation oracle — the one test-side copy of the gateway's tool
// annotations (spec #120). The source of truth is server.py's tool_policies
// registry (spec #116); every fact here is pinned against the live wire by
// the registry-boot fold in test/gateway-mcp.test.mjs, so a flip in the
// server crosses that fold, the fix lands in exactly one row here, and the
// consumers below follow the row without a mirror of their own: the
// seven-tool listing projection, run_alphafold3's typed-tool asserts, and
// the submit gate's TOOL_INFOS stub (whose pin test then holds the literal
// CONFIRM_SET to the rows). "Annotation oracle" is test-infra vocabulary —
// this module's own word, deliberately not a GLOSSARY headword.
//
// Each row holds the wire's camelCase bits with every hint explicit: the
// wire itself omits bits the server leaves unset (mcp_types serializes
// annotations exclude_none), so a consumer comparing raw wire bytes reads
// absence as the MCP default — false for readOnly and destructive, true for
// openWorld — while a consumer wanting the declared facts reads them here.
// registryGated marks the typed tools that register only when a template
// registry is configured: the baseline seven-tool boot cannot wire-pin
// those rows by construction — the registry-boot fold does.
//
// A module under fixtures, deliberately: fixtures are expected data, this
// file imports nothing, and helpers/gateway.mjs — the alternative home —
// spawnSyncs its uv probe at import time, a side effect no consumer of
// plain annotation facts should inherit.

export const GATEWAY_ANNOTATIONS = [
	{ name: "list_environments", registryGated: false, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } },
	{ name: "job_status", registryGated: false, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } },
	{ name: "stage_files", registryGated: false, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } },
	{ name: "submit_job", registryGated: false, annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false } },
	{ name: "job_logs", registryGated: false, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } },
	{ name: "cancel_job", registryGated: false, annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false } },
	{ name: "fetch_artifacts", registryGated: false, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } },
	{ name: "run_alphafold3", registryGated: true, annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false } },
];
