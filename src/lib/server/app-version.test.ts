import { describe, it, expect } from 'vitest';
import { appVersion } from './app-version';
import pkg from '../../../package.json';

describe('appVersion', () => {
	it('uses the version the release image was built with', () => {
		expect(appVersion({ APP_VERSION: '3.22.0' })).toBe('3.22.0');
	});

	it('drops a leading v from a tag name', () => {
		expect(appVersion({ APP_VERSION: 'v3.22.0' })).toBe('3.22.0');
	});

	it('falls back to package.json when unset or blank', () => {
		expect(appVersion({})).toBe(pkg.version);
		expect(appVersion({ APP_VERSION: '  ' })).toBe(pkg.version);
	});
});
