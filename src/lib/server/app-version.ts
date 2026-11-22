import pkg from '../../../package.json';

// The release image sets APP_VERSION from its tag, so a release never depends
// on a bump commit; package.json covers dev and from-source runs.
export function appVersion(env: Record<string, string | undefined> = process.env): string {
	return env.APP_VERSION?.trim().replace(/^v/, '') || pkg.version;
}
