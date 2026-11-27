import type { Theme, ThemeId } from "../types";

// KEEP IN SYNC with index.html — the inline <script> there has a bg/fg map
// for every theme to prevent a flash of wrong color on startup.
export const THEMES: Record<ThemeId, Theme> = {
  dark: {
    id: "dark",
    label: "Dark",
    mode: "dark",
    colors: {
      bg: "#0f172a", bgSecondary: "#1e293b", bgTertiary: "#334155",
      border: "#334155", text: "#e2e8f0", textMuted: "#8290a3",
      primary: "#c9a84c", primaryHover: "#e2bc5e", onPrimary: "#0f172a", accent: "#38bdf8",
      success: "#4ade80", warning: "#fb923c", danger: "#f87171",
      editorBg: "#0f172a", editorText: "#e2e8f0",
    },
    ansi: {
      black: "#1e293b", red: "#f87171", green: "#4ade80", yellow: "#fbbf24",
      blue: "#38bdf8", magenta: "#c084fc", cyan: "#22d3ee", white: "#e2e8f0",
      brightBlack: "#64748b", brightRed: "#fca5a5", brightGreen: "#86efac", brightYellow: "#fde68a",
      brightBlue: "#7dd3fc", brightMagenta: "#d8b4fe", brightCyan: "#67e8f9", brightWhite: "#f8fafc",
    },
  },
  light: {
    id: "light",
    label: "Light",
    mode: "light",
    colors: {
      bg: "#f8fafc", bgSecondary: "#f1f5f9", bgTertiary: "#e2e8f0",
      border: "#cbd5e1", text: "#1e293b", textMuted: "#617188",
      primary: "#b45309", primaryHover: "#92400e", onPrimary: "#ffffff", accent: "#0284c7",
      success: "#16a34a", warning: "#d97706", danger: "#dc2626",
      editorBg: "#ffffff", editorText: "#1e293b",
    },
    ansi: {
      black: "#1e293b", red: "#dc2626", green: "#16a34a", yellow: "#ca8a04",
      blue: "#2563eb", magenta: "#9333ea", cyan: "#0891b2", white: "#f1f5f9",
      brightBlack: "#64748b", brightRed: "#ef4444", brightGreen: "#22c55e", brightYellow: "#eab308",
      brightBlue: "#3b82f6", brightMagenta: "#a855f7", brightCyan: "#06b6d4", brightWhite: "#ffffff",
    },
  },
  "one-dark": {
    id: "one-dark",
    label: "One Dark Pro",
    mode: "dark",
    colors: {
      bg: "#282c34", bgSecondary: "#21252b", bgTertiary: "#3a3f4b",
      border: "#3e4451", text: "#abb2bf", textMuted: "#8d94a1",
      primary: "#61afef", primaryHover: "#7bc0f7", onPrimary: "#0f172a", accent: "#c678dd",
      success: "#98c379", warning: "#e5c07b", danger: "#e06c75",
      editorBg: "#282c34", editorText: "#abb2bf",
    },
    ansi: {
      black: "#282c34", red: "#e06c75", green: "#98c379", yellow: "#e5c07b",
      blue: "#61afef", magenta: "#c678dd", cyan: "#56b6c2", white: "#abb2bf",
      brightBlack: "#5c6370", brightRed: "#be5046", brightGreen: "#98c379", brightYellow: "#d19a66",
      brightBlue: "#61afef", brightMagenta: "#c678dd", brightCyan: "#56b6c2", brightWhite: "#ffffff",
    },
  },
  nord: {
    id: "nord",
    label: "Nord",
    mode: "dark",
    colors: {
      bg: "#2e3440", bgSecondary: "#3b4252", bgTertiary: "#434c5e",
      border: "#4c566a", text: "#eceff4", textMuted: "#a6aebc",
      primary: "#88c0d0", primaryHover: "#8fbcbb", onPrimary: "#0f172a", accent: "#81a1c1",
      success: "#a3be8c", warning: "#ebcb8b", danger: "#bf616a",
      editorBg: "#2e3440", editorText: "#eceff4",
    },
    ansi: {
      black: "#3b4252", red: "#bf616a", green: "#a3be8c", yellow: "#ebcb8b",
      blue: "#81a1c1", magenta: "#b48ead", cyan: "#88c0d0", white: "#e5e9f0",
      brightBlack: "#4c566a", brightRed: "#bf616a", brightGreen: "#a3be8c", brightYellow: "#ebcb8b",
      brightBlue: "#81a1c1", brightMagenta: "#b48ead", brightCyan: "#8fbcbb", brightWhite: "#eceff4",
    },
  },
  dracula: {
    id: "dracula",
    label: "Dracula",
    mode: "dark",
    colors: {
      bg: "#282a36", bgSecondary: "#313244", bgTertiary: "#44475a",
      border: "#6272a4", text: "#f8f8f2", textMuted: "#8b9cc8",
      primary: "#bd93f9", primaryHover: "#caa9fa", onPrimary: "#0f172a", accent: "#8be9fd",
      success: "#50fa7b", warning: "#f1fa8c", danger: "#ff5555",
      editorBg: "#282a36", editorText: "#f8f8f2",
    },
    ansi: {
      black: "#21222c", red: "#ff5555", green: "#50fa7b", yellow: "#f1fa8c",
      blue: "#bd93f9", magenta: "#ff79c6", cyan: "#8be9fd", white: "#f8f8f2",
      brightBlack: "#6272a4", brightRed: "#ff6e6e", brightGreen: "#69ff94", brightYellow: "#ffffa5",
      brightBlue: "#d6acff", brightMagenta: "#ff92df", brightCyan: "#a4ffff", brightWhite: "#ffffff",
    },
  },
  catppuccin: {
    id: "catppuccin",
    label: "Catppuccin Mocha",
    mode: "dark",
    colors: {
      bg: "#1e1e2e", bgSecondary: "#181825", bgTertiary: "#313244",
      border: "#45475a", text: "#cdd6f4", textMuted: "#81869e",
      primary: "#cba6f7", primaryHover: "#d5b8f8", onPrimary: "#0f172a", accent: "#89dceb",
      success: "#a6e3a1", warning: "#f9e2af", danger: "#f38ba8",
      editorBg: "#1e1e2e", editorText: "#cdd6f4",
    },
    ansi: {
      black: "#45475a", red: "#f38ba8", green: "#a6e3a1", yellow: "#f9e2af",
      blue: "#89b4fa", magenta: "#f5c2e7", cyan: "#94e2d5", white: "#bac2de",
      brightBlack: "#585b70", brightRed: "#f38ba8", brightGreen: "#a6e3a1", brightYellow: "#f9e2af",
      brightBlue: "#89b4fa", brightMagenta: "#f5c2e7", brightCyan: "#94e2d5", brightWhite: "#a6adc8",
    },
  },
  "tokyo-night": {
    id: "tokyo-night",
    label: "Tokyo Night",
    mode: "dark",
    colors: {
      bg: "#1a1b26", bgSecondary: "#16161e", bgTertiary: "#24283b",
      border: "#3b4261", text: "#c0caf5", textMuted: "#7881ac",
      primary: "#7aa2f7", primaryHover: "#89b4fa", onPrimary: "#0f172a", accent: "#bb9af7",
      success: "#9ece6a", warning: "#e0af68", danger: "#f7768e",
      editorBg: "#1a1b26", editorText: "#c0caf5",
    },
    ansi: {
      black: "#414868", red: "#f7768e", green: "#9ece6a", yellow: "#e0af68",
      blue: "#7aa2f7", magenta: "#bb9af7", cyan: "#7dcfff", white: "#c0caf5",
      brightBlack: "#565f89", brightRed: "#f7768e", brightGreen: "#9ece6a", brightYellow: "#e0af68",
      brightBlue: "#7aa2f7", brightMagenta: "#bb9af7", brightCyan: "#7dcfff", brightWhite: "#c0caf5",
    },
  },
  "rose-pine": {
    id: "rose-pine",
    label: "Rose Pine",
    mode: "dark",
    colors: {
      bg: "#191724", bgSecondary: "#1f1d2e", bgTertiary: "#26233a",
      border: "#403d52", text: "#e0def4", textMuted: "#87849e",
      primary: "#c4a7e7", primaryHover: "#d4baef", onPrimary: "#0f172a", accent: "#9ccfd8",
      success: "#31748f", warning: "#f6c177", danger: "#eb6f92",
      editorBg: "#191724", editorText: "#e0def4",
    },
    ansi: {
      black: "#26233a", red: "#eb6f92", green: "#31748f", yellow: "#f6c177",
      blue: "#9ccfd8", magenta: "#c4a7e7", cyan: "#ebbcba", white: "#e0def4",
      brightBlack: "#6e6a86", brightRed: "#eb6f92", brightGreen: "#31748f", brightYellow: "#f6c177",
      brightBlue: "#9ccfd8", brightMagenta: "#c4a7e7", brightCyan: "#ebbcba", brightWhite: "#e0def4",
    },
  },

  gruvbox: {
    id: "gruvbox",
    label: "Gruvbox Dark",
    mode: "dark",
    colors: {
      bg: "#282828", bgSecondary: "#3c3836", bgTertiary: "#504945",
      border: "#665c54", text: "#ebdbb2", textMuted: "#afa089",
      primary: "#fabd2f", primaryHover: "#d79921", onPrimary: "#0f172a", accent: "#fe8019",
      success: "#b8bb26", warning: "#fe8019", danger: "#fb4934",
      editorBg: "#282828", editorText: "#ebdbb2",
    },
    ansi: {
      black: "#282828", red: "#cc241d", green: "#98971a", yellow: "#d79921",
      blue: "#458588", magenta: "#b16286", cyan: "#689d6a", white: "#a89984",
      brightBlack: "#928374", brightRed: "#fb4934", brightGreen: "#b8bb26", brightYellow: "#fabd2f",
      brightBlue: "#83a598", brightMagenta: "#d3869b", brightCyan: "#8ec07c", brightWhite: "#ebdbb2",
    },
  },
  "solarized-dark": {
    id: "solarized-dark",
    label: "Solarized Dark",
    mode: "dark",
    colors: {
      bg: "#002b36", bgSecondary: "#073642", bgTertiary: "#094655",
      border: "#586e75", text: "#839496", textMuted: "#839496",
      primary: "#268bd2", primaryHover: "#2aa198", onPrimary: "#0f172a", accent: "#6c71c4",
      success: "#859900", warning: "#b58900", danger: "#dc322f",
      editorBg: "#002b36", editorText: "#839496",
    },
    ansi: {
      black: "#073642", red: "#dc322f", green: "#859900", yellow: "#b58900",
      blue: "#268bd2", magenta: "#d33682", cyan: "#2aa198", white: "#eee8d5",
      brightBlack: "#002b36", brightRed: "#cb4b16", brightGreen: "#586e75", brightYellow: "#657b83",
      brightBlue: "#839496", brightMagenta: "#6c71c4", brightCyan: "#93a1a1", brightWhite: "#fdf6e3",
    },
  },
  "github-dark": {
    id: "github-dark",
    label: "GitHub Dark",
    mode: "dark",
    colors: {
      bg: "#24292e", bgSecondary: "#1f2428", bgTertiary: "#2f363d",
      border: "#1b1f23", text: "#e1e4e8", textMuted: "#959da5",
      primary: "#0366d6", primaryHover: "#005cc5", onPrimary: "#ffffff", accent: "#f9826c",
      success: "#28a745", warning: "#ffab70", danger: "#ea4a5a",
      editorBg: "#24292e", editorText: "#e1e4e8",
    },
    ansi: {
      black: "#586069", red: "#ea4a5a", green: "#34d058", yellow: "#ffea7f",
      blue: "#2188ff", magenta: "#b392f0", cyan: "#39c5cf", white: "#d1d5da",
      brightBlack: "#959da5", brightRed: "#f97583", brightGreen: "#85e89d", brightYellow: "#ffea7f",
      brightBlue: "#79b8ff", brightMagenta: "#b392f0", brightCyan: "#56d4dd", brightWhite: "#fafbfc",
    },
  },
  monokai: {
    id: "monokai",
    label: "Monokai Pro",
    mode: "dark",
    colors: {
      bg: "#2d2a2e", bgSecondary: "#221f22", bgTertiary: "#403e41",
      border: "#5b595c", text: "#fcfcfa", textMuted: "#939293",
      primary: "#ffd866", primaryHover: "#fc9867", onPrimary: "#0f172a", accent: "#78dce8",
      success: "#a9dc76", warning: "#fc9867", danger: "#ff6188",
      editorBg: "#2d2a2e", editorText: "#fcfcfa",
    },
    ansi: {
      black: "#2c2525", red: "#fd6883", green: "#adda78", yellow: "#f9cc6c",
      blue: "#f38d70", magenta: "#a8a9eb", cyan: "#85dacc", white: "#fff1f3",
      brightBlack: "#72696a", brightRed: "#fd6883", brightGreen: "#adda78", brightYellow: "#f9cc6c",
      brightBlue: "#f38d70", brightMagenta: "#a8a9eb", brightCyan: "#85dacc", brightWhite: "#fff1f3",
    },
  },
  kanagawa: {
    id: "kanagawa",
    label: "Kanagawa",
    mode: "dark",
    colors: {
      bg: "#1F1F28", bgSecondary: "#2A2A37", bgTertiary: "#363646",
      border: "#54546D", text: "#DCD7BA", textMuted: "#949283",
      primary: "#7E9CD8", primaryHover: "#7FB4CA", onPrimary: "#0f172a", accent: "#957FB8",
      success: "#98BB6C", warning: "#E6C384", danger: "#E46876",
      editorBg: "#1F1F28", editorText: "#DCD7BA",
    },
    ansi: {
      black: "#090618", red: "#C34043", green: "#76946A", yellow: "#C0A36E",
      blue: "#7E9CD8", magenta: "#957FB8", cyan: "#6A9589", white: "#C8C093",
      brightBlack: "#727169", brightRed: "#E82424", brightGreen: "#98BB6C", brightYellow: "#E6C384",
      brightBlue: "#7FB4CA", brightMagenta: "#938AA9", brightCyan: "#7AA89F", brightWhite: "#DCD7BA",
    },
  },
  "github-light": {
    id: "github-light",
    label: "GitHub Light",
    mode: "light",
    colors: {
      bg: "#ffffff", bgSecondary: "#f6f8fa", bgTertiary: "#eaeef2",
      border: "#d0d7de", text: "#1f2328", textMuted: "#57606a",
      primary: "#0969da", primaryHover: "#0757b5", onPrimary: "#ffffff", accent: "#7c45d6",
      success: "#176f2c", warning: "#8a5c00", danger: "#c4202b",
      editorBg: "#ffffff", editorText: "#1f2328",
    },
    ansi: {
      black: "#24292f", red: "#cf222e", green: "#116329", yellow: "#7d4e00",
      blue: "#0969da", magenta: "#8250df", cyan: "#1b7c83", white: "#6e7781",
      brightBlack: "#57606a", brightRed: "#a40e26", brightGreen: "#1a7f37", brightYellow: "#9a6700",
      brightBlue: "#1b7ce6", brightMagenta: "#8250df", brightCyan: "#1b7c83", brightWhite: "#57606a",
    },
  },
  paper: {
    id: "paper",
    label: "Paper",
    mode: "light",
    colors: {
      bg: "#fbf8f1", bgSecondary: "#f3eee3", bgTertiary: "#eae3d4",
      border: "#d8cfbc", text: "#2f2a22", textMuted: "#5f5646",
      primary: "#1d6a72", primaryHover: "#155259", onPrimary: "#ffffff", accent: "#8a4b2a",
      success: "#3f6b1f", warning: "#835500", danger: "#ab2a21",
      editorBg: "#fdfbf6", editorText: "#2f2a22",
    },
    ansi: {
      black: "#2f2a22", red: "#ab2a21", green: "#3f6b1f", yellow: "#835500",
      blue: "#285a8f", magenta: "#7d3f78", cyan: "#1d6a72", white: "#756b59",
      brightBlack: "#5f5646", brightRed: "#c0362c", brightGreen: "#4d7f28", brightYellow: "#956300",
      brightBlue: "#346fab", brightMagenta: "#94508e", brightCyan: "#23808a", brightWhite: "#5f5646",
    },
  },
  "catppuccin-latte": {
    id: "catppuccin-latte",
    label: "Catppuccin Latte",
    mode: "light",
    colors: {
      bg: "#eff1f5", bgSecondary: "#e6e9ef", bgTertiary: "#dce0e8",
      border: "#bcc0cc", text: "#4c4f69", textMuted: "#555970",
      primary: "#7a2fe0", primaryHover: "#6821c9", onPrimary: "#ffffff", accent: "#1a56c4",
      success: "#2a6b1e", warning: "#8a5000", danger: "#b80d32",
      editorBg: "#eff1f5", editorText: "#4c4f69",
    },
    ansi: {
      black: "#4c4f69", red: "#c20f36", green: "#34801f", yellow: "#96600a",
      blue: "#1e66f5", magenta: "#8839ef", cyan: "#137a80", white: "#6c6f85",
      brightBlack: "#5c5f77", brightRed: "#d20f39", brightGreen: "#3a8a24", brightYellow: "#a5690c",
      brightBlue: "#2a6ef5", brightMagenta: "#9a4fd0", brightCyan: "#15848b", brightWhite: "#5c5f77",
    },
  },
  everforest: {
    id: "everforest",
    label: "Everforest",
    mode: "dark",
    colors: {
      bg: "#2d353b", bgSecondary: "#343f44", bgTertiary: "#3d484d",
      border: "#4f585e", text: "#d3c6aa", textMuted: "#afbab1",
      primary: "#a7c080", primaryHover: "#b8d092", onPrimary: "#1e2326", accent: "#7fbbb3",
      success: "#8ccf9d", warning: "#dbbc7f", danger: "#f29b9d",
      editorBg: "#2d353b", editorText: "#d3c6aa",
    },
    ansi: {
      black: "#475258", red: "#e67e80", green: "#a7c080", yellow: "#dbbc7f",
      blue: "#7fbbb3", magenta: "#d699b6", cyan: "#83c092", white: "#d3c6aa",
      brightBlack: "#859289", brightRed: "#f29b9d", brightGreen: "#b8d092", brightYellow: "#e8cc93",
      brightBlue: "#95cfc7", brightMagenta: "#e4aec8", brightCyan: "#98d3a6", brightWhite: "#e6dcc2",
    },
  },
  graphite: {
    id: "graphite",
    label: "Graphite",
    mode: "dark",
    colors: {
      bg: "#161618", bgSecondary: "#1e1e21", bgTertiary: "#2a2a2f",
      border: "#38383f", text: "#e6e6e9", textMuted: "#a4a4ad",
      primary: "#7eaaff", primaryHover: "#9dbfff", onPrimary: "#0d1220", accent: "#5fd4c4",
      success: "#5ecf87", warning: "#e6b455", danger: "#f4747a",
      editorBg: "#161618", editorText: "#e6e6e9",
    },
    ansi: {
      black: "#2a2a2f", red: "#f4747a", green: "#5ecf87", yellow: "#e6b455",
      blue: "#7eaaff", magenta: "#c39af2", cyan: "#5fd4c4", white: "#d4d4d8",
      brightBlack: "#71717a", brightRed: "#ff969b", brightGreen: "#86dfa6", brightYellow: "#f2ca7c",
      brightBlue: "#a6c4ff", brightMagenta: "#d6b8f8", brightCyan: "#8ce4d7", brightWhite: "#fafafa",
    },
  },
};

/** True for themes with a light background. Unknown ids count as dark (the default theme). */
export function isLightTheme(id: string): boolean {
  return (THEMES as Record<string, Theme | undefined>)[id]?.mode === "light";
}

export function applyTheme(id: ThemeId): void {
  const root = document.documentElement;
  root.setAttribute("data-theme", id);
  // Light-only CSS keys off this, so it covers every light theme.
  root.setAttribute("data-theme-mode", isLightTheme(id) ? "light" : "dark");
}
