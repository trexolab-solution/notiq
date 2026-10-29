import React from "react";
import { ExternalLink, GitFork, Globe } from "lucide-react";
import { APP_NAME, APP_VERSION } from "../../../config/app";
import logoUrl from "../../../assets/logo.png";
import { SettingRow } from "../SettingRow";
import { SettingsGroup, SettingsBlock } from "../SettingsGroup";
import { ABOUT_INDEX, indexProps } from "./sectionIndexes";
import type { SettingMeta } from "../../../lib/settingsIndex";

const m = indexProps(ABOUT_INDEX);

const LinkButton = ({ href, icon, children }: { href: string; icon: React.ReactNode; children: React.ReactNode }) => (
  <a href={href} target="_blank" rel="noopener noreferrer" className="settings-btn settings-link-btn">
    {icon}
    {children}
    <ExternalLink size={12} aria-hidden className="settings-link-ext" />
  </a>
);

export const AboutSection = React.memo(function AboutSection() {
  return (
    <div className="settings-section-body">
      <SettingsGroup id="about.app">
        <SettingsBlock {...m("about.app.info")}>
          <div className="settings-about">
            <img src={logoUrl} alt="" draggable={false} className="settings-about-logo" />
            <div className="settings-about-text">
              <h3 className="settings-about-name">
                {APP_NAME}
                <span className="settings-about-version">Version {APP_VERSION}</span>
              </h3>
              <p className="settings-about-tagline">
                A private, offline-first markdown editor with a password vault, a terminal and optional AI.
              </p>
              <p className="settings-about-legal">
                Made by{" "}
                <a href="https://trexolab.com" target="_blank" rel="noopener noreferrer" className="link-inline">TrexoLab</a>
                {" · "}&copy; {new Date().getFullYear()} TrexoLab. All rights reserved.
              </p>
            </div>
          </div>
        </SettingsBlock>
      </SettingsGroup>

      <SettingsGroup id="about.links" title="Links">
        <SettingRow {...m("about.links.website")}>
          <LinkButton href="https://trexolab.com" icon={<Globe size={14} aria-hidden />}>trexolab.com</LinkButton>
        </SettingRow>
        <SettingRow {...m("about.links.source")}>
          <LinkButton href="https://github.com/trexolab/notiq" icon={<GitFork size={14} aria-hidden />}>GitHub</LinkButton>
        </SettingRow>
      </SettingsGroup>
    </div>
  );
});

/** Every searchable setting this section renders (see lib/settingsIndex.ts). */
export const SETTINGS_INDEX: SettingMeta[] = ABOUT_INDEX;
