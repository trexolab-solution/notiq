/**
 * Recovery kit (0.7.0): a clean, printable page holding the vault's recovery key, shown only
 * right after the vault is created (the key is never stored). Pure string building — the dialog
 * (components/vault/RecoveryKitDialog.tsx) previews it and prints / saves it as PDF.
 *
 * Never put the result in localStorage, logs or anywhere persistent.
 */

/** "abcd-efgh ijkl…" → ["ABCD", "EFGH", "IJKL", …] (separators dropped, groups of 4). */
export function groupRecoveryKey(key: string): string[] {
  const clean = key.toUpperCase().replace(/[^0-9A-Z]/g, "");
  const out: string[] = [];
  for (let i = 0; i < clean.length; i += 4) out.push(clean.slice(i, i + 4));
  return out;
}

/** Splits groups into printed lines of `perRow` groups. */
export function keyRows(groups: string[], perRow = 4): string[][] {
  const rows: string[][] = [];
  for (let i = 0; i < groups.length; i += perRow) rows.push(groups.slice(i, i + perRow));
  return rows;
}

/** First 8 hex chars of the vault id, uppercased; "" if it doesn't look like hex. */
export function formatFingerprint(vaultId: string): string {
  const hex = vaultId.replace(/[^0-9a-f]/gi, "").slice(0, 8).toUpperCase();
  return hex.length === 8 ? `${hex.slice(0, 4)} ${hex.slice(4)}` : "";
}

/** Escapes text content (no dynamic value is ever placed in an attribute). */
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export interface RecoveryKitInput {
  recoveryKey: string;
  /** Raw vault id (hex) or an already formatted fingerprint. */
  fingerprint: string;
  createdAt: Date;
}

/** Plain-language instructions printed on the kit (exported for tests and the preview). */
export const KIT_INSTRUCTIONS: string[] = [
  "This recovery key opens your Notiq Secure Vault if you forget your master password. With it you can set a new master password and get back in.",
  "Your master password is NOT on this page. Never write it here or keep it together with this key.",
  "Keep this page offline in a safe place, such as a locked drawer or a safe. Don't photograph it or store it in email or cloud notes.",
  "Anyone who has this key AND a copy of your vault file (vault.nqdb or a Notiq backup) can open your vault. Keep them apart.",
  "Notiq cannot recover your vault for you. If you lose both your master password and this key, your locked notes are gone for good.",
];

export const KIT_HOW_TO_USE =
  "To use it: open Notiq, choose Unlock vault, click “Forgot password?”, type the key above, then choose a new master password.";

export const KIT_CHECKLIST: string[] = [
  "Printed copy stored in a safe place",
  "Vault backup made (Settings → Vault → Backup)",
  "Tested restoring the backup",
];

/** Styles scoped to `.rk-page`; always dark-on-white, independent of the app theme. Every list/heading
 *  style is explicit because the app's CSS reset strips bullets, heading weight and margins. */
const KIT_CSS = `
.rk-page{background:#fff;color:#0f172a;font-family:"Segoe UI",system-ui,-apple-system,sans-serif;font-size:13px;line-height:1.55;max-width:700px;margin:0 auto;padding:4px}
.rk-page *{box-sizing:border-box;margin:0}
.rk-head{display:flex;align-items:flex-end;justify-content:space-between;padding-bottom:12px;border-bottom:3px solid #0f172a}
.rk-logo{font-size:30px;font-weight:800;letter-spacing:-0.8px;line-height:1}
.rk-sub{font-size:12px;font-weight:700;letter-spacing:1.4px;text-transform:uppercase;color:#475569}
.rk-meta{display:flex;gap:40px;margin:14px 0 18px;font-size:11px;letter-spacing:.6px;text-transform:uppercase;color:#64748b}
.rk-meta b{display:block;margin-top:2px;font-size:14px;letter-spacing:0;text-transform:none;color:#0f172a;font-family:Consolas,"Cascadia Mono",ui-monospace,monospace}
.rk-key{border:2px solid #0f172a;border-radius:10px;padding:18px 16px 20px;margin-bottom:20px;text-align:center;background:#f8fafc}
.rk-key-label{font-size:11px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:#475569;margin-bottom:10px}
.rk-row{font-family:Consolas,"Cascadia Mono",ui-monospace,monospace;font-size:22px;font-weight:700;letter-spacing:2px;white-space:nowrap;line-height:1.7}
.rk-row span{display:inline-block;margin:0 10px}
.rk-page h3{font-size:11px;font-weight:800;letter-spacing:1.6px;text-transform:uppercase;color:#475569;margin:0 0 8px;padding-bottom:4px;border-bottom:1px solid #cbd5e1}
.rk-list{list-style:none;padding:0;margin:0 0 6px;counter-reset:rk}
.rk-list li{position:relative;padding-left:28px;margin-bottom:8px;counter-increment:rk}
.rk-list li::before{content:counter(rk);position:absolute;left:0;top:1px;width:18px;height:18px;border-radius:50%;background:#0f172a;color:#fff;font-size:10.5px;font-weight:700;text-align:center;line-height:18px}
.rk-how{margin:12px 0 20px;padding:10px 12px;border:1px solid #cbd5e1;border-radius:6px;background:#f8fafc}
.rk-check{list-style:none;padding:0;margin:0}
.rk-check li{display:flex;gap:10px;align-items:center;margin-bottom:9px}
.rk-box{display:inline-block;width:15px;height:15px;border:1.5px solid #0f172a;border-radius:3px;flex:none}
.rk-foot{margin-top:18px;padding-top:8px;border-top:1px solid #cbd5e1;font-size:10.5px;color:#64748b}
@media print{.rk-page{padding:0}.rk-key,.rk-how{break-inside:avoid}}
`;

/** The whole kit as an HTML fragment (`<style>` + `.rk-page`). Every dynamic value is escaped. */
export function buildRecoveryKitHtml({ recoveryKey, fingerprint, createdAt }: RecoveryKitInput): string {
  const rows = keyRows(groupRecoveryKey(recoveryKey), 5)
    .map((r) => `<div class="rk-row">${r.map((g) => `<span>${esc(g)}</span>`).join("")}</div>`)
    .join("");
  const fp = formatFingerprint(fingerprint) || "—";
  const date = new Intl.DateTimeFormat("en", { dateStyle: "long" }).format(createdAt);
  const li = (items: string[]) => items.map((t) => `<li>${esc(t)}</li>`).join("");
  return `<style>${KIT_CSS}</style>
<div class="rk-page">
  <div class="rk-head"><span class="rk-logo">Notiq</span><span class="rk-sub">Secure Vault Recovery Kit</span></div>
  <div class="rk-meta">
    <div>Created<b>${esc(date)}</b></div>
    <div>Vault fingerprint<b>${esc(fp)}</b></div>
  </div>
  <div class="rk-key">
    <div class="rk-key-label">Recovery key</div>
    ${rows}
  </div>
  <h3>What this is</h3>
  <ul class="rk-list">${li(KIT_INSTRUCTIONS)}</ul>
  <div class="rk-how">${esc(KIT_HOW_TO_USE)}</div>
  <h3>Checklist</h3>
  <ul class="rk-check">${KIT_CHECKLIST.map((t) => `<li><span class="rk-box"></span>${esc(t)}</li>`).join("")}</ul>
  <div class="rk-foot">The fingerprint only identifies which vault this key belongs to; it is not secret and cannot open anything.</div>
</div>`;
}
