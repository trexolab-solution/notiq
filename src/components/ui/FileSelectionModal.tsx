import { useState, useMemo, useRef, useEffect } from "react";
import { X, FolderOpen, Search, CheckSquare, Square, FileText, FileCode, FileType, Filter } from "lucide-react";
import type { FileEntry } from "../../lib/fileOps";
import { useEscapeKey } from "../../hooks/useEscapeKey";

interface FileSelectionModalProps {
  files: FileEntry[];
  folderPath?: string;
  onConfirm: (selected: FileEntry[]) => void;
  onCancel: () => void;
}

// ── Extension helpers ────────────────────────────────────────────────────────
const EXT_LABEL: Record<string, string> = {
  ".md": "MD", ".markdown": "MD", ".txt": "TXT",
  ".ts": "TS", ".tsx": "TSX", ".js": "JS", ".jsx": "JSX",
  ".json": "JSON", ".yaml": "YAML", ".yml": "YAML", ".toml": "TOML",
  ".html": "HTML", ".htm": "HTML", ".css": "CSS", ".scss": "SCSS",
  ".py": "PY", ".go": "GO", ".rs": "RS", ".java": "JAVA",
  ".cpp": "CPP", ".c": "C", ".h": "H", ".cs": "C#",
  ".sh": "SH", ".bash": "SH", ".zsh": "SH", ".sql": "SQL",
  ".rb": "RB", ".php": "PHP", ".swift": "SWIFT", ".kt": "KT",
  ".lua": "LUA", ".dart": "DART",
};

const EXT_COLORS: Record<string, string> = {
  MD: "#61afef", TXT: "#98c379", TS: "#3178c6", TSX: "#3178c6",
  JS: "#f0db4f", JSX: "#f0db4f", JSON: "#cbcb41", PY: "#3776ab",
  GO: "#00add8", RS: "#dea584", JAVA: "#b07219", CSS: "#563d7c",
  SCSS: "#c6538c", HTML: "#e34c26", SH: "#89e051", SQL: "#e38c00",
  RB: "#701516", PHP: "#4f5d95", SWIFT: "#ffac45", KT: "#A97BFF",
};

type FileGroup = "docs" | "code" | "config" | "other";
const DOC_EXTS   = new Set(["MD", "TXT", "MARKDOWN"]);
const CODE_EXTS  = new Set(["TS","TSX","JS","JSX","PY","GO","RS","JAVA","CPP","C","H","CS","SH","BASH","ZSH","RB","PHP","SWIFT","KT","LUA","DART","SQL","CSS","SCSS","HTML","HTM"]);
const CONF_EXTS  = new Set(["JSON","YAML","YML","TOML"]);

function getGroup(badge: string): FileGroup {
  if (DOC_EXTS.has(badge)) return "docs";
  if (CODE_EXTS.has(badge)) return "code";
  if (CONF_EXTS.has(badge)) return "config";
  return "other";
}

