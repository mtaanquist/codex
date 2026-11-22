// The order of one editor copy's saves. The autosave chains its saves, but
// the save sent as the page is left goes out beside one still on its way, and
// either may reach the server first. When the later one puts the text back to
// what the server already holds, a content fingerprint cannot tell the two
// apart, so the older save would land last. Each copy names itself and
// numbers its saves; the row keeps the copy and number that saved last, and a
// save from that copy with a lower number is dropped (see supersededSave).

export type SaveOrder = { source: string; seq: number };

const SOURCE = /^[A-Za-z0-9_-]{8,64}$/;
const MAX_SEQ = 2 ** 31 - 1;

// A name for one editor copy. Not crypto.randomUUID, which only exists on
// secure origins; self-hosted installs may run over plain http.
export function newSaveSource(): string {
	let id = '';
	while (id.length < 20) id += Math.random().toString(36).slice(2);
	return id.slice(0, 20);
}

// The order a save request carries: null when it has none (a page opened
// before saves were numbered), 'invalid' when it is malformed.
export function parseSaveOrder(value: unknown): SaveOrder | null | 'invalid' {
	if (value === undefined || value === null) return null;
	if (typeof value !== 'object') return 'invalid';
	const { source, seq } = value as Record<string, unknown>;
	if (typeof source !== 'string' || !SOURCE.test(source)) return 'invalid';
	if (typeof seq !== 'number' || !Number.isInteger(seq) || seq < 1 || seq > MAX_SEQ) {
		return 'invalid';
	}
	return { source, seq };
}

// Whether a save is older than one the same copy already landed.
export function supersededSave(
	stored: { saveSource: string | null; saveSeq: number | null },
	order: SaveOrder | null | undefined
): boolean {
	return (
		!!order &&
		stored.saveSource === order.source &&
		stored.saveSeq !== null &&
		order.seq <= stored.saveSeq
	);
}
