import React, { useCallback, useEffect, useState } from "react";
import { RefreshCw, Zap, Save, Trash2, ExternalLink, Wand2, Sparkles, Eye, EyeOff } from "lucide-react";
import { useAIPreferences } from "../../../store/selectors";
import { SettingRow } from "../SettingRow";
import { Toggle } from "../Toggle";
import { Select } from "../Select";
import { Slider } from "../Slider";
import { SegmentedControl } from "../SegmentedControl";
import { Button } from "../Button";
import { ConfirmDialog } from "../ConfirmDialog";
import { SubHeading } from "./SubHeading";
import { AI_PROVIDER_OPTIONS, AI_TRIGGER_MODE_OPTIONS } from "./settingsConstants";
import {
  aiListModels, aiComplete, setApiKey, hasApiKey, clearApiKey, baseUrlFor,
} from "../../../lib/ai/client";
import { mapAiError } from "../../../lib/ai/errors";
import { metaFor, kindLabel, SUGGESTED_CLOUD_MODELS } from "../../../lib/ai/models";
import { isTauri } from "../../../lib/tauriWindow";
import { toast } from "../../../lib/toast";
import type { AIProvider, AITriggerMode } from "../../../types";

interface AISettingsSectionProps {
  /** Opens the guided onboarding wizard (mounted in App). */
  onRunSetup?: () => void;
}

