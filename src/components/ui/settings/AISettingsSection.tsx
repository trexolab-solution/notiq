import React, { useMemo } from "react";
import { Wand2 } from "lucide-react";
import { useAIPreferences } from "../../../store/selectors";
import { SettingRow } from "../SettingRow";
import { SettingsGroup, SettingsBlock } from "../SettingsGroup";
import { Toggle } from "../Toggle";
import { Select } from "../Select";
import { Slider } from "../Slider";
import { SegmentedControl } from "../SegmentedControl";
import { Button } from "../Button";
import { ProviderConfigCard } from "./ProviderConfigCard";
import { AI_PROVIDER_OPTIONS, AI_TRIGGER_MODE_OPTIONS } from "./settingsConstants";
import type { AIProvider, AITriggerMode } from "../../../types";
import type { SettingMeta } from "../../../lib/settingsIndex";

interface AISettingsSectionProps {
  /** Opens the guided onboarding wizard (mounted in App). */
  onRunSetup?: () => void;
}

export const AISettingsSection = React.memo(function AISettingsSection({ onRunSetup }: AISettingsSectionProps) {
  const {
    aiEnabled, setAiEnabled,
    aiProvider, setAiProvider,
    aiModel, setAiModel,
    aiFallbackProvider, setAiFallbackProvider,
    aiFallbackModel, setAiFallbackModel,
    aiAutocompleteEnabled, setAiAutocompleteEnabled,
    aiTriggerMode, setAiTriggerMode,
    aiDebounceMs, setAiDebounceMs,
    aiContextLines, setAiContextLines,
    setAiOnboarded,
  } = useAIPreferences();

  // Fallback can be "none" or either provider that isn't the current default.
  const fallbackOptions = useMemo(
    () => [
      { value: "none", label: "None" },
      ...AI_PROVIDER_OPTIONS.filter((o) => o.value !== aiProvider),
    ],
    [aiProvider],
  );

  const runSetupAgain = () => {
    // Reset the first-run flag so the guided wizard behaves like a fresh setup.
    setAiOnboarded(false);
    onRunSetup?.();
  };

  const DEFAULT_PROVIDER = "cloud";

  return (
    <div className="flex flex-col gap-5">
      <SettingsGroup title="Status & provider" description="Turn AI on, pick where requests go, and optionally a backup provider.">
        <SettingRow
          id="ai.status.enabled"
          label="Enable AI"
          description="Autocomplete + AI actions in the editor."
          help="Master switch for all AI features. When off, nothing runs and no note text is ever sent anywhere."
          keywords={["ai", "assistant", "autocomplete", "master switch", "ollama", "openrouter", "llm"]}
          modified={aiEnabled}
          onReset={() => setAiEnabled(false)}
        >
          <Toggle value={aiEnabled} onChange={setAiEnabled} aria-label="Enable AI" />
        </SettingRow>

        {!aiEnabled ? (
          <SettingsBlock
            id="ai.status.off-notice"
            label="Turn on AI to configure it"
            description="Provider, model, API key and autocomplete settings appear once AI is enabled."
            keywords={["provider", "model", "api key", "ollama", "openrouter", "autocomplete", "ghost text", "fallback", "debounce", "context lines", "privacy"]}
          >
            <p className="text-xs text-[var(--color-text-muted)]">
              Turn on AI to configure your provider, API key, model, and autocomplete behaviour.
              Prefer a guided walkthrough? Use <b className="text-[var(--color-text)]">Run setup again</b> under Setup.
            </p>
          </SettingsBlock>
        ) : (
          <>
            <SettingRow
              id="ai.status.provider"
              label="Provider"
              description="Ollama Cloud, Local Ollama, or OpenRouter"
              help="Cloud/OpenRouter need an API key and internet. Local runs models on your own machine via Ollama — free, offline, and private."
              keywords={["ollama cloud", "local ollama", "openrouter", "backend", "server", "default provider"]}
              modified={aiProvider !== DEFAULT_PROVIDER}
              onReset={() => setAiProvider(DEFAULT_PROVIDER)}
            >
              <SegmentedControl
                value={aiProvider}
                onChange={(v) => setAiProvider(v as AIProvider)}
                options={AI_PROVIDER_OPTIONS}
                aria-label="AI provider"
              />
            </SettingRow>

            <SettingRow
              id="ai.status.fallback"
              label="Fallback provider"
              description="Auto-retries here if the default provider hits an auth/quota error"
              help="When the default provider's request fails with an invalid/expired key, out-of-credits, or rate-limit error, Notiq transparently retries once against this provider instead. Other errors (network, server, bad request) are not retried here."
              keywords={["backup provider", "retry", "quota", "credits", "rate limit", "failover"]}
              modified={aiFallbackProvider !== "none"}
              onReset={() => setAiFallbackProvider("none")}
            >
              <Select
                value={aiFallbackProvider}
                onChange={(v) => setAiFallbackProvider(v as AIProvider | "none")}
                options={fallbackOptions}
                aria-label="Fallback provider"
              />
            </SettingRow>
          </>
        )}
      </SettingsGroup>

      {aiEnabled && (
        <>
          <ProviderConfigCard provider={aiProvider} model={aiModel} onModelChange={setAiModel} role="default" />

          {aiFallbackProvider !== "none" && (
            <ProviderConfigCard
              provider={aiFallbackProvider}
              model={aiFallbackModel}
              onModelChange={setAiFallbackModel}
              role="fallback"
            />
          )}

          <SettingsGroup title="Autocomplete" description="Grey ghost-text suggestions while you type.">
            <SettingRow
              id="ai.autocomplete.enabled"
              label="Inline autocomplete"
              description="Grey ghost-text suggestions while typing"
              help="Shows grey ghost-text suggestions as you type. Press Tab to accept, Esc to dismiss."
              keywords={["ghost text", "suggestions", "completion", "tab", "typing"]}
              modified={!aiAutocompleteEnabled}
              onReset={() => setAiAutocompleteEnabled(true)}
            >
              <Toggle value={aiAutocompleteEnabled} onChange={setAiAutocompleteEnabled} aria-label="Inline autocomplete" />
            </SettingRow>

            {aiAutocompleteEnabled && (
              <>
                <SettingRow
                  id="ai.autocomplete.trigger"
                  label="Trigger"
                  description="Auto suggests on pause; Manual only on Alt+\\"
                  help="Auto requests a suggestion shortly after you stop typing. Manual only suggests when you press Alt+\\, which uses far less quota."
                  keywords={["auto", "manual", "alt", "quota", "when to suggest"]}
                  modified={aiTriggerMode !== "auto"}
                  onReset={() => setAiTriggerMode("auto")}
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
                    id="ai.autocomplete.debounce"
                    label="Debounce"
                    description="Idle time before an auto suggestion is requested"
                    help="How long to wait after you stop typing before requesting a suggestion. Higher = fewer requests (better for limited quota); lower = snappier."
                    keywords={["delay", "idle", "milliseconds", "ms", "pause", "requests"]}
                    modified={aiDebounceMs !== 400}
                    onReset={() => setAiDebounceMs(400)}
                  >
                    <Slider
                      value={aiDebounceMs} onChange={setAiDebounceMs}
                      min={150} max={1500} step={50}
                      formatValue={(v) => `${v} ms`}
                      aria-label="Autocomplete debounce"
                    />
                  </SettingRow>
                )}

                <SettingRow
                  id="ai.autocomplete.context-lines"
                  label="Context lines"
                  description="How many surrounding lines to send for context"
                  help="How many lines around your cursor are sent as context. More context can improve suggestions but makes each request larger and slower."
                  keywords={["context", "lines", "surrounding text", "prompt size", "privacy"]}
                  modified={aiContextLines !== 40}
                  onReset={() => setAiContextLines(40)}
                >
                  <Slider
                    value={aiContextLines} onChange={setAiContextLines}
                    min={10} max={120} step={10}
                    formatValue={(v) => `${v}`}
                    aria-label="Context lines"
                  />
                </SettingRow>
              </>
            )}
          </SettingsGroup>

          <SettingsGroup title="Privacy">
            <SettingsBlock
              id="ai.privacy.note"
              label="Where your data goes"
              description="API keys stay on this device; note text is only sent to the provider you choose."
              keywords={["privacy", "data", "api key", "keyring", "offline", "local", "send", "cloud"]}
            >
              <p className="text-xs leading-relaxed text-[var(--color-text-muted)]">
                API keys are stored on this device in the OS keyring and sent only to their own provider.
                Text around your cursor is sent to the provider you selected when a suggestion or AI action runs.
                Local Ollama keeps everything on your machine.
              </p>
            </SettingsBlock>
          </SettingsGroup>
        </>
      )}

      {onRunSetup && (
        <SettingsGroup title="Setup">
          <SettingRow
            id="ai.setup.run"
            label="Run setup again"
            description="Open the guided walkthrough for provider, key and model."
            keywords={["wizard", "onboarding", "guided", "walkthrough", "configure"]}
          >
            <Button className="settings-btn" variant="ghost" size="sm" icon={<Wand2 size={13} />} onClick={runSetupAgain}>
              Run setup again
            </Button>
          </SettingRow>
        </SettingsGroup>
      )}
    </div>
  );
});

