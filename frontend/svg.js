export function svgDataUrl(svgMarkup) {
  const normalized = String(svgMarkup ?? "").trim();
  if (!normalized) {
    return "";
  }

  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(normalized)}`;
}

const ICON_ATTRS = 'xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"';

export const SPARKLES_SVG = `<svg ${ICON_ATTRS}><path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275Z"/><path d="M5 3v4"/><path d="M3 5h4"/><path d="M19 17v4"/><path d="M17 19h4"/></svg>`;

export const SEND_SVG = `<svg ${ICON_ATTRS}><path d="M22 2 11 13"/><path d="M22 2 15 22 11 13 2 9z"/></svg>`;

export const PLUS_SVG = `<svg ${ICON_ATTRS}><path d="M5 12h14"/><path d="M12 5v14"/></svg>`;

export const ARROW_RETURN_SVG = `<svg ${ICON_ATTRS}><polyline points="9 10 4 15 9 20"/><path d="M20 4v7a4 4 0 0 1-4 4H4"/></svg>`;

export const ASK_SVG = `<svg viewBox="0 0 14 14" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" aria-hidden="true"><path d="M2 3.5A1.5 1.5 0 0 1 3.5 2h7A1.5 1.5 0 0 1 12 3.5v5A1.5 1.5 0 0 1 10.5 10H6l-3 2.2V10A1.5 1.5 0 0 1 2 8.5z"/><path d="M5 5h4M5 7h2.5"/></svg>`;

export const COPY_SVG = `<svg ${ICON_ATTRS}><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>`;

// Git-branch glyph: one trunk, one branch splitting off — the fork affordance
// on turn-final agent messages.
export const FORK_SVG = `<svg ${ICON_ATTRS}><line x1="6" x2="6" y1="3" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/></svg>`;

export const CHECK_SVG = `<svg ${ICON_ATTRS}><polyline points="20 6 9 17 4 12"/></svg>`;

export const CHEVRON_DOWN_SVG = `<svg ${ICON_ATTRS}><polyline points="6 9 12 15 18 9"/></svg>`;

export const CHEVRON_RIGHT_SVG = `<svg ${ICON_ATTRS}><polyline points="9 18 15 12 9 6"/></svg>`;

// The Task screen's rail icon: a checklist, matching the product noun ("Task")
// rather than the data model ("team run").
export const SESSIONS_SVG = `<svg ${ICON_ATTRS}><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>`;

export const TASKS_SVG = `<svg ${ICON_ATTRS}><path d="M3 6h.01"/><path d="M3 12h.01"/><path d="M3 18h.01"/><path d="M8 6h13"/><path d="M8 12h13"/><path d="M8 18h13"/></svg>`;
export const USAGE_SVG = `<svg ${ICON_ATTRS}><path d="M3 3v16a2 2 0 0 0 2 2h16"/><path d="M7 15l3.5-4 3 3L21 7"/></svg>`;

export const SETTINGS_SVG = `<svg ${ICON_ATTRS}><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.09a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.09a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`;

export const X_SVG = `<svg ${ICON_ATTRS}><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>`;

export const SEARCH_SVG = `<svg ${ICON_ATTRS}><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>`;

export const BELL_SVG = `<svg ${ICON_ATTRS}><path d="M10.268 21a2 2 0 0 0 3.464 0"/><path d="M22 8c0-2.3-.8-4.3-2-6"/><path d="M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326"/><path d="M4 2C2.8 3.7 2 5.7 2 8"/></svg>`;

export const MORE_HORIZONTAL_SVG = `<svg ${ICON_ATTRS}><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/></svg>`;

export const REFRESH_SVG = `<svg ${ICON_ATTRS}><path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M21 21v-5h-5"/></svg>`;