export const AISettingsSection = React.memo(function AISettingsSection({ onRunSetup }: AISettingsSectionProps) {
  const {
    aiEnabled, setAiEnabled,
    aiProvider, setAiProvider,
    aiModel, setAiModel,
    aiAutocompleteEnabled, setAiAutocompleteEnabled,
    aiTriggerMode, setAiTriggerMode,
    aiDebounceMs, setAiDebounceMs,
    aiContextLines, setAiContextLines,
    setAiOnboarded,
  } = useAIPreferences();

  const [keyInput, setKeyInput] = useState("");
  const [keyPresent, setKeyPresent] = useState(false);
  const [savingKey, setSavingKey] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const [models, setModels] = useState<string[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);

  const isCloud = aiProvider === "cloud";

  // ── Load key presence on mount ──────────────────────────────────────────────
  useEffect(() => { hasApiKey().then(setKeyPresent).catch(() => setKeyPresent(false)); }, []);

  // ── Load models when provider (or key presence) changes ─────────────────────
  const loadModels = useCallback(async () => {
    if (!isTauri) { setModelsError("Run the desktop app to connect to a model"); return; }
    setLoadingModels(true);
    setModelsError(null);
    try {
      const list = await aiListModels(baseUrlFor(aiProvider));
      setModels(list);
      if (list.length === 0) setModelsError("No models returned");
    } catch (e) {
      setModels(isCloud ? SUGGESTED_CLOUD_MODELS : []);
      setModelsError(mapAiError(e));
    } finally {
      setLoadingModels(false);
    }
  }, [aiProvider, isCloud]);

  useEffect(() => { loadModels(); }, [loadModels, keyPresent]);

  // ── Key actions ─────────────────────────────────────────────────────────────
  const saveKey = async () => {
    if (!keyInput.trim()) return;
    setSavingKey(true);
    try {
      await setApiKey(keyInput.trim());
      setKeyPresent(true);
      setKeyInput("");
      setShowKey(false);
      toast.success("API key saved");
    } catch (e) {
      toast.error(mapAiError(e));
    } finally {
      setSavingKey(false);
    }
  };

  const removeKey = async () => {
    try {
      await clearApiKey();
      setKeyPresent(false);
      toast.info("API key removed");
    } catch (e) {
      toast.error(mapAiError(e));
    }
  };

  // ── Test the selected model ─────────────────────────────────────────────────
  const testModel = async () => {
    if (!aiModel) { toast.warning("Pick a model first"); return; }
    setTesting(true);
    const started = performance.now();
    try {
      await aiComplete(
        [{ role: "system", content: "Reply with the single word: OK" }, { role: "user", content: "ping" }],
        { maxTokens: 5, temperature: 0 },
      );
      const ms = Math.round(performance.now() - started);
      toast.success(`Connected — ${aiModel} (${ms} ms)`);
    } catch (e) {
      toast.error(mapAiError(e));
    } finally {
      setTesting(false);
    }
  };

  // Show the selected model even if it isn't in the fetched list yet.
  const modelOptions = Array.from(new Set([aiModel, ...models].filter(Boolean))).map((id) => ({
    value: id,
    label: `${id} · ${kindLabel(metaFor(id).kind)}`,
  }));
  const selectedMeta = aiModel ? metaFor(aiModel) : null;

  const runSetupAgain = () => {
    // Reset the first-run flag so the guided wizard behaves like a fresh setup.
    setAiOnboarded(false);
    onRunSetup?.();
  };

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-base font-semibold text-[var(--color-text)]">AI / Autocomplete</h2>
        {onRunSetup && (
          <Button variant="ghost" size="sm" icon={<Wand2 size={13} />} onClick={runSetupAgain}>
            Run setup again
          </Button>
        )}
      </div>

      <SettingRow
        label="Enable AI"
        description="Autocomplete + AI actions in the editor."
        help="Master switch for all AI features. When off, nothing runs and no note text is ever sent anywhere."
      >
        <Toggle value={aiEnabled} onChange={setAiEnabled} aria-label="Enable AI" />
      </SettingRow>

      {!aiEnabled ? (
        <div className="flex items-start gap-2.5 text-xs p-3 rounded-lg bg-[var(--color-bg-tertiary)] text-[var(--color-text-muted)]">
          <Sparkles size={26} className="text-[var(--color-primary)] shrink-0" />
          <span>
            Turn on AI to configure your provider, API key, model, and autocomplete behaviour.
            Prefer a guided walkthrough? Use <b className="text-[var(--color-text)]">Run setup again</b> above.
          </span>
        </div>
      ) : (
        <>
          {/* Provider & connection */}
          <SubHeading>Provider &amp; Connection</SubHeading>

          <SettingRow
            label="Provider"
            description="Ollama Cloud (API key) or Local Ollama (localhost)"
            help="Cloud uses Ollama's hosted models (needs an API key and internet). Local runs models on your own machine via Ollama — free, offline, and private."
          >
            <SegmentedControl
              value={aiProvider}
              onChange={(v) => setAiProvider(v as AIProvider)}
              options={AI_PROVIDER_OPTIONS}
              aria-label="AI provider"
            />
          </SettingRow>

          {isCloud ? (
            <SettingRow
              label="API Key"
              description={keyPresent ? "A key is saved (stored locally, never shown)." : "Paste your ollama.com API key."}
              help="Your ollama.com API key. It's stored locally on this device and sent only to Ollama to authorize requests. It is never shown again after saving."
            >
              {/* Joined input group: field + reveal toggle + a single flush action
                  (Save/Update while typing, else Delete when a key exists). */}
              <div className="flex items-stretch w-[290px] rounded-md border border-[var(--color-border)] bg-[var(--color-bg-tertiary)] overflow-hidden transition-colors focus-within:border-[var(--color-primary)] focus-within:ring-2 focus-within:ring-[var(--color-primary)]/40">
                <input
                  type={showKey ? "text" : "password"}
                  value={keyInput}
                  onChange={(e) => setKeyInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter" && keyInput.trim() && !savingKey) saveKey(); }}
                  placeholder={keyPresent ? "•••••••• (saved)" : "Paste API key"}
                  aria-label="API key"
                  className="flex-1 min-w-0 bg-transparent border-0 outline-none px-2 py-1 text-sm text-[var(--color-text)] placeholder:text-[var(--color-text-muted)]"
                />
                {/* Reveal toggle — only meaningful while there is text to show. */}
                {keyInput && (
                  <button
                    type="button"
                    onClick={() => setShowKey((v) => !v)}
                    aria-label={showKey ? "Hide API key" : "Show API key"}
                    title={showKey ? "Hide" : "Show"}
                    className="flex items-center px-2 cursor-pointer text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors"
                  >
                    {showKey ? <EyeOff size={14} /> : <Eye size={14} />}
                  </button>
                )}
                {keyInput.trim() ? (
                  <button
                    type="button"
                    onClick={saveKey}
                    disabled={savingKey}
                    className="flex items-center gap-1 px-2.5 text-xs font-semibold cursor-pointer border-l border-[var(--color-border)] bg-[var(--color-primary)] text-[var(--color-bg)] hover:bg-[var(--color-primary-hover)] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    <Save size={13} /> {keyPresent ? "Update" : "Save"}
                  </button>
                ) : keyPresent ? (
                  <button
                    type="button"
                    onClick={() => setConfirmDelete(true)}
                    aria-label="Delete API key"
                    className="flex items-center gap-1 px-2.5 text-xs font-medium cursor-pointer border-l border-[var(--color-border)] text-[var(--color-danger)] hover:bg-[var(--color-danger)]/10 transition-colors"
                  >
                    <Trash2 size={13} /> Delete
                  </button>
                ) : null}
              </div>
            </SettingRow>
          ) : (
            <SettingRow
              label="Local Ollama"
              description="No key needed. Make sure Ollama is running (ollama serve)."
              help="Notiq connects to Ollama on your machine. Start it with 'ollama serve' and pull a model first, e.g. 'ollama pull qwen2.5-coder'."
            >
              <span className="text-xs text-[var(--color-text-muted)]">{baseUrlFor("local")}</span>
            </SettingRow>
          )}

          <SettingRow
            label="Model"
            description={
              modelsError
                ? modelsError
                : selectedMeta
                  ? `${kindLabel(selectedMeta.kind)}${selectedMeta.note ? " · " + selectedMeta.note : ""}`
                  : "Choose a model for autocomplete and actions"
            }
            help="The model used for autocomplete and AI actions. Coder models are best for code & Mermaid; larger models are smarter but slower. Use Test to verify it responds."
          >
            <div className="flex items-center justify-end gap-1.5 w-[290px]">
              <Select
                value={aiModel}
                onChange={setAiModel}
                options={modelOptions}
                placeholder={loadingModels ? "Loading…" : "Select model"}
                aria-label="AI model"
                className="flex-1 min-w-0"
              />
              <Button variant="ghost" size="sm" icon={<RefreshCw size={13} className={loadingModels ? "animate-spin" : ""} />} onClick={loadModels} aria-label="Refresh models" />
              <Button variant="ghost" size="sm" icon={<Zap size={13} />} onClick={testModel} disabled={testing || !aiModel}>
                Test
              </Button>
            </div>
          </SettingRow>

          {isCloud && (
            <div className="flex flex-col gap-1.5">
              <a
                href="https://ollama.com/settings/keys"
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 text-xs w-fit text-[var(--color-primary)]"
              >
                <ExternalLink size={12} /> Get an Ollama API key
              </a>
              <p className="text-xs leading-relaxed text-[var(--color-text-muted)]">
                Cloud uses a free daily tier with limits; heavy/large models may need credits. On a
                credit error, switch to a free model or use Local Ollama.
              </p>
            </div>
          )}

          {/* Autocomplete */}
          <SubHeading>Autocomplete</SubHeading>
          <SettingRow
            label="Inline Autocomplete"
            description="Grey ghost-text suggestions while typing"
            help="Shows grey ghost-text suggestions as you type. Press Tab to accept, Esc to dismiss."
          >
            <Toggle value={aiAutocompleteEnabled} onChange={setAiAutocompleteEnabled} aria-label="Inline autocomplete" />
          </SettingRow>

          {aiAutocompleteEnabled && (
            <>
              <SettingRow
                label="Trigger"
                description="Auto suggests on pause; Manual only on Alt+\\"
                help="Auto requests a suggestion shortly after you stop typing. Manual only suggests when you press Alt+\\, which uses far less quota."
              >
                <SegmentedControl
                  value={aiTriggerMode}
                  onChange={(v) => setAiTriggerMode(v as AITriggerMode)}
                  options={AI_TRIGGER_MODE_OPTIONS}
                  aria-label="Autocomplete trigger"
                />
              </SettingRow>

              {aiTriggerMode === "auto" && (
                <SettingRow
                  label="Debounce"
                  description="Idle time before an auto suggestion is requested"
                  help="How long to wait after you stop typing before requesting a suggestion. Higher = fewer requests (better for limited quota); lower = snappier."
                >
                  <Slider
                    value={aiDebounceMs} onChange={setAiDebounceMs}
                    min={150} max={1500} step={50} resetValue={400}
                    formatValue={(v) => `${v} ms`}
                    aria-label="Autocomplete debounce"
                  />
                </SettingRow>
              )}

              <SettingRow
                label="Context Lines"
                description="How many surrounding lines to send for context"
                help="How many lines around your cursor are sent as context. More context can improve suggestions but makes each request larger and slower."
              >
                <Slider
                  value={aiContextLines} onChange={setAiContextLines}
                  min={10} max={120} step={10} resetValue={40}
                  formatValue={(v) => `${v}`}
                  aria-label="Context lines"
                />
              </SettingRow>
            </>
          )}
        </>
      )}

      {confirmDelete && (
        <ConfirmDialog
          title="Remove API key?"
          message="Your saved Ollama API key will be deleted from this device. You'll need to paste it again to use Cloud AI."
          icon="warning"
          confirmLabel="Delete key"
          cancelLabel="Cancel"
          danger
          onConfirm={async () => { await removeKey(); setConfirmDelete(false); }}
          onCancel={() => setConfirmDelete(false)}
        />
      )}
    </div>
  );
});
