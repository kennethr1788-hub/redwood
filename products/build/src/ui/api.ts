import { DISPLAY_NAMES } from "../../../../launcher/src/display-names.js";
export async function api<T>(
  url: string,
  options: RequestInit = {},
): Promise<T> {
  const response = await fetch("/api" + url, {
    ...options,
    headers: { "Content-Type": "application/json", "X-LaunchForge": "1" },
    signal: options.signal,
  });
  const body = await response.json();
  if (!response.ok)
    throw new Error(
      body.error || `${DISPLAY_NAMES.umbrella} could not complete that request.`,
    );
  return body as T;
}
export async function copy(value: string) {
  await navigator.clipboard.writeText(value);
}