function fileInfo(filePath: string, folderPath?: string) {
  const normalized = filePath.replace(/\\/g, "/");
  const fileName   = normalized.split("/").pop() ?? normalized;
  const dotIdx     = fileName.lastIndexOf(".");
  const ext        = dotIdx > 0 ? fileName.slice(dotIdx).toLowerCase() : "";
  const rawBadge   = EXT_LABEL[ext] ?? ext.slice(1).toUpperCase().slice(0, 5);
  const badge      = rawBadge || "?";

  let subdir = "";
  if (folderPath) {
    const root = folderPath.replace(/\\/g, "/");
    const rel  = normalized.startsWith(root) ? normalized.slice(root.length) : normalized;
    const parts = rel.replace(/^\//, "").split("/");
    if (parts.length > 1) subdir = parts.slice(0, -1).join("/");
  }

  return { fileName, ext, badge, subdir, group: getGroup(badge) };
}

// ── Component ────────────────────────────────────────────────────────────────
export function FileSelectionModal({ files, folderPath, onConfirm, onCancel }: FileSelectionModalProps) {
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(files.map((f) => f.path)),
  );
  const [search, setSearch]           = useState("");
  const [filterGroup, setFilterGroup] = useState<FileGroup | "all">("all");
  const searchRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  // Auto-focus search on open
  useEffect(() => { searchRef.current?.focus(); }, []);

  // Keyboard: Escape closes; Ctrl/Cmd+Enter confirms the current selection.
  useEscapeKey(onCancel);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && selected.size > 0) {
        onConfirm(files.filter((f) => selected.has(f.path)));
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onConfirm, files, selected]);

  // File analysis
  const fileInfos = useMemo(
    () => files.map((f) => ({ ...f, ...fileInfo(f.path, folderPath) })),
    [files, folderPath],
  );

  // Group counts
  const groupCounts = useMemo(() => {
    const counts = { all: files.length, docs: 0, code: 0, config: 0, other: 0 };
    fileInfos.forEach((f) => { counts[f.group]++; });
    return counts;
  }, [fileInfos, files.length]);

  // Filtered list
  const filtered = useMemo(() => {
    let list = fileInfos;
    if (filterGroup !== "all") list = list.filter((f) => f.group === filterGroup);
    if (search) {
      const q = search.toLowerCase();
      list = list.filter((f) =>
        f.fileName.toLowerCase().includes(q) ||
        f.subdir.toLowerCase().includes(q) ||
        f.badge.toLowerCase().includes(q)
      );
    }
    return list;
  }, [fileInfos, filterGroup, search]);

  const allFiltered   = filtered.every((f) => selected.has(f.path));
  const noneSelected  = selected.size === 0;

  const toggleAll = () => {
    if (allFiltered) {
      // Deselect filtered files only
      setSelected((prev) => {
        const next = new Set(prev);
        filtered.forEach((f) => next.delete(f.path));
        return next;
      });
    } else {
      // Select all filtered
      setSelected((prev) => {
        const next = new Set(prev);
        filtered.forEach((f) => next.add(f.path));
        return next;
      });
    }
  };

  const toggle = (path: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(path) ? next.delete(path) : next.add(path);
      return next;
    });

  const folderName = folderPath?.replace(/\\/g, "/").split("/").pop() ?? "Folder";

  const filterButtons: { key: FileGroup | "all"; label: string; icon: React.ReactNode }[] = [
    { key: "all",    label: "All",    icon: <Filter size={11} /> },
    { key: "docs",   label: "Docs",   icon: <FileText size={11} /> },
    { key: "code",   label: "Code",   icon: <FileCode size={11} /> },
    { key: "config", label: "Config", icon: <FileType size={11} /> },
  ];

  return (
    <div
      onClick={(e) => e.target === e.currentTarget && onCancel()}
      style={{
        position: "fixed", inset: 0, zIndex: 9000,
        background: "rgba(0,0,0,0.6)", backdropFilter: "blur(8px)",
        display: "flex", alignItems: "center", justifyContent: "center",
        animation: "fsel-overlay-in 0.15s ease-out",
      }}
    >
      <style>{`
        @keyframes fsel-overlay-in { from { opacity: 0; } }
        @keyframes fsel-dialog-in {
          from { opacity: 0; transform: scale(0.96) translateY(8px); }
          to   { opacity: 1; transform: scale(1) translateY(0); }
        }
        .fsel-row:hover { background: var(--color-bg-tertiary) !important; }
        .fsel-row.is-selected:hover {
          background: color-mix(in srgb, var(--color-primary) 14%, transparent) !important;
        }
      `}</style>

      <div
        ref={dialogRef}
        style={{
          width: 580, maxHeight: "82vh",
          background: "var(--color-bg)",
          border: "1px solid var(--color-border)",
          borderRadius: 14,
          boxShadow: "0 32px 64px rgba(0,0,0,0.5), 0 8px 24px rgba(0,0,0,0.3), 0 0 0 1px rgba(255,255,255,0.03) inset",
          display: "flex", flexDirection: "column", overflow: "hidden",
          animation: "fsel-dialog-in 0.2s ease-out",
        }}
      >

        {/* ── Header ── */}
        <div style={{
          padding: "16px 20px 14px", borderBottom: "1px solid var(--color-border)",
          background: "var(--color-bg-secondary)",
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <div style={{
              width: 36, height: 36, borderRadius: 10, flexShrink: 0,
              background: "color-mix(in srgb, var(--color-primary) 12%, var(--color-bg-tertiary))",
              display: "flex", alignItems: "center", justifyContent: "center",
            }}>
              <FolderOpen size={18} style={{ color: "var(--color-primary)" }} />
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: "var(--color-text)", letterSpacing: "-0.01em" }}>
                {folderName}
              </div>
              {folderPath && (
                <div style={{
                  fontSize: 11, color: "var(--color-text-muted)", marginTop: 2,
                  overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                  direction: "rtl", textAlign: "left", fontFamily: "monospace",
                }}>
                  {folderPath}
                </div>
              )}
            </div>
            <span style={{
              fontSize: 11, fontWeight: 600,
              color: "var(--color-primary)",
              background: "color-mix(in srgb, var(--color-primary) 10%, var(--color-bg-tertiary))",
              border: "1px solid color-mix(in srgb, var(--color-primary) 20%, var(--color-border))",
              padding: "3px 10px", borderRadius: 12, flexShrink: 0,
            }}>
              {files.length} file{files.length !== 1 ? "s" : ""}
            </span>
            <button
              onClick={onCancel}
              style={{
                width: 28, height: 28, borderRadius: 7, border: "1px solid var(--color-border)",
                background: "transparent", cursor: "pointer", flexShrink: 0,
                display: "flex", alignItems: "center", justifyContent: "center",
                color: "var(--color-text-muted)", transition: "all 0.1s",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = "var(--color-bg-tertiary)";
                e.currentTarget.style.color = "var(--color-text)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = "transparent";
                e.currentTarget.style.color = "var(--color-text-muted)";
              }}
            >
              <X size={13} />
            </button>
          </div>

          {/* ── Search bar ── */}
          <div style={{
            marginTop: 12, position: "relative",
          }}>
            <Search
              size={13}
              style={{
                position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)",
                color: "var(--color-text-muted)", pointerEvents: "none",
              }}
            />
            <input
              ref={searchRef}
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search files..."
              style={{
                width: "100%", height: 32, borderRadius: 8,
                border: "1px solid var(--color-border)",
                background: "var(--color-bg)",
                color: "var(--color-text)",
                fontSize: 12, paddingLeft: 30, paddingRight: 10,
                outline: "none", transition: "border-color 0.12s",
              }}
              onFocus={(e) => (e.currentTarget.style.borderColor = "var(--color-primary)")}
              onBlur={(e) => (e.currentTarget.style.borderColor = "var(--color-border)")}
            />
          </div>

          {/* ── Type filter tabs ── */}
          <div style={{ display: "flex", gap: 4, marginTop: 10 }}>
            {filterButtons.map(({ key, label, icon }) => {
              const count = groupCounts[key];
              if (key !== "all" && count === 0) return null;
              const isActive = filterGroup === key;
              return (
                <button
                  key={key}
                  onClick={() => setFilterGroup(key)}
                  style={{
                    display: "flex", alignItems: "center", gap: 4,
                    padding: "4px 10px", borderRadius: 7, fontSize: 11, fontWeight: 500,
                    border: "1px solid",
                    borderColor: isActive
                      ? "color-mix(in srgb, var(--color-primary) 40%, var(--color-border))"
                      : "var(--color-border)",
                    background: isActive
                      ? "color-mix(in srgb, var(--color-primary) 10%, var(--color-bg-tertiary))"
                      : "var(--color-bg)",
                    color: isActive ? "var(--color-primary)" : "var(--color-text-muted)",
                    cursor: "pointer", transition: "all 0.1s",
                  }}
                >
                  {icon}
                  {label}
                  <span style={{
                    fontSize: 10, fontWeight: 600, opacity: 0.7,
                    marginLeft: 1,
                  }}>
                    {count}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        {/* ── Select-all row ── */}
        <div style={{
          padding: "6px 20px", borderBottom: "1px solid var(--color-border)",
          display: "flex", alignItems: "center", justifyContent: "space-between",
          background: "var(--color-bg-secondary)",
        }}>
          <button
            onClick={toggleAll}
            style={{
              display: "flex", alignItems: "center", gap: 6,
              background: "none", border: "none", cursor: "pointer",
              color: allFiltered ? "var(--color-primary)" : "var(--color-text-muted)",
              fontSize: 11, fontWeight: 600, padding: "2px 0",
            }}
          >
            {allFiltered
              ? <CheckSquare size={12} style={{ color: "var(--color-primary)" }} />
              : <Square      size={12} />
            }
            {allFiltered ? "Deselect shown" : "Select shown"}
          </button>
          <span style={{ fontSize: 11, color: "var(--color-text-muted)", fontWeight: 500 }}>
            {selected.size} of {files.length} selected
            {filtered.length !== files.length && (
              <span style={{ opacity: 0.6 }}>{" "}· showing {filtered.length}</span>
            )}
          </span>
        </div>

        {/* ── File list ── */}
        <div style={{ flex: 1, overflowY: "auto", padding: "4px 8px" }}>
          {filtered.length === 0 ? (
            <div style={{
              padding: "32px 16px", textAlign: "center",
              color: "var(--color-text-muted)", fontSize: 12,
            }}>
              {search ? `No files match "${search}"` : "No files in this category"}
            </div>
          ) : (
            filtered.map((f) => {
              const isSel = selected.has(f.path);
              const badgeColor = EXT_COLORS[f.badge] ?? "var(--color-text-muted)";

              return (
                <div
                  key={f.path}
                  className={`fsel-row${isSel ? " is-selected" : ""}`}
                  onClick={() => toggle(f.path)}
                  style={{
                    display: "flex", alignItems: "center", gap: 10,
                    padding: "7px 12px", borderRadius: 8, cursor: "pointer",
                    background: isSel
                      ? "color-mix(in srgb, var(--color-primary) 8%, transparent)"
                      : "transparent",
                    userSelect: "none",
                    transition: "background 0.08s",
                  }}
                >
                  {/* Checkbox */}
                  {isSel
                    ? <CheckSquare size={14} style={{ color: "var(--color-primary)", flexShrink: 0 }} />
                    : <Square      size={14} style={{ color: "var(--color-text-muted)", flexShrink: 0, opacity: 0.5 }} />
                  }

                  {/* File icon */}
                  <FileText size={14} style={{
                    color: isSel ? badgeColor : "var(--color-text-muted)",
                    flexShrink: 0, transition: "color 0.1s",
                  }} />

                  {/* Name + sub-path */}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{
                      fontSize: 12, fontWeight: isSel ? 600 : 500,
                      color: "var(--color-text)",
                      overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                    }}>
                      {f.fileName}
                    </div>
                    {f.subdir && (
                      <div style={{
                        fontSize: 10, color: "var(--color-text-muted)", marginTop: 1,
                        overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                        fontFamily: "monospace", opacity: 0.7,
                      }}>
                        {f.subdir}
                      </div>
                    )}
                  </div>

                  {/* Extension badge */}
                  <span style={{
                    fontSize: 9, fontWeight: 700, letterSpacing: "0.05em",
                    color: isSel ? badgeColor : "var(--color-text-muted)",
                    background: isSel
                      ? `color-mix(in srgb, ${badgeColor} 12%, transparent)`
                      : "var(--color-bg-tertiary)",
                    border: `1px solid ${isSel
                      ? `color-mix(in srgb, ${badgeColor} 25%, transparent)`
                      : "var(--color-border)"}`,
                    padding: "2px 7px", borderRadius: 5,
                    flexShrink: 0, fontFamily: "monospace",
                    transition: "all 0.1s",
                  }}>
                    {f.badge}
                  </span>
                </div>
              );
            })
          )}
        </div>

        {/* ── Footer ── */}
        <div style={{
          padding: "12px 20px", borderTop: "1px solid var(--color-border)",
          display: "flex", gap: 8, alignItems: "center",
          background: "var(--color-bg-secondary)",
        }}>
          {/* Selection summary */}
          <div style={{ flex: 1, fontSize: 11, color: "var(--color-text-muted)" }}>
            {noneSelected
              ? "Select files to open"
              : <>
                  <span style={{ color: "var(--color-primary)", fontWeight: 600 }}>{selected.size}</span>
                  {" "}file{selected.size !== 1 ? "s" : ""} ready
                  {selected.size >= 2 && (
                    <span style={{ opacity: 0.6 }}>{" "}· graph view will open</span>
                  )}
                </>
            }
          </div>

          <button
            onClick={onCancel}
            style={{
              padding: "7px 16px", borderRadius: 8, fontSize: 12, cursor: "pointer",
              fontWeight: 500,
              background: "var(--color-bg-tertiary)",
              border: "1px solid var(--color-border)",
              color: "var(--color-text)",
              transition: "all 0.1s",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = "var(--color-bg)";
              e.currentTarget.style.borderColor = "var(--color-text-muted)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = "var(--color-bg-tertiary)";
              e.currentTarget.style.borderColor = "var(--color-border)";
            }}
          >
            Cancel
          </button>
          <button
            onClick={() => onConfirm(files.filter((f) => selected.has(f.path)))}
            disabled={noneSelected}
            style={{
              padding: "7px 20px", borderRadius: 8, fontSize: 12,
              fontWeight: 700, letterSpacing: "-0.01em",
              background: noneSelected ? "var(--color-bg-tertiary)" : "var(--color-primary)",
              border: "none",
              color: noneSelected ? "var(--color-text-muted)" : "#fff",
              cursor: noneSelected ? "not-allowed" : "pointer",
              opacity: noneSelected ? 0.5 : 1,
              transition: "all 0.12s",
              boxShadow: noneSelected ? "none" : "0 2px 8px color-mix(in srgb, var(--color-primary) 30%, transparent)",
            }}
          >
            Open {selected.size > 0 ? `${selected.size} file${selected.size !== 1 ? "s" : ""}` : "files"}
          </button>
        </div>
      </div>
    </div>
  );
}
