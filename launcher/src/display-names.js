// Display labels only. Routes, owner IDs, API fields and source paths stay stable.
const REFERENCE_NAMES = Object.freeze({
  umbrella: 'LaunchForge', short: 'Forge', build: 'Build', studio: 'Studio', grow: 'Grow', advisor: 'Advisor',
});
// Current naming lock: Present is the display name of the existing studio owner.
export const DISPLAY_NAMES = Object.freeze({...REFERENCE_NAMES, umbrella: 'Redwood', short: 'Redwood', studio: 'Present'});

/** Only source-owned help prose; never rewrite the user's copied prompt or stable IDs.
 * @param {string} text @param {typeof DISPLAY_NAMES} [names] */
export function applyHelpDisplayNames(text, names = DISPLAY_NAMES) {
  const keys = Object.fromEntries(Object.entries(REFERENCE_NAMES).map(([key, value]) => [value, key]));
  // Both current names and historical source-owned aliases follow the same config.
  Object.assign(keys, {Redwood: 'umbrella', Present: 'studio'});
  return text.replace(/\b(?:LaunchForge|Forge|Redwood|Build|Studio|Present|Grow|Advisor)\b/g, value => names[keys[value]]);
}

/** @param {string} html @param {typeof DISPLAY_NAMES} [names] */
export function applyDisplayNames(html, names = DISPLAY_NAMES) {
  return html.replace(/%LABEL_(UMBRELLA|SHORT|BUILD|STUDIO|GROW|ADVISOR)%/g, (_, key) => {
    const text = names[/** @type {keyof typeof names} */ (key.toLowerCase())];
    return text.replace(/[&<>"']/g, character => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[character] || character));
  });
}
