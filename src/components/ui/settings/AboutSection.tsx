import React from "react";
import {
  Zap, Shield, BrainCircuit, PenTool, ExternalLink, Heart, Globe, GitFork,
} from "lucide-react";
import { APP_NAME, APP_VERSION } from "../../../config/app";
import logoUrl from "../../../assets/logo.png";

const FEATURE_CARDS = [
  { icon: <Zap          size={17} />, label: "Fast",    sub: "Instant" },
  { icon: <Shield       size={17} />, label: "Private", sub: "Offline" },
  { icon: <BrainCircuit size={17} />, label: "Graph",   sub: "Linked" },
  { icon: <PenTool      size={17} />, label: "Draw",    sub: "Canvas" },
] as const;

const LINKS = [
  { href: "https://trexolab.com",              icon: <Globe   size={12} />, label: "Website" },
  { href: "https://github.com/trexolab/notiq", icon: <GitFork size={12} />, label: "GitHub" },
] as const;

export const AboutSection = React.memo(function AboutSection() {
  return (
    <div className="flex flex-col justify-between min-h-full">

      {/* ── Hero ── */}
      <div className="flex flex-col items-center text-center pt-8 px-6 pb-6">
        <div className="relative mb-5">
          <div className="absolute inset-[-28px] rounded-full bg-[var(--color-primary)] opacity-10 blur-[36px] pointer-events-none" />
          <div className="absolute inset-[-12px] rounded-full bg-[var(--color-primary)] opacity-[0.06] blur-[16px] pointer-events-none" />
          <img
            src={logoUrl}
            alt={APP_NAME}
            draggable={false}
            className="relative w-[110px] h-[110px] rounded-[26px] object-cover"
            style={{ boxShadow: "0 12px 40px rgba(0,0,0,0.35), 0 0 0 1px rgba(255,255,255,0.06)" }}
          />
        </div>

        <h2 className="text-[24px] font-extrabold tracking-[-0.02em] text-[var(--color-text)] m-0 mb-1.5">
          {APP_NAME}
        </h2>

        <span
          className="inline-block text-[10px] font-bold uppercase tracking-[0.08em] py-[3px] px-3 rounded-full text-[var(--color-primary)] border mb-3.5"
          style={{
            background: "color-mix(in srgb, var(--color-primary) 12%, transparent)",
            borderColor: "color-mix(in srgb, var(--color-primary) 20%, transparent)",
          }}
        >
          v{APP_VERSION}
        </span>

        <p className="text-[13px] leading-[1.55] max-w-[300px] m-0 text-[var(--color-text-muted)]">
          A powerful, privacy-first markdown editor built for speed, simplicity, and deep focus.
        </p>
      </div>

      {/* ── Feature cards ── */}
      <div className="grid grid-cols-4 gap-px rounded-[10px] overflow-hidden mx-4 bg-[var(--color-border)] border border-[var(--color-border)]">
        {FEATURE_CARDS.map((f) => (
          <div
            key={f.label}
            className="flex flex-col items-center gap-[5px] py-[14px] px-1 bg-[var(--color-bg)]"
          >
            <div
              className="flex items-center justify-center w-[34px] h-[34px] rounded-lg text-[var(--color-primary)]"
              style={{ background: "color-mix(in srgb, var(--color-primary) 10%, transparent)" }}
            >
              {f.icon}
            </div>
            <div className="text-center">
              <div className="text-[11px] font-semibold text-[var(--color-text)]">{f.label}</div>
              <div className="text-[9.5px] text-[var(--color-text-muted)] opacity-60">{f.sub}</div>
            </div>
          </div>
        ))}
      </div>

      {/* ── Footer ── */}
      <div className="flex flex-col items-center gap-3.5 pt-6 px-4 pb-2">
        <div className="flex items-center gap-2">
          {LINKS.map((link) => (
            <a
              key={link.label}
              href={link.href}
              target="_blank"
              rel="noopener noreferrer"
              className="link-pill"
            >
              {link.icon}
              {link.label}
              <ExternalLink size={8} className="opacity-40" />
            </a>
          ))}
        </div>

        <div className="flex flex-col items-center gap-[3px]">
          <p className="flex items-center gap-1 text-[11px] m-0 text-[var(--color-text-muted)]">
            Made with <Heart size={10} className="text-[var(--color-danger)] fill-[var(--color-danger)]" /> by
            <a
              href="https://trexolab.com"
              target="_blank"
              rel="noopener noreferrer"
              className="link-inline"
            >
              TrexoLab
            </a>
          </p>
          <p className="text-[10px] m-0 text-[var(--color-text-muted)] opacity-45">
            &copy; {new Date().getFullYear()} TrexoLab. All rights reserved.
          </p>
        </div>
      </div>
    </div>
  );
});
