import React from "react";
import {
  Settings as SettingsIcon, Type, Sparkles, Lock, Terminal, Monitor, Keyboard, Download, Info, type LucideIcon,
} from "lucide-react";
import { SECTION_LABELS, SECTION_ORDER, type SectionId } from "../../lib/settingsIndex";

export const SECTION_ICONS: Record<SectionId, LucideIcon> = {
  general: SettingsIcon, editor: Type, ai: Sparkles, vault: Lock, terminal: Terminal,
  appearance: Monitor, shortcuts: Keyboard, updates: Download, about: Info,
};

interface Props {
  active: SectionId;
  /** While searching: matches per section (sections with 0 are dimmed). Null when not searching. */
  counts: Partial<Record<SectionId, number>> | null;
  onSelect: (id: SectionId) => void;
}

/**
 * Section list of the Settings page. A vertical list beside the content on wide panes; a scrollable row of
 * chips above it on narrow ones (pure CSS, see `.settings-nav` in styles/settings.css).
 */
export const SettingsNav = React.memo(function SettingsNav({ active, counts, onSelect }: Props) {
  return (
    <nav className="settings-nav" aria-label="Settings sections">
      <ul className="settings-nav-list">
        {SECTION_ORDER.map((id) => {
          const Icon = SECTION_ICONS[id];
          const count = counts?.[id];
          const empty = counts !== null && !count;
          return (
            <li key={id}>
              <a
                href={`#settings-section-${id}`}
                className="settings-nav-item"
                aria-current={active === id ? "location" : undefined}
                data-empty={empty || undefined}
                onClick={(e) => { e.preventDefault(); onSelect(id); }}
              >
                <Icon size={15} aria-hidden />
                <span className="settings-nav-label">{SECTION_LABELS[id]}</span>
                {counts !== null && !empty && <span className="settings-nav-count">{count}</span>}
              </a>
            </li>
          );
        })}
      </ul>
    </nav>
  );
});
