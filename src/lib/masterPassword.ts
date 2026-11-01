import { estimateStrength, type Strength } from "./vaultHealth";

/** Backend minimum (vault_core.rs MIN_PASSWORD_LEN). The backend rule is unchanged so existing vaults keep working. */
export const MASTER_MIN_LEN = 8;
/** Lowest acceptable estimateStrength score for a NEW master password. */
export const MASTER_MIN_SCORE = 2;

export const STRENGTH_LABELS = ["Very weak", "Weak", "Fair", "Good", "Strong"] as const;

export interface MasterPasswordReport {
  score: Strength["score"];
  label: (typeof STRENGTH_LABELS)[number];
  hint: string;
  /** Meets the rule (length, not common, score >= MASTER_MIN_SCORE). */
  ok: boolean;
  /** Inline message when not ok; null when ok. */
  problem: string | null;
}

export function assessMasterPassword(pw: string): MasterPasswordReport {
  const { score, common } = estimateStrength(pw);
  const label = STRENGTH_LABELS[score];
  const len = [...pw].length;
  let problem: string | null = null;
  let hint: string;
  if (len < MASTER_MIN_LEN) {
    problem = `Password must be at least ${MASTER_MIN_LEN} characters`;
    hint = `Use at least ${MASTER_MIN_LEN} characters`;
  } else if (common) {
    problem = "That password is too common. Choose something less guessable";
    hint = "Avoid common passwords";
  } else if (score < MASTER_MIN_SCORE) {
    problem = "That password is too weak. Add another word or a few more characters";
    hint = "Add another word";
  } else {
    hint = score >= 4 ? "Looks great" : score === 3 ? "Add another word to make it stronger" : "Longer is stronger";
  }
  return { score, label, hint, ok: problem === null, problem };
}

/** Gate for choosing a new master password; returns an error message or null. */
export function masterPasswordProblem(pw: string): string | null {
  return assessMasterPassword(pw).problem;
}
