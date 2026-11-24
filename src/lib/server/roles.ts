import { error } from '@sveltejs/kit';
import { canModerate } from '#lib/roles';

// The two gates for the admin area. Both answer 404 rather than 403, so the
// area does not show up for people who cannot use it.
export function requireAdmin(locals: App.Locals) {
	if (locals.user?.role !== 'admin') error(404, 'Not found');
}

// Admins pass too.
export function requireModerator(locals: App.Locals) {
	if (!canModerate(locals.user?.role)) error(404, 'Not found');
}
