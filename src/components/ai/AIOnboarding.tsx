import { useEffect, useState } from "react";
import { Sparkles, ShieldCheck, Cloud, HardDrive, ExternalLink, Check } from "lucide-react";
import { useAIPreferences } from "../../store/selectors";
import { Modal } from "../ui/Modal";
import { SegmentedControl } from "../ui/SegmentedControl";
import { Select } from "../ui/Select";
import { Input } from "../ui/Input";
import { Button } from "../ui/Button";
import { AI_PROVIDER_OPTIONS } from "../ui/settings/settingsConstants";
import {
  aiListModels, setApiKey, hasApiKey, baseUrlFor,
} from "../../lib/ai/client";
import { mapAiError } from "../../lib/ai/errors";
import { metaFor, kindLabel, SUGGESTED_CLOUD_MODELS } from "../../lib/ai/models";
import { isTauri } from "../../lib/tauriWindow";
import { toast } from "../../lib/toast";
import type { AIProvider } from "../../types";

interface AIOnboardingProps {
  onClose: () => void;
}

type Step = 0 | 1 | 2 | 3;

export function AIOnboarding({ onClose }: AIOnboardingProps) {
  const {
    aiProvider, setAiProvider,
    aiModel, setAiModel,
    setAiEnabled, setAiOnboarded,
  } = useAIPreferences();

  const [step, setStep] = useState<Step>(0);
  const [keyInput, setKeyInput] = useState("");
  const [keyPresent, setKeyPresent] = useState(false);
  const [models, setModels] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const isCloud = aiProvider === "cloud";

  useEffect(() => { hasApiKey().then(setKeyPresent).catch(() => {}); }, []);

  // Step 2 → test connection (also fetches models), advance on success.
  const connectAndContinue = async () => {
    if (!isTauri) { toast.error("Run the desktop app to connect"); return; }
    setBusy(true);
    try {
      if (isCloud && keyInput.trim()) {
        await setApiKey(keyInput.trim());
        setKeyPresent(true);
        setKeyInput("");
      }
      const list = await aiListModels(baseUrlFor(aiProvider));
      setModels(list.length ? list : (isCloud ? SUGGESTED_CLOUD_MODELS : []));
      if (!aiModel && list.length) setAiModel(list[0]);
      else if (!aiModel && isCloud) setAiModel(SUGGESTED_CLOUD_MODELS[0]);
      setStep(3);
    } catch (e) {
      toast.error(mapAiError(e));
    } finally {
      setBusy(false);
    }
  };

  const finish = () => {
    if (!aiModel) { toast.warning("Pick a model to finish"); return; }
    setAiEnabled(true);
    setAiOnboarded(true);
    toast.success("AI is ready ✨");
    onClose();
  };

  const dismiss = () => { setAiOnboarded(true); onClose(); };

  const modelOptions = Array.from(new Set([aiModel, ...models].filter(Boolean))).map((id) => ({
    value: id,
    label: `${id} · ${kindLabel(metaFor(id).kind)}`,
  }));

  return (
    <Modal onClose={onClose}>
      <div
        className="flex flex-col rounded-xl overflow-hidden"
        style={{
          width: 460, maxWidth: "calc(100vw - 32px)",
          background: "var(--color-bg-secondary)",
          border: "1px solid var(--color-border)",
          boxShadow: "0 24px 64px rgba(0,0,0,0.5)",
          color: "var(--color-text)",
        }}
      >
        {/* Header */}
        <div className="flex items-center gap-2.5 px-5 py-4" style={{ borderBottom: "1px solid var(--color-border)" }}>
          <div
            className="flex items-center justify-center rounded-lg"
            style={{ width: 32, height: 32, background: "color-mix(in srgb, var(--color-primary) 14%, transparent)", color: "var(--color-primary)" }}
          >
            <Sparkles size={17} />
          </div>
          <div className="flex flex-col">
            <span className="text-sm font-semibold">Set up AI assistance</span>
            <span className="text-xs" style={{ color: "var(--color-text-muted)" }}>Step {step + 1} of 4</span>
          </div>
        </div>

        {/* Body */}
        <div className="px-5 py-5 flex flex-col gap-4" style={{ minHeight: 200 }}>
          {step === 0 && (
            <>
              <p className="text-sm" style={{ color: "var(--color-text)" }}>
                Get inline autocomplete and AI actions (continue, summarize, fix grammar, generate
                title, fix Mermaid) right inside the editor — powered by Ollama.
              </p>
              <div className="flex items-start gap-2 text-xs p-3 rounded-lg"
                style={{ background: "var(--color-bg-tertiary)", color: "var(--color-text-muted)" }}>
                <ShieldCheck size={26} style={{ color: "var(--color-primary)", flexShrink: 0 }} />
                <span>
                  <b style={{ color: "var(--color-text)" }}>Privacy:</b> with <b>Cloud</b>, note text
                  is sent to Ollama's servers to generate suggestions. With <b>Local</b>, everything
                  stays on your machine. AI is off until you finish this setup.
                </span>
              </div>
            </>
          )}

          {step === 1 && (
            <>
              <p className="text-sm">Choose how to run the model:</p>
              <SegmentedControl
                value={aiProvider}
                onChange={(v) => setAiProvider(v as AIProvider)}
                options={AI_PROVIDER_OPTIONS}
                aria-label="AI provider"
              />
              <div className="flex flex-col gap-2 mt-1">
                <div className="flex items-start gap-2 text-xs" style={{ color: "var(--color-text-muted)" }}>
                  <Cloud size={15} style={{ flexShrink: 0, marginTop: 1 }} />
                  <span><b style={{ color: "var(--color-text)" }}>Cloud</b> — best models, needs an API key &amp; internet (free daily tier).</span>
                </div>
                <div className="flex items-start gap-2 text-xs" style={{ color: "var(--color-text-muted)" }}>
                  <HardDrive size={15} style={{ flexShrink: 0, marginTop: 1 }} />
                  <span><b style={{ color: "var(--color-text)" }}>Local</b> — free &amp; offline, runs via <code>ollama serve</code> on your machine.</span>
                </div>
              </div>
            </>
          )}

          {step === 2 && (
            <>
              {isCloud ? (
                <>
                  <p className="text-sm">Paste your Ollama Cloud API key:</p>
                  <Input
                    type="password"
                    value={keyInput}
                    onChange={(e) => setKeyInput(e.target.value)}
                    placeholder={keyPresent ? "•••••••• (a key is already saved)" : "Paste API key"}
                    aria-label="API key"
                  />
                  <a href="https://ollama.com/settings/keys" target="_blank" rel="noreferrer"
                    className="inline-flex items-center gap-1.5 text-xs" style={{ color: "var(--color-primary)" }}>
                    <ExternalLink size={12} /> Get an Ollama API key
                  </a>
                </>
              ) : (
                <>
                  <p className="text-sm">Make sure Ollama is running locally:</p>
                  <pre className="text-xs p-3 rounded-lg" style={{ background: "var(--color-bg-tertiary)", color: "var(--color-text)" }}>
                    ollama serve
                  </pre>
                  <p className="text-xs" style={{ color: "var(--color-text-muted)" }}>
                    We'll connect to {baseUrlFor("local")} and load your installed models.
                  </p>
                </>
              )}
            </>
          )}

          {step === 3 && (
            <>
              <p className="text-sm">Pick a model to use:</p>
              <Select
                value={aiModel}
                onChange={setAiModel}
                options={modelOptions}
                placeholder="Select model"
                aria-label="AI model"
              />
              <p className="text-xs" style={{ color: "var(--color-text-muted)" }}>
                You can change the model, key, and autocomplete behaviour anytime in Settings → AI.
              </p>
            </>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-5 py-3" style={{ borderTop: "1px solid var(--color-border)" }}>
          <Button variant="ghost" size="sm" onClick={dismiss}>Maybe later</Button>
          <div className="flex items-center gap-2">
            {step > 0 && <Button variant="ghost" size="sm" onClick={() => setStep((s) => (s - 1) as Step)}>Back</Button>}
            {step === 0 && <Button variant="primary" size="sm" icon={<Sparkles size={13} />} onClick={() => setStep(1)}>Get started</Button>}
            {step === 1 && <Button variant="primary" size="sm" onClick={() => setStep(2)}>Next</Button>}
            {step === 2 && <Button variant="primary" size="sm" onClick={connectAndContinue} disabled={busy}>{busy ? "Connecting…" : "Test & continue"}</Button>}
            {step === 3 && <Button variant="primary" size="sm" icon={<Check size={13} />} onClick={finish}>Finish</Button>}
          </div>
        </div>
      </div>
    </Modal>
  );
}
