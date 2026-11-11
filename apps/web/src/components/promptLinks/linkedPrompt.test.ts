import { describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  prompt: "",
  setPrompt: vi.fn(),
  close: vi.fn(),
  toasts: [] as Array<{ readonly title: string; readonly onClick?: () => void }>,
  /** Resolves with the next toast's title. */
  nextToast: (_title: string) => {},
}));

vi.mock("~/composerDraftStore", () => ({
  useComposerDraftStore: {
    getState: () => ({
      getComposerDraft: () => ({ prompt: mocks.prompt }),
      setPrompt: mocks.setPrompt,
    }),
  },
}));
vi.mock("../ui/toast", () => ({
  toastManager: {
    add: (toast: { title: string; actionProps?: { onClick: () => void } }) => {
      mocks.toasts.push({ title: toast.title, ...toast.actionProps });
      mocks.nextToast(toast.title);
      return mocks.toasts.length;
    },
    close: mocks.close,
  },
}));

import { placeLinkedPrompt } from "./linkedPrompt";

function setup(prompt: string) {
  mocks.prompt = prompt;
  mocks.setPrompt.mockClear();
  mocks.close.mockClear();
  mocks.toasts.length = 0;
}

function nextToast(): Promise<string> {
  return new Promise((resolve) => {
    mocks.nextToast = resolve;
  });
}

const linked = { text: "Work on #6.", hiddenCharacters: 0 };

describe("placeLinkedPrompt with a step before it places", () => {
  it("runs the step only once I accept replacing my draft", async () => {
    setup("My own text.");
    const beforePlace = vi.fn(() => Promise.resolve(true));
    placeLinkedPrompt("draft-1" as never, linked, [], beforePlace);
    expect(beforePlace).not.toHaveBeenCalled();

    const placed = nextToast();
    mocks.toasts.find((toast) => toast.title === "Linked prompt ready")?.onClick?.();
    expect(await placed).toBe("Prompt added from a link");
    expect(beforePlace).toHaveBeenCalledTimes(1);
    expect(mocks.setPrompt).toHaveBeenCalledWith("draft-1", linked.text);
  });

  it("asks again instead of replacing text written while the step ran", async () => {
    setup("");
    let finish: (placed: boolean) => void = () => {};
    const beforePlace = () => new Promise<boolean>((resolve) => (finish = resolve));
    placeLinkedPrompt("draft-1" as never, linked, [], beforePlace);
    mocks.prompt = "Typed meanwhile.";
    const offered = nextToast();
    finish(true);

    expect(await offered).toBe("Linked prompt ready");
    expect(mocks.setPrompt).not.toHaveBeenCalled();
  });
});
