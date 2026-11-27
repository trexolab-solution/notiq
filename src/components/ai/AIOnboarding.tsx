import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  Sparkles, ShieldCheck, Cloud, HardDrive, Router, ExternalLink, Check, MessageSquare, TextCursorInput, Wand2,
  type LucideIcon,
} from "lucide-react";
import { useAIPreferences } from "../../store/selectors";
import { Dialog, DialogBody, DialogButton, DialogFooter } from "../ui/Dialog";
import { Stepper, useStepFocus, type StepDef } from "../ui/Stepper";
import { ModelPicker } from "./ModelPicker";
import { Input } from "../ui/Input";
import { CopyIconButton } from "../vault/CopyIconButton";
import {
  aiListModels, setApiKey, hasApiKey, baseUrlFor, type ModelInfo,
} from "../../lib/ai/client";
import { isFreeModel } from "../../lib/ai/models";
import { aiProblem } from "../../lib/ai/verify";
import { mapAiError } from "../../lib/ai/errors";
import { isTauri } from "../../lib/tauriWindow";
import { toast } from "../../lib/toast";
import type { AIProvider } from "../../types";

interface AIOnboardingProps {
  onClose: () => void;
}

type Step = "intro" | "provider" | "connect" | "model";

const STEPS: readonly StepDef<Step>[] = [
  { key: "intro", label: "Start" },
  { key: "provider", label: "Provider" },
  { key: "connect", label: "Connect" },
  { key: "model", label: "Model" },
];

const FEATURES: { icon: LucideIcon; title: string; text: string }[] = [
  { icon: TextCursorInput, title: "Autocomplete", text: "Suggestions as you type; Tab accepts one." },
  { icon: Wand2, title: "Editor actions", text: "Continue, summarize, fix grammar, make a title, fix Mermaid." },
  { icon: MessageSquare, title: "Chat", text: "Ask about the notes and files you have open." },
];

const PROVIDERS: { value: AIProvider; name: string; text: string; icon: LucideIcon }[] = [
  { value: "cloud", name: "Ollama Cloud", text: "Hosted by Ollama. Needs an API key and internet.", icon: Cloud },
  { value: "openrouter", name: "OpenRouter", text: "Many hosted models, free and paid, with one API key.", icon: Router },
  { value: "local", name: "Local Ollama", text: "Runs on this computer. Free, private and works offline.", icon: HardDrive },
];

const KEY_PAGE: Partial<Record<AIProvider, string>> = {
  cloud: "https://ollama.com/settings/keys",
  openrouter: "https://openrouter.ai/keys",
};

const muted = "text-xs text-[var(--color-text-muted)]";

function IconTile({ icon: Icon }: { icon: LucideIcon }) {
  return (
    <span aria-hidden className="shrink-0 inline-flex items-center justify-center h-8 w-8 rounded-md border border-[var(--color-border)] bg-[var(--color-bg-tertiary)] text-[var(--color-primary)]">
      <Icon size={15} />
    </span>
  );
}

/** One line of "title + what it is" beside an icon. */
function Line({ icon, title, children }: { icon: LucideIcon; title: string; children: ReactNode }) {
  return (
    <>
      <IconTile icon={icon} />
      <span className="flex-1 min-w-0">
        <span className="block text-[13px] font-medium text-[var(--color-text)]">{title}</span>
        <span className={`block ${muted}`}>{children}</span>
      </span>
    </>
  );
}

