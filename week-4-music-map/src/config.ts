// Music Map - Site settings shared by everyone who opens the hosted app.
// Read from config.json next to index.html, so the site owner can change them
// on GitHub without rebuilding. Nothing in it is secret: a Spotify Client ID is a
// public identifier, and the Genius token lives inside the proxy, not here.

export interface SiteConfig {
  /** The site owner's Spotify app. Visitors can still use their own instead. */
  spotifyClientId: string;
  /** Address of the Genius helper (/api/genius on Vercel), which holds the Genius token. */
  geniusProxy: string;
  /** Where the app is hosted, for when it's opened inside a preview frame. */
  liveUrl: string;
  /** Name shown when visitors need to ask for Spotify access. */
  owner: string;
}

let config: SiteConfig = { spotifyClientId: '', geniusProxy: '', liveUrl: '', owner: '' };

export async function loadConfig(): Promise<void> {
  try {
    const res = await fetch('config.json', { cache: 'no-cache' });
    if (res.ok) config = { ...config, ...(await res.json()) };
  } catch {
    /* config is optional */
  }
}

export function siteConfig(): SiteConfig {
  return config;
}

/** True when the app runs inside another page (e.g. a preview). Spotify's sign-in won't load there. */
export function isFramed(): boolean {
  try {
    return window.top !== window.self;
  } catch {
    return true;
  }
}
