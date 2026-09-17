// Same-origin. StudioCall's own Vite server proxies /api/studiocall to the StudioCall server, and
// so does StudioMate's when this UI is embedded there — so one relative base serves both.
export const API = '';

// StudioMate, reached through the StudioCall server (never from the browser directly). Answers
// 503 `studiomate-offline` when StudioCall runs without StudioMate.
export const SM_API = `${API}/api/studiocall/studiomate`;

/** A stored media path, or a URL that already names its own origin. */
export const mediaSrc = (path: string): string => (/^https?:/.test(path) ? path : `${API}${path}`);
