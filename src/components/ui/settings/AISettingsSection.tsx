import React, { useMemo } from "react";
import { Wand2, Sparkles } from "lucide-react";
import { useAIPreferences } from "../../../store/selectors";
import { SettingRow } from "../SettingRow";
import { Toggle } from "../Toggle";
import { Select } from "../Select";
import { Slider } from "../Slider";
import { SegmentedControl } from "../SegmentedControl";
import { Button } from "../Button";
import { SubHeading } from "./SubHeading";
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
          {/* Default provider & connection */}
          <SubHeading>Default Provider</SubHeading>

          <SettingRow
            label="Provider"
            description="Ollama Cloud, Local Ollama, or OpenRouter"
            help="Cloud/OpenRouter need an API key and internet. Local runs models on your own machine via Ollama — free, offline, and private."
          >
            <SegmentedControl
              value={aiProvider}
              onChange={(v) => setAiProvider(v as AIProvider)}
              options={AI_PROVIDER_OPTIONS}
              aria-label="AI provider"
            />
          </SettingRow>

          <ProviderConfigCard provider={aiProvider} model={aiModel} onModelChange={setAiModel} role="default" />

          {/* Fallback provider */}
          <SubHeading>Fallback (optional)</SubHeading>

          <SettingRow
            label="Fallback provider"
            description="Auto-retries here if the default provider hits an auth/quota error"
            help="When the default provider's request fails with an invalid/expired key, out-of-credits, or rate-limit error, Notiq transparently retries once against this provider instead. Other errors (network, server, bad request) are not retried here."
          >
            <Select
              value={aiFallbackProvider}
              onChange={(v) => setAiFallbackProvider(v as AIProvider | "none")}
              options={fallbackOptions}
              aria-label="Fallback provider"
            />
          </SettingRow>

          {aiFallbackProvider !== "none" && (
            <ProviderConfigCard
              provider={aiFallbackProvider}
              model={aiFallbackModel}
              onModelChange={setAiFallbackModel}
              role="fallback"
            />
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
    </div>
  );
});

/** Every searchable setting this section renders (see lib/settingsIndex.ts). Filled in by the redesign. */
export const SETTINGS_INDEX: SettingMeta[] = [];
