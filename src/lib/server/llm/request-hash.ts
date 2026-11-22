import { createHash } from 'node:crypto';
import type { ChatMessage } from './providers/types.ts';

// A fingerprint of a request's messages. An arc, an enrich read and a chapter
// summary are each stored with the fingerprint of the request they were
// written from, and are out of date exactly when the request that would be
// sent now has a different one. Always hash the messages the request builder
// returns, so the fingerprint and the paid request cannot drift apart.
export function requestHash(messages: ChatMessage[]): string {
	return createHash('sha256').update(JSON.stringify(messages)).digest('hex');
}

// Stored in place of a fingerprint when the reply to a request could not be
// used (cut off at the reply limit, or empty), so the identical request is not
// paid for again on every pass. settings is roleReplySettings for the role
// that sent it: a new model or reply limit is worth another try. Never equal
// to a requestHash.
export function unusableReplyMark(input: string, settings: string): string {
	return `unusable:${createHash('sha256')
		.update(JSON.stringify([input, settings]))
		.digest('hex')}`;
}
