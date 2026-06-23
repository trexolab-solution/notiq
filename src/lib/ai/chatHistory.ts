// Lightweight localStorage-backed history for the AI chat panel. Each saved
// conversation has an id, a derived title (first user message), a timestamp, and
// its messages. Kept small (most-recent N) so it never bloats storage.

export interface ChatMsg { role: "user" | "assistant"; content: string; }

export interface ChatConversation {
  id: string;
  title: string;
  updatedAt: number;
  messages: ChatMsg[];
}

const KEY = "ai:chatHistory";
const MAX_CONVERSATIONS = 30;

export function loadConversations(): ChatConversation[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed as ChatConversation[];
  } catch {
    return [];
  }
}

function persist(list: ChatConversation[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list.slice(0, MAX_CONVERSATIONS)));
  } catch {
    /* storage full / unavailable — ignore */
  }
}

function deriveTitle(messages: ChatMsg[]): string {
  const firstUser = messages.find((m) => m.role === "user");
  const t = (firstUser?.content ?? "New chat").replace(/\s+/g, " ").trim();
  return t.length > 48 ? `${t.slice(0, 48)}…` : t || "New chat";
}

/**
 * Upsert a conversation (insert or update by id) and return the new list, sorted
 * most-recent first. Skips empty/streaming-only conversations.
 */
export function saveConversation(id: string, messages: ChatMsg[], now: number): ChatConversation[] {
  const meaningful = messages.filter((m) => m.content.trim() && !m.content.startsWith("⚠️"));
  if (meaningful.length < 2) return loadConversations(); // need at least a Q + A

  const list = loadConversations().filter((c) => c.id !== id);
  list.unshift({ id, title: deriveTitle(messages), updatedAt: now, messages });
  list.sort((a, b) => b.updatedAt - a.updatedAt);
  const trimmed = list.slice(0, MAX_CONVERSATIONS);
  persist(trimmed);
  return trimmed;
}

export function deleteConversation(id: string): ChatConversation[] {
  const list = loadConversations().filter((c) => c.id !== id);
  persist(list);
  return list;
}

export function clearConversations(): ChatConversation[] {
  persist([]);
  return [];
}

/** Format a timestamp as a short relative label (e.g. "2h ago", "Mon"). */
export function relativeTime(ts: number, now: number): string {
  const diff = Math.max(0, now - ts);
  const min = Math.floor(diff / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  return new Date(ts).toLocaleDateString();
}
