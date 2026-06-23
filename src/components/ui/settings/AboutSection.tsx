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
    <div style={{ display: "flex", flexDirection: "column", justifyContent: "space-between", minHeight: "100%" }}>

      {/* ── Hero ── */}
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center", padding: "32px 24px 24px" }}>
        <div style={{ position: "relative", marginBottom: 20 }}>
          <div style={{
            position: "absolute", inset: -28, borderRadius: "50%",
            background: "var(--color-primary)", opacity: 0.10, filter: "blur(36px)", pointerEvents: "none",
          }} />
          <div style={{
            position: "absolute", inset: -12, borderRadius: "50%",
            background: "var(--color-primary)", opacity: 0.06, filter: "blur(16px)", pointerEvents: "none",
          }} />
          <img
            src={logoUrl}
            alt={APP_NAME}
            draggable={false}
            style={{
              position: "relative",
              width: 110,
              height: 110,
              borderRadius: 26,
              objectFit: "cover",
              boxShadow: "0 12px 40px rgba(0,0,0,0.35), 0 0 0 1px rgba(255,255,255,0.06)",
            }}
          />
        </div>

        <h2 style={{
          fontSize: 24, fontWeight: 800, letterSpacing: "-0.02em",
          color: "var(--color-text)", margin: "0 0 6px",
        }}>
          {APP_NAME}
        </h2>

        <span style={{
          display: "inline-block",
          fontSize: 10, fontWeight: 700, textTransform: "uppercase",
          letterSpacing: "0.08em",
          padding: "3px 12px", borderRadius: 99,
          background: "color-mix(in srgb, var(--color-primary) 12%, transparent)",
          color: "var(--color-primary)",
          border: "1px solid color-mix(in srgb, var(--color-primary) 20%, transparent)",
          marginBottom: 14,
        }}>
          v{APP_VERSION}
        </span>

        <p style={{
          fontSize: 13, lineHeight: 1.55, maxWidth: 300, margin: 0,
          color: "var(--color-text-muted)",
        }}>
          A powerful, privacy-first markdown editor built for speed, simplicity, and deep focus.
        </p>
      </div>

      {/* ── Feature cards ── */}
      <div style={{
        display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 1,
        borderRadius: 10, overflow: "hidden", margin: "0 16px",
        background: "var(--color-border)",
        border: "1px solid var(--color-border)",
      }}>
        {FEATURE_CARDS.map((f) => (
          <div
            key={f.label}
            style={{
              display: "flex", flexDirection: "column", alignItems: "center",
              gap: 5, padding: "14px 4px",
              background: "var(--color-bg)",
            }}
          >
            <div style={{
              display: "flex", alignItems: "center", justifyContent: "center",
              width: 34, height: 34, borderRadius: 8,
              background: "color-mix(in srgb, var(--color-primary) 10%, transparent)",
              color: "var(--color-primary)",
            }}>
              {f.icon}
            </div>
            <div style={{ textAlign: "center" }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: "var(--color-text)" }}>{f.label}</div>
              <div style={{ fontSize: 9.5, color: "var(--color-text-muted)", opacity: 0.6 }}>{f.sub}</div>
            </div>
          </div>
        ))}
      </div>

      {/* ── Footer ── */}
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 14, padding: "24px 16px 8px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
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
              <ExternalLink size={8} style={{ opacity: 0.4 }} />
            </a>
          ))}
        </div>

        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 3 }}>
          <p style={{
            display: "flex", alignItems: "center", gap: 4,
            fontSize: 11, margin: 0, color: "var(--color-text-muted)",
          }}>
            Made with <Heart size={10} style={{ color: "var(--color-danger)", fill: "var(--color-danger)" }} /> by
            <a
              href="https://trexolab.com"
              target="_blank"
              rel="noopener noreferrer"
              className="link-inline"
            >
              TrexoLab
            </a>
          </p>
          <p style={{ fontSize: 10, margin: 0, color: "var(--color-text-muted)", opacity: 0.45 }}>
            &copy; {new Date().getFullYear()} TrexoLab. All rights reserved.
          </p>
        </div>
      </div>
    </div>
  );
});
