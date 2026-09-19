// DEVICE FINGERPRINT ROTATOR
// A pool of realistic, modern browser/device signatures. Each bot slot is
// assigned one profile per session (sticky for the life of that session, then
// re-rolled on session recycle) so concurrent slots look like separate genuine
// devices rather than one machine firing many requests.

export type DeviceProfile = {
  name: string;
  ua: string;
  secChUa?: string;
  mobile: "?0" | "?1";
  platform: string;
  language: string;
};

export const DEVICE_PROFILES: DeviceProfile[] = [
  // ---- Chrome / Windows
  {
    name: "Chrome 140 · Windows 11",
    ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
    secChUa: '"Chromium";v="140", "Google Chrome";v="140", "Not=A?Brand";v="24"',
    mobile: "?0",
    platform: '"Windows"',
    language: "en-US,en;q=0.9",
  },
  {
    name: "Edge 139 · Windows 11",
    ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36 Edg/139.0.0.0",
    secChUa: '"Chromium";v="139", "Microsoft Edge";v="139", "Not.A/Brand";v="24"',
    mobile: "?0",
    platform: '"Windows"',
    language: "en-US,en;q=0.9",
  },
  // ---- Chrome / macOS
  {
    name: "Chrome 140 · macOS",
    ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
    secChUa: '"Chromium";v="140", "Google Chrome";v="140", "Not=A?Brand";v="24"',
    mobile: "?0",
    platform: '"macOS"',
    language: "en-US,en;q=0.9",
  },
  // ---- Safari / macOS
  {
    name: "Safari 18 · macOS",
    ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15",
    mobile: "?0",
    platform: '"macOS"',
    language: "en-US,en;q=0.9",
  },
  // ---- Firefox
  {
    name: "Firefox 131 · Windows",
    ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0",
    mobile: "?0",
    platform: '"Windows"',
    language: "en-US,en;q=0.5",
  },
  {
    name: "Firefox 131 · macOS",
    ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14.6; rv:131.0) Gecko/20100101 Firefox/131.0",
    mobile: "?0",
    platform: '"macOS"',
    language: "en-US,en;q=0.5",
  },
  // ---- Android
  {
    name: "Chrome 140 · Android 14",
    ua: "Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36",
    secChUa: '"Chromium";v="140", "Google Chrome";v="140", "Not=A?Brand";v="24"',
    mobile: "?1",
    platform: '"Android"',
    language: "en-US,en;q=0.9,ar;q=0.8",
  },
  {
    name: "Chrome 139 · Android 13",
    ua: "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Mobile Safari/537.36",
    secChUa: '"Chromium";v="139", "Not;A=Brand";v="99"',
    mobile: "?1",
    platform: '"Android"',
    language: "ar-SA,ar;q=0.9,en-US;q=0.8",
  },
  {
    name: "Chrome 138 · Android 12 (Xiaomi)",
    ua: "Mozilla/5.0 (Linux; Android 12; 2201116SG) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Mobile Safari/537.36",
    secChUa: '"Chromium";v="138", "Not;A=Brand";v="99"',
    mobile: "?1",
    platform: '"Android"',
    language: "en-GB,en;q=0.9",
  },
  // ---- iOS
  {
    name: "Safari · iPhone iOS 18",
    ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
    mobile: "?1",
    platform: '"iOS"',
    language: "en-US,en;q=0.9",
  },
  {
    name: "Chrome iOS · iPhone iOS 17",
    ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/139.0.0.0 Mobile/15E148 Safari/604.1",
    mobile: "?1",
    platform: '"iOS"',
    language: "ar-SA,ar;q=0.9,en;q=0.8",
  },
  {
    name: "Safari · iPad iOS 18",
    ua: "Mozilla/5.0 (iPad; CPU OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
    mobile: "?1",
    platform: '"iOS"',
    language: "en-US,en;q=0.9",
  },
];

/** Uniformly random profile from the pool. */
export function randomDeviceProfile(): DeviceProfile {
  return DEVICE_PROFILES[Math.floor(Math.random() * DEVICE_PROFILES.length)];
}

// Sticky assignment: key = `${slotId}:${sessionEpoch}`.
const assigned = new Map<string, DeviceProfile>();

export function deviceProfileFor(key: string): DeviceProfile {
  let p = assigned.get(key);
  if (!p) {
    p = randomDeviceProfile();
    assigned.set(key, p);
    if (assigned.size > 400) {
      // Trim the oldest entries so long uptimes never bloat memory.
      const keys = Array.from(assigned.keys()).slice(0, 200);
      for (const k of keys) assigned.delete(k);
    }
  }
  return p;
}

export function clearDeviceProfiles(prefix: string): void {
  for (const k of Array.from(assigned.keys())) {
    if (k.startsWith(prefix)) assigned.delete(k);
  }
}

/** Full browser-authentic header set derived from a device profile. */
export function profileHeaders(p: DeviceProfile): Record<string, string> {
  const h: Record<string, string> = {
    "User-Agent": p.ua,
    "Accept-Language": p.language,
    "Sec-Ch-Ua-Mobile": p.mobile,
    "Sec-Ch-Ua-Platform": p.platform,
  };
  if (p.secChUa) h["Sec-Ch-Ua"] = p.secChUa;
  return h;
}
