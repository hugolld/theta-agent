// The method-choice figure generator (spec #136): geometry only — two
// scaling curves and a budget line, no text. The prompt carries the
// legend, so the figure stays language-free; the decision's evidence is
// the shape itself: the whole-transcriptome curve crosses the 48-hour
// budget near cohort 25, inside the lab's stated range, while the
// targeted-panel curve stays near the floor across the whole axis.
//
// Deterministic by construction — no timestamps, no randomness, no
// locale — and the committed PNG must equal a regeneration (pinned by
// bench-tasks.test.mjs), so an edit to the figure is a deliberate,
// reviewed change: regenerate, re-land, disclose. The hand-rolled PNG
// encoder (one IHDR, one IDAT, IEND; truecolor RGB, filter 0) keeps the
// test tree dependency-free, exactly like the in-container grader.

import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const WIDTH = 640;
const HEIGHT = 400;
// The plot's pixel bounds and the axis ranges they stand for.
const X0 = 60;
const X1 = 600;
const Y_TOP = 40;
const Y_BOTTOM = 340;
const COHORT_MAX = 80;
const HOURS_MAX = 72;

const A_COLOR = [30, 30, 30]; // whole-transcriptome alignment
const B_COLOR = [110, 110, 110]; // targeted panel alignment
const BUDGET_COLOR = [185, 185, 185]; // the dashed two-day line
const AXIS_COLOR = [90, 90, 90];

function px(cohort) {
	return Math.round(X0 + (cohort / COHORT_MAX) * (X1 - X0));
}

function py(hours) {
	return Math.round(Y_BOTTOM - (hours / HOURS_MAX) * (Y_BOTTOM - Y_TOP));
}

function drawLine(canvas, x0, y0, x1, y1, [r, g, b]) {
	// Bresenham, integer steps either axis.
	const dx = Math.abs(x1 - x0);
	const dy = Math.abs(y1 - y0);
	const sx = x0 < x1 ? 1 : -1;
	const sy = y0 < y1 ? 1 : -1;
	let err = dx - dy;
	let x = x0;
	let y = y0;
	for (;;) {
		const at = (y * WIDTH + x) * 3;
		canvas[at] = r;
		canvas[at + 1] = g;
		canvas[at + 2] = b;
		if (x === x1 && y === y1) break;
		const err2 = 2 * err;
		if (err2 > -dy) {
			err -= dy;
			x += sx;
		}
		if (err2 < dx) {
			err += dx;
			y += sy;
		}
	}
}

function drawDashedRow(canvas, y, x0, x1, on, off, color) {
	for (let x = x0; x <= x1; x += on + off) {
		const end = Math.min(x + on - 1, x1);
		for (let i = x; i <= end; i++) {
			const at = (y * WIDTH + i) * 3;
			canvas[at] = color[0];
			canvas[at + 1] = color[1];
			canvas[at + 2] = color[2];
		}
	}
}

// The pure core (pinned by bench-tasks.test.mjs): one buffer, the exact
// bytes the asset carries.
export function renderFigure() {
	const canvas = new Uint8Array(WIDTH * HEIGHT * 3).fill(255);

	// Axes: left edge and bottom edge of the plot area.
	drawLine(canvas, X0, Y_TOP, X0, Y_BOTTOM, AXIS_COLOR);
	drawLine(canvas, X0, Y_BOTTOM, X1, Y_BOTTOM, AXIS_COLOR);

	// The two-day budget: dashed horizontal at 48 hours.
	drawDashedRow(canvas, py(48), X0, X1, 7, 5, BUDGET_COLOR);

	// Whole-transcriptome alignment: hours(x) = 48x/25 — crossing the
	// budget at cohort 25, leaving the plot's top at cohort 37.5.
	drawLine(canvas, px(0), py(0), px((25 * HOURS_MAX) / 48), py(HOURS_MAX), A_COLOR);

	// Targeted panel alignment: hours(x) = 6 + x/16 — near the floor
	// across the whole axis (6 to 11 hours).
	drawLine(canvas, px(0), py(6), px(COHORT_MAX), py(6 + COHORT_MAX / 16), B_COLOR);

	// PNG assembly: signature, IHDR, IDAT, IEND.
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(WIDTH, 0);
	ihdr.writeUInt32BE(HEIGHT, 4);
	ihdr[8] = 8; // bit depth
	ihdr[9] = 2; // color type: truecolor RGB
	ihdr[10] = 0; // compression
	ihdr[11] = 0; // filter
	ihdr[12] = 0; // interlace
	const raw = Buffer.alloc(HEIGHT * (1 + WIDTH * 3));
	for (let y = 0; y < HEIGHT; y++) {
		raw[y * (1 + WIDTH * 3)] = 0; // filter: none
		Buffer.from(canvas.buffer, y * WIDTH * 3, WIDTH * 3).copy(raw, y * (1 + WIDTH * 3) + 1);
	}
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk("IHDR", ihdr),
		chunk("IDAT", deflateSync(raw, { level: 9 })),
		chunk("IEND", Buffer.alloc(0)),
	]);
}

// Minimal CRC32 over the chunk type plus data — the PNG integrity word.
const CRC_TABLE = /* @__PURE__ */ (() => {
	const table = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		table[n] = c >>> 0;
	}
	return table;
})();

function crc32(buffer) {
	let c = 0xffffffff;
	for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
	const length = Buffer.alloc(4);
	length.writeUInt32BE(data.length, 0);
	const typeBuf = Buffer.from(type, "ascii");
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
	return Buffer.concat([length, typeBuf, data, crc]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const here = path.dirname(fileURLToPath(import.meta.url));
	writeFileSync(path.join(here, "method-choice-fig.png"), renderFigure());
	console.log("make-figure: wrote method-choice-fig.png");
}
