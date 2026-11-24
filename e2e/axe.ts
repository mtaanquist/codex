import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';

// The axe rules the suite enforces. A check fails only on the
// rules the accessibility fixes have brought to zero, so a regression in one
// of them breaks the build; widen RULES as more of them are fixed.
const RULES = [
	// Contrast (#721).
	'color-contrast',
	// Page titles (#724).
	'document-title',
	// Page structure (#726).
	'bypass',
	'page-has-heading-one',
	'landmark-one-main',
	'landmark-no-duplicate-main',
	'landmark-no-duplicate-banner',
	'landmark-unique',
	'region',
	// Hidden menus stay out of the tab order (#720).
	'aria-hidden-focus',
	// Control names (#725).
	'aria-input-field-name',
	'button-name',
	'label',
	'link-name',
	'select-name'
];

export async function violations(page: Page) {
	const results = await new AxeBuilder({ page }).withRules(RULES).analyze();
	return results.violations.map(
		(v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`
	);
}
