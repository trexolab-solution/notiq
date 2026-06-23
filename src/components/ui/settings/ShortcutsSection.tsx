import React from "react";
import { ALL_SHORTCUTS, SHORTCUT_GROUPS } from "./settingsConstants";

export const ShortcutsSection = React.memo(function ShortcutsSection() {
  return (
    <div className="flex flex-col gap-4">
      <h2 className="text-base font-semibold" style={{ color: "var(--color-text)" }}>Keyboard Shortcuts</h2>
      {SHORTCUT_GROUPS.map((grp) => {
        const rows = ALL_SHORTCUTS.filter((s) => s.section === grp);
        if (rows.length === 0) return null;
        return (
          <div key={grp}>
            <p
              className="text-xs font-bold uppercase tracking-wider mb-2"
              style={{ color: "var(--color-text-muted)" }}
            >
              {grp}
            </p>
            <div className="rounded-lg overflow-hidden" style={{ border: "1px solid var(--color-border)" }}>
              {rows.map((s, i, arr) => (
                <div
                  key={s.key + s.label}
                  className="flex items-center justify-between px-3 py-2"
                  style={{
                    borderBottom: i < arr.length - 1 ? "1px solid var(--color-border)" : "none",
                    background: "var(--color-bg)",
                  }}
                >
                  <span className="text-sm" style={{ color: "var(--color-text)" }}>{s.label}</span>
                  <kbd
                    className="font-mono text-xs px-2 py-0.5 rounded"
                    style={{
                      background: "var(--color-bg-tertiary)",
                      border: "1px solid var(--color-border)",
                      color: "var(--color-text-muted)",
                    }}
                  >
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
