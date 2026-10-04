export type DisplayNames = Readonly<{
  umbrella: string;
  short: string;
  build: string;
  studio: string;
  grow: string;
  advisor: string;
}>;
export const DISPLAY_NAMES: DisplayNames;
export function applyHelpDisplayNames(text: string, names?: DisplayNames): string;
export function applyDisplayNames(html: string, names?: DisplayNames): string;
