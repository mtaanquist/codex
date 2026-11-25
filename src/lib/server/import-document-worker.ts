// Worker thread entry for parseDocumentInWorker (import-document.ts). It runs
// the TypeScript source under Node directly, as the background worker does, so
// it registers the same resolve hook before loading the converter.
import { parentPort, workerData } from 'node:worker_threads';
import '../../worker/register.js';

const { bytes, filename } = workerData as { bytes: Uint8Array; filename: string };
const { parseDocument, DocumentImportError } = await import('./import-document.ts');
try {
	parentPort!.postMessage({ plan: await parseDocument(bytes, filename) });
} catch (err) {
	if (!(err instanceof DocumentImportError)) throw err;
	parentPort!.postMessage({ importError: err.message });
}