/** First-time AI setup: what it does, where the model runs, the connection, and which model. */
export function AIOnboarding({ onClose }: AIOnboardingProps) {
  const {
    aiProvider, setAiProvider,
    aiModel, setAiModel,
    setAiEnabled, setAiOnboarded,
  } = useAIPreferences();

  const [step, setStep] = useState<Step>("intro");
  const [keyInput, setKeyInput] = useState("");
  const [keyPresent, setKeyPresent] = useState(false);
  const [keyCheckFailed, setKeyCheckFailed] = useState(false);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [busy, setBusy] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  useStepFocus(bodyRef, step);

  const needsKey = aiProvider !== "local";
  const provider = PROVIDERS.find((p) => p.value === aiProvider) ?? PROVIDERS[0];
  const index = STEPS.findIndex((s) => s.key === step);

  const [keyCheckTick, setKeyCheckTick] = useState(0);
  useEffect(() => {
    setKeyCheckFailed(false);
    hasApiKey(aiProvider).then(setKeyPresent).catch(() => setKeyCheckFailed(true));
  }, [aiProvider, keyCheckTick]);

  // Connect step → test the connection (also fetches the models), advance on success.
  const connectAndContinue = async () => {
    if (busy) return;
    if (!isTauri) { toast.error("Run the desktop app to connect"); return; }
    setBusy(true);
    try {
      if (needsKey && keyInput.trim()) {
        await setApiKey(aiProvider, keyInput.trim());
        setKeyPresent(true);
        setKeyInput("");
      }
      const list = await aiListModels(aiProvider);
      setModels(list);
      if (!aiModel && list.length) {
        // Never pre-pick a paid model: on OpenRouter only a free one is chosen for the user.
        const first = list.find((m) => isFreeModel(m.id, aiProvider)) ?? (aiProvider === "openrouter" ? undefined : list[0]);
        if (first) setAiModel(first.id);
      }
      setStep("model");
    } catch (e) {
      toast.error(mapAiError(e));
    } finally {
      setBusy(false);
    }
  };

  const finish = async () => {
    if (busy) return;
    if (!aiModel) { toast.warning("Pick a model to finish"); return; }
    // A real request with the picked model: listing models works without a valid key on some providers.
    setBusy(true);
    const problem = await aiProblem();
    setBusy(false);
    if (problem) { toast.error(problem); return; }
    setAiEnabled(true);
    setAiOnboarded(true);
    toast.success("AI is ready ✨");
    onClose();
  };

  const dismiss = () => { setAiOnboarded(true); onClose(); };
  const back = () => setStep(STEPS[Math.max(0, index - 1)].key);
  const next = () => {
    if (step === "intro") setStep("provider");
    else if (step === "provider") setStep("connect");
    else if (step === "connect") void connectAndContinue();
    else void finish();
  };

  return (
    <Dialog title="Set up AI assistance" icon={<Sparkles size={16} />} size="md" onClose={onClose} onPrimary={next} dismissable={!busy}>
      <DialogBody>
        <Stepper steps={STEPS} current={step} label="AI setup steps" />
        {/* Each step is as tall as what it holds: no padding out to a common height. */}
        <div ref={bodyRef} className="flex flex-col gap-3">
          {step === "intro" && (
            <>
              <ul className="flex flex-col gap-3">
                {FEATURES.map((f) => (
                  <li key={f.title} className="flex items-center gap-3"><Line icon={f.icon} title={f.title}>{f.text}</Line></li>
                ))}
              </ul>
              <div className={`mt-1 flex items-start gap-2.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-tertiary)]/50 p-3 ${muted}`}>
                <ShieldCheck size={16} aria-hidden className="shrink-0 text-[var(--color-success)]" />
                <span>
                  AI stays off until you finish. With a hosted provider, the text you use it on is sent to that provider; with
                  Local Ollama it stays on this computer. Vault items are never sent.
                </span>
              </div>
            </>
          )}

          {step === "provider" && (
            <fieldset className="flex flex-col gap-2">
              <legend className="mb-2 text-sm">Where should the model run?</legend>
              {PROVIDERS.map((p) => {
                const on = p.value === aiProvider;
                return (
                  <label key={p.value}
                         className={`flex items-center gap-3 rounded-lg border p-3 cursor-pointer focus-within:ring-2 focus-within:ring-[var(--color-primary)]/50 ${on
                           ? "border-[var(--color-primary)] bg-[var(--color-primary)]/10" : "border-[var(--color-border)] hover:bg-[var(--color-bg-tertiary)]/60"}`}>
                    {/* A real radio (visually hidden): arrows move between the choices. */}
                    <input type="radio" name="ai-provider" value={p.value} checked={on} className="sr-only"
                           data-step-focus={on ? "" : undefined} onChange={() => setAiProvider(p.value)} />
                    <Line icon={p.icon} title={p.name}>{p.text}</Line>
                    <span aria-hidden className={`shrink-0 inline-flex items-center justify-center h-4 w-4 rounded-full border ${on
                      ? "border-[var(--color-primary)] bg-[var(--color-primary)] text-[var(--color-bg)]" : "border-[var(--color-border)]"}`}>
                      {on && <Check size={10} strokeWidth={3} />}
                    </span>
                  </label>
                );
              })}
            </fieldset>
          )}

          {step === "connect" && (needsKey ? (
            <>
              <label className="flex flex-col gap-1.5 text-sm" htmlFor="ai-setup-key">
                {provider.name} API key
                <Input id="ai-setup-key" type="password" value={keyInput} autoComplete="off" spellCheck={false} data-step-focus=""
                       className="!py-2 font-mono" disabled={busy} onChange={(e) => setKeyInput(e.target.value)}
                       placeholder={keyPresent && !keyCheckFailed ? "A key is saved. Leave empty to keep it" : "Paste your API key"} />
              </label>
              {keyCheckFailed && (
                <p className={muted} role="alert">
                  Couldn't check for a saved key. <button type="button" className="underline cursor-pointer" onClick={() => setKeyCheckTick((n) => n + 1)}>Retry</button>
                </p>
              )}
              <a href={KEY_PAGE[aiProvider]} target="_blank" rel="noreferrer"
                 className="inline-flex items-center gap-1.5 self-start text-xs underline underline-offset-2 text-[var(--color-primary)]">
                <ExternalLink size={12} aria-hidden /> Get an API key
              </a>
              <p className={muted}>The key is kept in your computer's keychain. "Test & continue" saves it and loads the models.</p>
            </>
          ) : (
            <>
              <p className="text-sm">Start Ollama on this computer:</p>
              <div className="flex items-center gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-bg-tertiary)] pl-3 pr-1 py-1">
                <code className="flex-1 font-mono text-xs">ollama serve</code>
                <CopyIconButton value="ollama serve" label="command" />
              </div>
              <p className={muted}>Notiq connects to {baseUrlFor("local")} and lists the models you have installed.</p>
            </>
          ))}

          {step === "model" && (
            <>
              <p className="text-sm">Pick a model</p>
              {/* A row of its own: in a column the picker's `flex: 1` would stretch it to the step's height. */}
              <div className="flex">
                <ModelPicker value={aiModel} onChange={setAiModel} models={models.map((m) => ({ ...m, provider: aiProvider }))}
                             placeholder="Select a model" aria-label="AI model" />
              </div>
              <p className={muted}>
                {models.length
                  ? `${models.length} model${models.length === 1 ? "" : "s"} from ${provider.name}. Free ones are listed first. A small, quick model suits autocomplete best.`
                  : `${provider.name} listed no models. Go back and check the connection.`}
              </p>
              <p className={muted}>You can change the provider, model and autocomplete later in Settings → AI.</p>
            </>
          )}
        </div>
      </DialogBody>
      <DialogFooter start={<DialogButton variant="ghost" onClick={dismiss} disabled={busy}>Maybe later</DialogButton>}>
        {index > 0 && <DialogButton onClick={back} disabled={busy}>Back</DialogButton>}
        {step === "intro" && <DialogButton variant="primary" onClick={next}>Get started</DialogButton>}
        {step === "provider" && <DialogButton variant="primary" onClick={next}>Next</DialogButton>}
        {step === "connect" && <DialogButton variant="primary" onClick={next} loading={busy} loadingText="Connecting…">Test &amp; continue</DialogButton>}
        {step === "model" && <DialogButton variant="primary" icon={<Check size={13} />} onClick={next} disabled={!aiModel} loading={busy} loadingText="Checking…">Finish</DialogButton>}
      </DialogFooter>
    </Dialog>
  );
}