/** Every searchable setting this section renders (see lib/settingsIndex.ts). */
export const SETTINGS_INDEX: SettingMeta[] = [
  { id: "ai.status.enabled", section: "ai", group: "Status & provider", label: "Enable AI",
    description: "Autocomplete + AI actions in the editor.",
    keywords: ["ai", "assistant", "autocomplete", "master switch", "ollama", "openrouter", "llm"] },
  { id: "ai.status.off-notice", section: "ai", group: "Status & provider", label: "Turn on AI to configure it",
    description: "Provider, model, API key and autocomplete settings appear once AI is enabled.",
    keywords: ["provider", "model", "api key", "ollama", "openrouter", "autocomplete", "ghost text", "fallback", "debounce", "context lines", "privacy"] },
  { id: "ai.status.provider", section: "ai", group: "Status & provider", label: "Provider",
    description: "Ollama Cloud, Local Ollama, or OpenRouter",
    keywords: ["ollama cloud", "local ollama", "openrouter", "backend", "server", "default provider"] },
  { id: "ai.status.fallback", section: "ai", group: "Status & provider", label: "Fallback provider",
    description: "Auto-retries here if the default provider hits an auth/quota error",
    keywords: ["backup provider", "retry", "quota", "credits", "rate limit", "failover"] },
  { id: "ai.models.key", section: "ai", group: "Model & API key", label: "API key",
    description: "Paste your API key for the default provider; it is stored locally and never shown again.",
    keywords: ["api key", "token", "secret", "keyring", "credentials", "save key", "delete key", "ollama", "openrouter"] },
  { id: "ai.models.local", section: "ai", group: "Model & API key", label: "Local Ollama",
    description: "No key needed. Make sure Ollama is running (ollama serve).",
    keywords: ["ollama", "local", "serve", "offline", "no key", "localhost", "connection"] },
  { id: "ai.models.model", section: "ai", group: "Model & API key", label: "Model",
    description: "The model used for autocomplete and AI actions, with refresh and a connection test.",
    keywords: ["model", "picker", "test connection", "refresh models", "ollama", "openrouter", "qwen", "coder"] },
  { id: "ai.models.get-key", section: "ai", group: "Model & API key", label: "Get an API key",
    description: "Link to create a key for the default provider (Ollama Cloud or OpenRouter).",
    keywords: ["sign up", "create key", "free tier", "credits", "quota", "ollama", "openrouter", "link"] },
  { id: "ai.fallback.key", section: "ai", group: "Fallback model & API key", label: "Fallback API key",
    description: "Paste your API key for the fallback provider.",
    keywords: ["api key", "token", "secret", "keyring", "credentials", "save key", "delete key", "ollama", "openrouter"] },
  { id: "ai.fallback.local", section: "ai", group: "Fallback model & API key", label: "Fallback: Local Ollama",
    description: "No key needed. Make sure Ollama is running (ollama serve).",
    keywords: ["ollama", "local", "serve", "offline", "no key", "localhost", "connection"] },
  { id: "ai.fallback.model", section: "ai", group: "Fallback model & API key", label: "Fallback model",
    description: "The model used only when the default provider fails, with refresh and a connection test.",
    keywords: ["model", "picker", "test connection", "refresh models", "ollama", "openrouter", "qwen", "coder"] },
  { id: "ai.fallback.get-key", section: "ai", group: "Fallback model & API key", label: "Get a fallback API key",
    description: "Link to create a key for the fallback provider (Ollama Cloud or OpenRouter).",
    keywords: ["sign up", "create key", "free tier", "credits", "quota", "ollama", "openrouter", "link"] },
  { id: "ai.autocomplete.enabled", section: "ai", group: "Autocomplete", label: "Inline autocomplete",
    description: "Grey ghost-text suggestions while typing",
    keywords: ["ghost text", "suggestions", "completion", "tab", "typing"] },
  { id: "ai.autocomplete.trigger", section: "ai", group: "Autocomplete", label: "Trigger",
    description: "Auto suggests on pause; Manual only on Alt+\\",
    keywords: ["auto", "manual", "alt", "quota", "when to suggest"] },
  { id: "ai.autocomplete.debounce", section: "ai", group: "Autocomplete", label: "Debounce",
    description: "Idle time before an auto suggestion is requested",
    keywords: ["delay", "idle", "milliseconds", "ms", "pause", "requests"] },
  { id: "ai.autocomplete.context-lines", section: "ai", group: "Autocomplete", label: "Context lines",
    description: "How many surrounding lines to send for context",
    keywords: ["context", "lines", "surrounding text", "prompt size", "privacy"] },
  { id: "ai.privacy.note", section: "ai", group: "Privacy", label: "Where your data goes",
    description: "API keys stay on this device; note text is only sent to the provider you choose.",
    keywords: ["privacy", "data", "api key", "keyring", "offline", "local", "send", "cloud"] },
  { id: "ai.setup.run", section: "ai", group: "Setup", label: "Run setup again",
    description: "Open the guided walkthrough for provider, key and model.",
    keywords: ["wizard", "onboarding", "guided", "walkthrough", "configure"] },
];
