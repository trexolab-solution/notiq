// @vitest-environment happy-dom
import { expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";

const win = {
  close: vi.fn(async () => {}), hide: vi.fn(async () => {}), minimize: vi.fn(), toggleMaximize: vi.fn(),
  isMaximized: async () => false, onResized: async () => () => {},
};
vi.mock("../../lib/tauriWindow", () => ({ appWin: win }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { WindowControls } = await import("./WindowControls");

it("the main window's Close asks to close (the backend sends it to the tray and says so), never just hides", async () => {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => { root.render(<WindowControls />); });
  await act(async () => { host.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!.click(); });
  expect(win.close).toHaveBeenCalledTimes(1);
  expect(win.hide).not.toHaveBeenCalled();
  act(() => root.unmount());
});
