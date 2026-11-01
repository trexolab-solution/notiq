import type { ReactNode } from "react";

/**
 * Letter avatar: the first letter (or digit) of a name in a rounded, softly tinted tile. Used for
 * vault entries and sites wherever there is no icon to show (Notiq never fetches favicons, so a site
 * is never contacted just to draw its logo). The tint is picked from the name, so the same entry or
 * site always gets the same colour, and only theme tokens are used, so every theme is covered.
 */

const TONES = ["primary", "accent", "success", "warning"] as const;
export type AvatarTone = (typeof TONES)[number];

/** `https://www.example.com/x` → "E"; "  42 Bank" → "4"; nothing usable → "?". */
export function initialOf(name: string): string {
  const s = name.trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").replace(/^www\./i, "");
  const m = s.match(/[\p{L}\p{N}]/u);
  return m ? m[0].toLocaleUpperCase() : "?";
}

/** Stable tint for a name (case-insensitive), so a row keeps its colour across windows and sessions. */
export function avatarTone(name: string): AvatarTone {
  let h = 0;
  for (const ch of name.trim().toLowerCase()) h = (h * 31 + ch.codePointAt(0)!) >>> 0;
  return TONES[h % TONES.length];
}

export function Avatar({ name, size = 28, badge, className = "" }: {
  name: string;
  /** Edge length in px. */
  size?: number;
  /** Small icon in the bottom-right corner, e.g. what kind of entry this is. */
  badge?: ReactNode;
  className?: string;
}) {
  return (
    <span aria-hidden className={`nq-avatar nq-avatar--${avatarTone(name)} ${className}`}
          style={{ width: size, height: size, fontSize: Math.round(size * 0.46) }}>
      {initialOf(name)}
      {badge && <span className="nq-avatar-badge">{badge}</span>}
    </span>
  );
}
