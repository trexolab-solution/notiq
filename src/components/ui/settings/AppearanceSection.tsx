import React from "react";
import { useAppStore } from "../../../store";
import { THEMES } from "../../../lib/themes";
import type { ThemeId } from "../../../types";

export const AppearanceSection = React.memo(function AppearanceSection() {
  const themeId  = useAppStore((s) => s.themeId);
  const setTheme = useAppStore((s) => s.setTheme);

  return (
    <div className="flex flex-col gap-4">
      <h2 className="text-base font-semibold" style={{ color: "var(--color-text)" }}>Appearance</h2>
      <p className="text-xs" style={{ color: "var(--color-text-muted)" }}>
        Choose a theme for the entire application.
      </p>
      <div className="grid grid-cols-2 gap-2">
        {(Object.keys(THEMES) as ThemeId[]).map((id) => {
          const t = THEMES[id];
          const active = themeId === id;
          return (
            <button
              key={id}
              onClick={() => setTheme(id)}
              className="flex items-center gap-3 p-3 rounded-xl border cursor-pointer text-left transition-all"
              style={{
                background: active
                  ? "color-mix(in srgb, var(--color-primary) 8%, var(--color-bg-tertiary))"
                  : "var(--color-bg)",
                borderColor: active ? "var(--color-primary)" : "var(--color-border)",
              }}
            >
              <div className="flex gap-1 shrink-0">
                {[t.colors.bg, t.colors.primary, t.colors.accent].map((c, i) => (
                  <div
                    key={i}
                    className="w-4 h-4 rounded-full border"
                    style={{ background: c, borderColor: "rgba(0,0,0,0.1)" }}
                  />
                ))}
              </div>
              <div className="flex-1 min-w-0">
                <div
                  className="text-sm font-medium"
                  style={{ color: active ? "var(--color-primary)" : "var(--color-text)" }}
                >
                  {t.label}
                </div>
              </div>
              {active && (
                <span className="text-xs font-bold" style={{ color: "var(--color-primary)" }}>✓</span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
});
