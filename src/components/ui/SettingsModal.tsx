import React, { useState } from "react";
import {
  X, Monitor, Type, Keyboard, Info, Terminal, RotateCcw, Sparkles, Settings as SettingsIcon,
} from "lucide-react";
import { useAppStore } from "../../store";
import { Modal } from "./Modal";
import { GeneralSection }          from "./settings/GeneralSection";
import { EditorSettingsSection }   from "./settings/EditorSettingsSection";
import { TerminalSettingsSection } from "./settings/TerminalSettingsSection";
import { AppearanceSection }        from "./settings/AppearanceSection";
import { AISettingsSection }        from "./settings/AISettingsSection";
import { ShortcutsSection }         from "./settings/ShortcutsSection";
import { AboutSection }             from "./settings/AboutSection";

interface SettingsModalProps {
  onClose: () => void;
  initialSection?: Section;
  /** Opens the AI onboarding wizard (from the AI section's "Run setup again"). */
  onRunAIOnboarding?: () => void;
}

type Section = "general" | "editor" | "ai" | "terminal" | "appearance" | "shortcuts" | "about";

const SECTIONS: { id: Section; label: string; icon: React.ReactNode }[] = [
  { id: "general",    label: "General",    icon: <SettingsIcon size={15} /> },
  { id: "editor",     label: "Editor",     icon: <Type         size={15} /> },
  { id: "ai",         label: "AI",         icon: <Sparkles     size={15} /> },
  { id: "terminal",   label: "Terminal",   icon: <Terminal     size={15} /> },
  { id: "appearance", label: "Appearance", icon: <Monitor      size={15} /> },
  { id: "shortcuts",  label: "Shortcuts",  icon: <Keyboard     size={15} /> },
  { id: "about",      label: "About",      icon: <Info         size={15} /> },
];

export function SettingsModal({ onClose, initialSection = "general", onRunAIOnboarding }: SettingsModalProps) {
  const [section, setSection] = useState<Section>(initialSection);
  const resetPreferences = useAppStore((s) => s.resetPreferences);

  const handleResetDefaults = () => {
    if (window.confirm("Restore all editor and terminal settings to their default values? This cannot be undone.")) {
      resetPreferences();
    }
  };

  return (
    <Modal onClose={onClose}>
      <div
        className="flex overflow-hidden rounded-xl"
        style={{
          width: 720,
          maxWidth: "calc(100vw - 32px)",
          height: 580,
          maxHeight: "calc(100vh - 64px)",
          background: "var(--color-bg-secondary)",
          border: "1px solid var(--color-border)",
          boxShadow: "0 24px 64px rgba(0,0,0,0.5)",
        }}
      >
        {/* ── Left nav ── */}
        <div
          className="flex flex-col gap-0.5 p-3 shrink-0"
          style={{ width: 160, background: "var(--color-bg)", borderRight: "1px solid var(--color-border)" }}
        >
          <p className="text-xs font-bold uppercase tracking-wider px-2 py-1.5 select-none"
            style={{ color: "var(--color-text-muted)" }}>
            Settings
          </p>
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              onClick={() => setSection(s.id)}
              className="flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-sm cursor-pointer transition-colors text-left w-full"
              style={{
                background: section === s.id
                  ? "color-mix(in srgb, var(--color-primary) 10%, var(--color-bg-tertiary))"
                  : "transparent",
                color: section === s.id ? "var(--color-primary)" : "var(--color-text-muted)",
                fontWeight: section === s.id ? 600 : 400,
              }}
            >
              {s.icon}
              {s.label}
            </button>
          ))}

          <div className="flex-1" />
          <button
            onClick={handleResetDefaults}
            className="btn-text-hover flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-lg text-xs"
          >
            <RotateCcw size={13} /> Restore defaults
          </button>
          <button
            onClick={onClose}
            className="btn-text-hover flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-lg text-xs"
          >
            <X size={13} /> Close
          </button>
        </div>

        {/* ── Content ── */}
        <div className="flex-1 overflow-y-auto p-6" style={{ color: "var(--color-text)" }}>
          {section === "general"    && <GeneralSection />}
          {section === "editor"     && <EditorSettingsSection />}
          {section === "ai"         && <AISettingsSection onRunSetup={onRunAIOnboarding} />}
          {section === "terminal"   && <TerminalSettingsSection />}
          {section === "appearance" && <AppearanceSection />}
          {section === "shortcuts"  && <ShortcutsSection />}
          {section === "about"      && <AboutSection />}
        </div>
      </div>
    </Modal>
  );
}
