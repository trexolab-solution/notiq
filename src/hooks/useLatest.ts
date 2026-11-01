import { useRef } from "react";

/** Keeps the latest value in a ref, for callbacks (Undo, drop handlers) that run after later renders. */
export function useLatest<T>(v: T) {
  const r = useRef(v);
  r.current = v;
  return r;
}
