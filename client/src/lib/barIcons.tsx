const P = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };

// The Live Chat bar's glyphs. Same drawing rules as tabIcons.tsx; the ones that already exist
// there (chat, overlay, type) are imported from it rather than redrawn.
const PATHS = {
  // People & Chat — a person with a bubble beside them
  room: <><circle cx="8" cy="8.5" r="3" {...P} /><path d="M3 19.5a5 5 0 0 1 10 0" {...P} /><path d="M14 4.5h6.5a1 1 0 0 1 1 1v4.5a1 1 0 0 1-1 1h-3.5l-2.5 2v-2H14a1 1 0 0 1-1-1V5.5a1 1 0 0 1 1-1Z" {...P} /></>,
  // Rooms — a door ajar: the hallway
  rooms: <><path d="M4 21h16M6 21V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v17" {...P} /><path d="M6 3.5 13 5.5V21" {...P} /><path d="M10.5 12.5v.5" {...P} /></>,
  // Settings — three sliders
  settings: <><path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1" {...P} /><circle cx="15" cy="6" r="2" {...P} /><circle cx="9" cy="12" r="2" {...P} /><circle cx="17" cy="18" r="2" {...P} /></>,
  // Gagged — a speech bubble struck through
  gag: <><path d="M20 11.5a7.5 7.5 0 0 1-10.7 6.8L4 20l1.4-4.3A7.5 7.5 0 1 1 20 11.5Z" {...P} /><path d="M4 4l16 16" {...P} /></>,
  // Auto card — an ID card: a face and its name lines
  card: <><rect x="2.5" y="5" width="19" height="14" rx="2" {...P} /><circle cx="8.5" cy="11" r="2.2" {...P} /><path d="M5.5 16a3.2 3.2 0 0 1 6 0M14 10h4.5M14 13.5h3" {...P} /></>,
  // Auto title — a headline on a lower-third bar
  headline: <><path d="M6 4h12M12 4v9" {...P} /><rect x="3" y="16" width="18" height="4" rx="1" {...P} /></>,
  // Auto invite — a person stepping up
  invite: <><circle cx="9" cy="8" r="3.2" {...P} /><path d="M3.5 20a5.5 5.5 0 0 1 11 0" {...P} /><path d="M18.5 8v7M15.5 11 18.5 8l3 3" {...P} /></>,
  // One voice — one mic, a "1" beside it
  oneVoice: <><rect x="11" y="3" width="6" height="10" rx="3" {...P} /><path d="M8 11a6 6 0 0 0 12 0M14 17v3.5" {...P} /><path d="M3 6.5 5 5v9" {...P} /></>,
  // Chat on air — a bubble with the live dot
  chatAir: <><path d="M17.5 12.5a7 7 0 0 1-10 6.3L3 20.5l1.3-4A7 7 0 1 1 17.5 12.5Z" {...P} /><path d="M7.5 11h5M7.5 14.5h3" {...P} /><circle cx="19.5" cy="4.5" r="2.5" fill="currentColor" stroke="none" /></>,
  // Dock — a window folding into a panel
  dock: <><rect x="3" y="4" width="18" height="16" rx="2" {...P} /><path d="M15 4v16M6.5 12h5.5M9.5 9l3 3-3 3" {...P} /></>,
  // Text size — small a, big A
  textSize: <><path d="M3 18l3.5-8 3.5 8M4.3 15h4.4M12 18l4.5-12L21 18M13.7 13.5h5.6" {...P} /></>,
  // Pinned link
  link: <><path d="M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1 1" {...P} /><path d="M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1-1" {...P} /></>,
  // Reset audio — circular arrow
  reset: <><path d="M20 12a8 8 0 1 1-2.3-5.7" {...P} /><path d="M20 4v4.5h-4.5" {...P} /></>,
  // Leave — out through the door
  leave: <><path d="M10 4H5a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h5" {...P} /><path d="M14 16.5 18.5 12 14 7.5M18.5 12H9" {...P} /></>,
  // End room — power
  end: <><path d="M12 3v8" {...P} /><path d="M6.4 6.5a8 8 0 1 0 11.2 0" {...P} /></>,
  // Request to join — raised hand
  hand: <><path d="M8 13V5.5a1.5 1.5 0 0 1 3 0V11M11 10V4a1.5 1.5 0 0 1 3 0v6M14 10V5.5a1.5 1.5 0 0 1 3 0V13" {...P} /><path d="M17 9.5a1.5 1.5 0 0 1 3 0V14a7 7 0 0 1-7 7h-1a6 6 0 0 1-5-2.7L4.3 14a1.5 1.5 0 0 1 2.4-1.8L8 14" {...P} /></>,
};

export type BarIconId = keyof typeof PATHS;

export function BarIcon({ id, className = 'w-3.5 h-3.5 shrink-0' }: { id: BarIconId; className?: string }) {
  return <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" className={className} aria-hidden>{PATHS[id]}</svg>;
}
