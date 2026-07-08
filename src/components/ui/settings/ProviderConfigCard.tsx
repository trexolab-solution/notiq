import React, { useCallback, useEffect, useState } from "react";
import { RefreshCw, Zap, Save, Trash2, ExternalLink, Eye, EyeOff } from "lucide-react";
import { SettingRow } from "../SettingRow";
import { ModelPicker } from "../../ai/ModelPicker";
import { Button } from "../Button";
import { ConfirmDialog } from "../ConfirmDialog";
import {
  aiListModels, aiComplete, setApiKey, hasApiKey, clearApiKey, baseUrlFor, type ModelInfo,
} from "../../../lib/ai/client";
import { mapAiError } from "../../../lib/ai/errors";
import { metaFor, kindLabel } from "../../../lib/ai/models";
import { PROVIDER_LABEL } from "./settingsConstants";
import { isTauri } from "../../../lib/tauriWindow";
import { toast } from "../../../lib/toast";
import type { AIProvider } from "../../../types";

interface ProviderConfigCardProps {
  provider: AIProvider;
  model: string;
  onModelChange: (v: string) => void;
  /** Only changes the "Model" row's help copy — the default provider's model
   *  drives autocomplete/actions directly, the fallback's only kicks in on error. */
  role?: "default" | "fallback";
}

const KEY_SIGNUP: Partial<Record<AIProvider, string>> = {
  cloud: "https://ollama.com/settings/keys",
  openrouter: "https://openrouter.ai/keys",
};

/** One provider's connection card: API key (or "no key needed" for local),
 *  model picker + refresh + test. Shared between the default- and
 *  fallback-provider slots in AISettingsSection. */
export const ProviderConfigCard = React.memo(function ProviderConfigCard({
  provider, model, onModelChange, role = "default",
}: ProviderConfigCardProps) {
  const needsKey = provider !== "local";

  const [keyInput, setKeyInput] = useState("");
  const [keyPresent, setKeyPresent] = useState(false);
  const [savingKey, setSavingKey] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const [models, setModels] = useState<ModelInfo[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    if (!needsKey) { setKeyPresent(false); return; }
    hasApiKey(provider).then(setKeyPresent).catch(() => setKeyPresent(false));
  }, [provider, needsKey]);

  const loadModels = useCallback(async () => {
    if (!isTauri) { setModelsError("Run the desktop app to connect to a model"); return; }
    setLoadingModels(true);
    setModelsError(null);
    try {
      const list = await aiListModels(provider);
      setModels(list);
      if (list.length === 0) setModelsError("No models returned");
    } catch (e) {
      setModels([]);
      setModelsError(mapAiError(e));
    } finally {
      setLoadingModels(false);
    }
  }, [provider]);

  useEffect(() => { loadModels(); }, [loadModels, keyPresent]);

  const saveKey = async () => {
    if (!keyInput.trim()) return;
    setSavingKey(true);
    try {
      await setApiKey(provider, keyInput.trim());
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
      await clearApiKey(provider);
      setKeyPresent(false);
      toast.info("API key removed");
    } catch (e) {
      toast.error(mapAiError(e));
    }
  };

  // Explicit provider/model + noFallback so a broken card can't be masked by a
  // silent retry against a different provider — Test must report the truth.
  const testModel = async () => {
    if (!model) { toast.warning("Pick a model first"); return; }
    setTesting(true);
    const started = performance.now();
    try {
      await aiComplete(
        [{ role: "system", content: "Reply with the single word: OK" }, { role: "user", content: "ping" }],
        { maxTokens: 5, temperature: 0, provider, model, noFallback: true },
      );
      const ms = Math.round(performance.now() - started);
      toast.success(`Connected — ${model} (${ms} ms)`);
    } catch (e) {
      toast.error(mapAiError(e));
    } finally {
      setTesting(false);
    }
  };

  const selectedMeta = model ? metaFor(model) : null;
  const signupUrl = KEY_SIGNUP[provider];

  return (
    <div className="flex flex-col gap-4">
      {needsKey ? (
        <SettingRow
          label="API Key"
          description={keyPresent ? "A key is saved (stored locally, never shown)." : `Paste your ${PROVIDER_LABEL[provider]} API key.`}
          help="Stored locally via the OS keyring and sent only to this provider to authorize requests. Never shown again after saving."
        >
          <div className="flex items-stretch w-[290px] rounded-md border border-[var(--color-border)] bg-[var(--color-bg-tertiary)] overflow-hidden transition-colors focus-within:border-[var(--color-primary)] focus-within:ring-2 focus-within:ring-[var(--color-primary)]/40">
            <input
              type={showKey ? "text" : "password"}
              value={keyInput}
              onChange={(e) => setKeyInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && keyInput.trim() && !savingKey) saveKey(); }}
              placeholder={keyPresent ? "•••••••• (saved)" : "Paste API key"}
              aria-label={`${PROVIDER_LABEL[provider]} API key`}
              className="flex-1 min-w-0 bg-transparent border-0 outline-none px-2 py-1 text-sm text-[var(--color-text)] placeholder:text-[var(--color-text-muted)]"
            />
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
              : "Choose a model"
        }
        help={
          role === "fallback"
            ? "The model used only when the default provider fails with an auth/quota error."
            : "The model used for autocomplete and AI actions. Coder models are best for code & Mermaid; larger models are smarter but slower. Use Test to verify it responds."
        }
      >
        <div className="flex items-center justify-end gap-1.5 w-[290px]">
          <ModelPicker
            value={model}
            onChange={onModelChange}
            models={models.map((m) => ({ ...m, provider }))}
            loading={loadingModels}
            error={modelsError}
            placeholder="Select model"
            aria-label={`${PROVIDER_LABEL[provider]} model`}
          />
          <Button variant="ghost" size="sm" icon={<RefreshCw size={13} className={loadingModels ? "animate-spin" : ""} />} onClick={loadModels} aria-label="Refresh models" />
          <Button variant="ghost" size="sm" icon={<Zap size={13} />} onClick={testModel} disabled={testing || !model}>
            Test
          </Button>
        </div>
      </SettingRow>

      {signupUrl && (
        <div className="flex flex-col gap-1.5">
          <a href={signupUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 text-xs w-fit text-[var(--color-primary)]">
            <ExternalLink size={12} /> Get an {PROVIDER_LABEL[provider]} API key
          </a>
          {provider === "cloud" && (
            <p className="text-xs leading-relaxed text-[var(--color-text-muted)]">
              Cloud uses a free daily tier with limits; heavy/large models may need credits. On a
              credit error, switch to a free model or use Local Ollama.
            </p>
          )}
        </div>
      )}

      {confirmDelete && (
        <ConfirmDialog
          title="Remove API key?"
          message={`Your saved ${PROVIDER_LABEL[provider]} API key will be deleted from this device. You'll need to paste it again to use it.`}
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
