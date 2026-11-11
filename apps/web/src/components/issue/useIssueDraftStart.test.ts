import { expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  prepare: vi.fn(),
  register: vi.fn(),
  newThread: vi.fn(),
  router: {
    state: { location: { href: "/issues" } },
    navigate: vi.fn(),
  },
}));

vi.mock("@tanstack/react-router", () => ({
  useRouter: () => mocks.router,
  useNavigate: () => mocks.router.navigate,
}));
vi.mock("~/hooks/useHandleNewThread", () => ({ useNewThreadHandler: () => mocks.newThread }));
vi.mock("~/state/issues", () => ({
  issueEnvironment: { preparePlaybookDraft: "prepare", startPlaybookOnSend: "register" },
}));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (command: string) => (command === "prepare" ? mocks.prepare : mocks.register),
}));
vi.mock("~/composerDraftStore", () => ({ useComposerDraftStore: { getState: vi.fn() } }));
vi.mock("../promptLinks/linkedPrompt", () => ({ placeLinkedPrompt: vi.fn() }));
vi.mock("../ui/toast", () => ({ toastManager: { add: vi.fn() } }));

import { useIssueDraftStart } from "./useIssueDraftStart";

function setup() {
  vi.clearAllMocks();
  mocks.router.state.location.href = "/issues";
}

it("opens nothing when I went elsewhere while the draft was prepared", async () => {
  setup();
  let answer: (result: unknown) => void = () => {};
  mocks.prepare.mockReturnValue(new Promise((resolve) => (answer = resolve)));
  const opening = useIssueDraftStart()({
    environmentId: "environment",
    entry: { projectId: "project", playbook: "develop", displayKey: "#35" },
    playbooks: ["develop"],
  } as never);
  mocks.router.state.location.href = "/settings/appearance";
  answer({ _tag: "Success", value: { threadId: "thread", prompt: "Work on #35" } });
  await opening;

  expect(mocks.router.navigate).not.toHaveBeenCalled();
  expect(mocks.newThread).not.toHaveBeenCalled();
  expect(mocks.register).not.toHaveBeenCalled();
});
