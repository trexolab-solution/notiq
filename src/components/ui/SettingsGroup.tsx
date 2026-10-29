import React from "react";
import { matchesQuery, useSettingsQuery } from "../settings/settingsFilter";
import { settingDomId } from "../../lib/settingsIndex";

/**
 * A titled group of settings inside a section: a card (bg-secondary, 1px border, hairlines between rows). While the Settings search is filtering, a group whose
 * rows are all hidden disappears too (see `.settings-filtering` in styles/settings.css).
 */
export const SettingsGroup = React.memo(function SettingsGroup({
  id, title, description, children,
}: { id?: string; title?: string; description?: string; children: React.ReactNode }) {
  return (
    <section id={id ? settingDomId(id) : undefined} className="settings-group" data-settings-group>
      {(title || description) && (
        <header className="settings-group-head">
          {title && <h3 className="settings-group-title">{title}</h3>}
          {description && <p className="settings-group-desc">{description}</p>}
        </header>
      )}
      <div className="settings-group-body">{children}</div>
    </section>
  );
});

/**
 * Wraps a custom (non-row) piece of settings UI — a card, a table, a status panel — so it takes part in
 * search: it is shown only when it matches the query. `label`/`keywords` are what gets matched.
 */
export const SettingsBlock = React.memo(function SettingsBlock({
  id, label, description, keywords, children, className, flush,
}: {
  id: string; label: string; description?: string; keywords?: string[]; children: React.ReactNode; className?: string;
  /** Inside a SettingsGroup: drop the default block padding (the content draws its own edges). */
  flush?: boolean;
}) {
  const query = useSettingsQuery();
  if (!matchesQuery(query, { label, description, keywords })) return null;
  return (
    <div id={settingDomId(id)} data-setting-block data-flush={flush || undefined} className={className}>
      {children}
    </div>
  );
});
