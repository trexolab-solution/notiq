import React from "react";
import { ALL_SHORTCUTS, SHORTCUT_GROUPS } from "./settingsConstants";

export const ShortcutsSection = React.memo(function ShortcutsSection() {
  return (
    <div className="flex flex-col gap-4">
      <h2 className="text-base font-semibold text-[var(--color-text)]">Keyboard Shortcuts</h2>
      {SHORTCUT_GROUPS.map((grp) => {
        const rows = ALL_SHORTCUTS.filter((s) => s.section === grp);
        if (rows.length === 0) return null;
        return (
          <div key={grp}>
            <p className="text-xs font-bold uppercase tracking-wider mb-2 text-[var(--color-text-muted)]">
              {grp}
            </p>
            <div className="rounded-lg overflow-hidden border border-[var(--color-border)]">
              {rows.map((s) => (
                <div
                  key={s.key + s.label}
                  className="flex items-center justify-between px-3 py-2 bg-[var(--color-bg)] border-b border-[var(--color-border)] last:border-b-0"
                >
                  <span className="text-sm text-[var(--color-text)]">{s.label}</span>
                  <kbd className="font-mono text-xs px-2 py-0.5 rounded bg-[var(--color-bg-tertiary)] border border-[var(--color-border)] text-[var(--color-text-muted)]">
                    {s.key}
                  </kbd>
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
});
