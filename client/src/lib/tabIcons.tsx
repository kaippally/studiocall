const P = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };

const PATHS: Record<string, React.ReactNode> = {
  // LiveStream — photo
  'thumbnail': <><rect x="3" y="5" width="18" height="14" rx="2" {...P} /><circle cx="8.5" cy="10" r="1.6" {...P} /><path d="m4 17 4.5-4.5L12 16l3-3 5 5" {...P} /></>,
  // Titles — type glyph
  '3d-titles': <><path d="M4 7V4.5h16V7M12 4.5V19M9 19h6" {...P} /></>,
  // Clipboard
  'clipboard': <><rect x="5" y="4" width="14" height="17" rx="2" {...P} /><path d="M9 4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v1.5H9Z" {...P} /><path d="M9 11h6M9 15h4" {...P} /></>,
  // BullTrack — timeline pulse
  'bulltrack': <><path d="M3 12h3.5l2-6 3.5 12 2.5-8 1.7 4H21" {...P} /></>,
  // Clips — film strip
  'stream-capture': <><rect x="3" y="5" width="18" height="14" rx="2" {...P} /><path d="M8 5v14M16 5v14M3 9.5h5M3 14.5h5M16 9.5h5M16 14.5h5" {...P} /></>,
  // ClipManager — film strip inside a frame: the clip library and its editors as one surface
  'clipmanager': <><rect x="2.5" y="6" width="19" height="12" rx="2" {...P} /><path d="M2.5 9.5h3M2.5 14.5h3M18.5 9.5h3M18.5 14.5h3" {...P} /><path d="m10 9.8 4.2 2.2-4.2 2.2Z" {...P} /></>,
  // Scene — video camera
  'scene': <><rect x="3" y="6" width="12" height="12" rx="2" {...P} /><path d="m15 10.5 6-3.5v10l-6-3.5" {...P} /></>,
  // Slides — presentation
  'slides': <><rect x="3" y="4" width="18" height="11" rx="1.5" {...P} /><path d="M12 15v3M8.5 21 12 18l3.5 3" {...P} /></>,
  // Music — note
  'music': <><path d="M9 18V6l11-2v12" {...P} /><circle cx="6.5" cy="18" r="2.5" {...P} /><circle cx="17.5" cy="16" r="2.5" {...P} /></>,
  // Upload — cloud arrow up
  'upload': <><path d="M7 18a4 4 0 0 1-.6-7.95A5.5 5.5 0 0 1 17.4 9.5 3.75 3.75 0 0 1 17 18" {...P} /><path d="M12 21v-8m0 0-2.6 2.6M12 13l2.6 2.6" {...P} /></>,
  // Simulator — DNA / selection ladder
  'simulator': <><path d="M7 3c0 4.5 10 5.5 10 9s-10 4.5-10 9" {...P} /><path d="M17 3c0 4.5-10 5.5-10 9s10 4.5 10 9" {...P} /><path d="M8.7 7h6.6M8.7 17h6.6" {...P} /></>,
  // StudioMeet — a person in their own frame
  'studiomeet': <><rect x="3" y="5" width="18" height="14" rx="2" {...P} /><circle cx="12" cy="10.5" r="2.4" {...P} /><path d="M7.5 17a4.5 4.5 0 0 1 9 0" {...P} /></>,
  // StudioCall — a room: speaker ring around a mic
  'studiocall': <><path d="M12 3.5a2.6 2.6 0 0 1 2.6 2.6v4.4a2.6 2.6 0 0 1-5.2 0V6.1A2.6 2.6 0 0 1 12 3.5Z" {...P} /><path d="M7 10.4a5 5 0 0 0 10 0M12 15.4V19M9 19h6" {...P} /><path d="M4.2 6.6a9 9 0 0 0 0 8.6M19.8 6.6a9 9 0 0 1 0 8.6" {...P} /></>,
  // Chat — speech bubble with a line of talk
  'chat': <><path d="M20.5 12a7.5 7.5 0 0 1-7.5 7.5H8l-4 2.5.9-3.7A7.5 7.5 0 1 1 20.5 12Z" {...P} /><path d="M8.5 10.5h7M8.5 14h4.5" {...P} /></>,
  // Overlay — layers
  'overlay': <><path d="m12 3 8.5 4.5L12 12 3.5 7.5 12 3Z" {...P} /><path d="m4 12 8 4.3 8-4.3M4 16.5 12 21l8-4.5" {...P} /></>,
  // Audio — patch cords crossing between two rails
  'audio': <><path d="M4 6h4a4 4 0 0 1 4 4v4a4 4 0 0 0 4 4h4" {...P} /><path d="M4 18h4a4 4 0 0 0 4-4" {...P} /><circle cx="4" cy="6" r="1.4" {...P} /><circle cx="4" cy="18" r="1.4" {...P} /><circle cx="20" cy="18" r="1.4" {...P} /></>,
};

export function TabIcon({ id, className = 'w-3.5 h-3.5 shrink-0' }: { id: string; className?: string }) {
  const path = PATHS[id];
  if (!path) return null;
  return <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" className={className} aria-hidden>{path}</svg>;
}
