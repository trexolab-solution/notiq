import { useCallback, useMemo, useRef, useState } from "react";
import { aiListModels, type ModelInfo } from "../../../lib/ai/client";
import type { AIProvider } from "../../../types";
import { DEFAULT_MODEL_VALUE, PROVIDER_TAG } from "./types";

export interface ModelOverride { provider: AIProvider; model: string }

/**
 * Per-conversation model override — never touches the global Settings default.
 * Resets to "use the default" on New chat / loading a different conversation.
 * Also owns the lazy, cross-provider model list used by the composer's picker.
 */
export function useChatModels(aiProvider: AIProvider, aiModel: string) {
  const [modelOverride, setModelOverride] = useState<ModelOverride | null>(null);
  const [modelChoices, setModelChoices] = useState<(ModelInfo & { provider: AIProvider })[] | null>(null);
  const modelsLoadingRef = useRef(false);

  // Lazily fetch every configured provider's model list on first dropdown open —
  // a provider with no key/unreachable local Ollama just drops out silently.
  const loadModelChoices = useCallback(() => {
    if (modelChoices !== null || modelsLoadingRef.current) return;
    modelsLoadingRef.current = true;
    Promise.allSettled(
      (["cloud", "local", "openrouter"] as AIProvider[]).map((p) =>
        aiListModels(p).then((list) => list.map((m) => ({ ...m, provider: p }))),
      ),
    ).then((results) => {
      const merged = results
        .filter((r): r is PromiseFulfilledResult<(ModelInfo & { provider: AIProvider })[]> => r.status === "fulfilled")
        .flatMap((r) => r.value)
        .sort((a, b) => a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id));
      setModelChoices(merged);
      modelsLoadingRef.current = false;
    });
  }, [modelChoices]);

  // A leading sentinel option reverts a per-conversation override to the global default.
  const modelExtraOptions = useMemo(() => [{
    value: DEFAULT_MODEL_VALUE,
    label: aiModel ? `Use default (${PROVIDER_TAG[aiProvider]} · ${aiModel})` : "Use default",
  }], [aiProvider, aiModel]);

  const modelSelectValue = modelOverride ? `${modelOverride.provider}::${modelOverride.model}` : DEFAULT_MODEL_VALUE;

  const onModelSelectChange = useCallback((v: string) => {
    if (v === DEFAULT_MODEL_VALUE) { setModelOverride(null); return; }
    const sep = v.indexOf("::");
    setModelOverride({ provider: v.slice(0, sep) as AIProvider, model: v.slice(sep + 2) });
  }, []);

  const resetModelOverride = useCallback(() => setModelOverride(null), []);

  return {
    modelOverride, modelChoices, loadModelChoices,
    modelExtraOptions, modelSelectValue, onModelSelectChange, resetModelOverride,
  };
}
