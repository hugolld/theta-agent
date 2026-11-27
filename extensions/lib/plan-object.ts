import { createHash } from "node:crypto";

/**
 * The plan object's TS side (spec #201 → #203): the citation grammar the
 * cards validator and the plan-review gate share, and the plan revision's
 * digest recipe. This module is a library, not an extension: it lives
 * under `extensions/lib/`, a directory pi's extension discovery skips (no
 * index file, no pi manifest), so no session loads it as an extension.
 *
 * The recipe mirrors the recorder's (`skills/theta-notebook/scripts/
 * notebook.py`): the first 12 hex of the sha256 over the plan file's raw
 * bytes. Both languages compute one revision — the recipe is pinned by
 * the committed test vector (`test/fixtures/notebook/plan-vector.md`),
 * which both suites read. A changed digest is a new revision: a
 * `--plan-update`'s change and a researcher's hand edit alike.
 */

/** The slug grammar: lowercase kebab, single hyphens, capped at 48. */
export const PLAN_SLUG_MAX = 48;
export const PLAN_SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * A plan object's recorded path — `.theta/plans/<plan-id>.md`, the form
 * every plan operation reports, with the calendar date riding the id.
 */
export const PLAN_PATH_RE = /^\.theta\/plans\/(\d{4}-\d{2}-\d{2})-(.+)\.md$/;

/** The revision shape: 12 lowercase hex — the digest the decision weighs. */
export const PLAN_REVISION_RE = /^[0-9a-f]{12}$/;

/**
 * A real YYYY-MM-DD calendar date — the same bar the recorder and the
 * dogfood auditor hold: shape alone is not a date, and `new Date` rolls
 * `2026-02-30` over instead of refusing it, so the components round-trip
 * through a UTC construction instead. The plan id embeds a date, so the
 * check rides this module; the card validator shares it for the evidence
 * retrieval dates.
 */
export function isCalendarDate(value: string): boolean {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
	const [year, month, day] = value.split("-").map(Number);
	const constructed = new Date(Date.UTC(year, month - 1, day));
	return (
		constructed.getUTCFullYear() === year &&
		constructed.getUTCMonth() === month - 1 &&
		constructed.getUTCDate() === day
	);
}

/** The slug grammar, judged: kebab shape plus the 48-character cap. */
export function isPlanSlug(slug: string): boolean {
	return slug.length <= PLAN_SLUG_MAX && PLAN_SLUG_RE.test(slug);
}

/** `.theta/plans/<plan-id>.md` under the plan-id grammar — the same bar `check_plan_id` holds on the Python side. */
export function isPlanPath(value: string): boolean {
	const match = PLAN_PATH_RE.exec(value);
	return match !== null && isCalendarDate(match[1]) && isPlanSlug(match[2]);
}

/**
 * The plan revision of a plan file's bytes: the first 12 hex of sha256.
 * The gate digests the file on disk with this before it looks for an
 * approval citing the same revision — a stale or edited plan never
 * satisfies the stop with an older revision's approval.
 */
export function planRevisionOf(bytes: Buffer): string {
	return createHash("sha256").update(bytes).digest("hex").slice(0, 12);
}
