// One shared reader for the RPC protocol's LF-delimited JSONL streams —
// pi's stdout in the driver's hands, the driver's stdin in the offline
// test's stub: the same wire format on both ends, one implementation.
// Split on LF only (U+2028/2029 are valid inside JSON strings), strip a
// trailing CR, skip blank lines, and skip lines that do not parse rather
// than dying mid-stream.
export function drainJsonl(buffer, chunk, onRecord) {
	buffer += chunk;
	let index;
	while ((index = buffer.indexOf("\n")) !== -1) {
		const line = buffer.slice(0, index).replace(/\r$/, "");
		buffer = buffer.slice(index + 1);
		if (line === "") continue;
		let record;
		try {
			record = JSON.parse(line);
		} catch {
			continue;
		}
		onRecord(record);
	}
	return buffer;
}
