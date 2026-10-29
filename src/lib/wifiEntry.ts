/** Pure helpers for the Wi-Fi vault entry. */

/** Escapes a value for the `WIFI:` QR payload: backslash, semicolon, comma, colon and double quote. */
export function escapeWifi(s: string): string {
  return s.replace(/([\\;,:"])/g, "\\$1");
}

/**
 * The text a Wi-Fi QR code encodes (ZXing / Android / iOS format):
 * `WIFI:T:WPA;S:<ssid>;P:<password>;H:true;;`. WPA2 and WPA3 both use `T:WPA` (what phones expect);
 * an open network uses `T:nopass` and no password. Null while there's no SSID.
 */
export function wifiQrText(f: { ssid?: string; password?: string; security?: string; hidden?: string }): string | null {
  const ssid = f.ssid ?? "";
  if (!ssid) return null;
  const sec = f.security || "WPA2";
  const t = sec === "Open" ? "nopass" : sec === "WEP" ? "WEP" : "WPA";
  let out = `WIFI:T:${t};S:${escapeWifi(ssid)};`;
  if (t !== "nopass" && f.password) out += `P:${escapeWifi(f.password)};`;
  if (f.hidden === "true") out += "H:true;";
  return `${out};`;
}
