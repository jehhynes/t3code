// Fork-only (jehhynes/t3code#85): the GitHub boards of `settings.json`, their read interval and
// the issue thread limit, saved to one environment through the settings patch.
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthSettingsWriteScope,
  type EnvironmentId,
  type GitHubBoardConfig,
  type ServerSettingsPatch,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import { RegistryContext } from "@effect/atom-react";
import { MoreVertical, PlusIcon } from "lucide-react";
import { useContext, useState } from "react";

import { useEnvironmentSettings } from "../../hooks/useSettings";
import { issueEnvironment } from "../../state/issues";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import {
  NumberField,
  NumberFieldDecrement,
  NumberFieldGroup,
  NumberFieldIncrement,
  NumberFieldInput,
} from "../ui/number-field";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import {
  boardDraft,
  boardFromDraft,
  boardIndex,
  boardKey,
  boardProblems,
  intervalProblem,
  MIN_BOARD_READ_INTERVAL_SECONDS,
  type GitHubBoardDraft,
} from "./githubBoardSettings.logic";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

const THREAD_LIMITS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"];

const failureText = (result: Parameters<typeof squashAtomCommandFailure>[0]) => {
  const error = squashAtomCommandFailure(result);
  return error instanceof Error ? error.message : String(error);
};

/** A board by its place and as it was, so a list pushed meanwhile still finds it. */
type Target = { readonly index: number; readonly board: GitHubBoardConfig };
type Built = { readonly next: ReadonlyArray<GitHubBoardConfig> } | { readonly problem: string };

const named = ({ board }: Target) => `${board.owner}/${board.number}`;

export function GitHubBoardSettings({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const registry = useContext(RegistryContext);
  const boards = useEnvironmentSettings(environmentId, (settings) => settings.githubBoards);
  const interval = useEnvironmentSettings(
    environmentId,
    (settings) => settings.githubBoardReadInterval,
  );
  const limit = useEnvironmentSettings(
    environmentId,
    (settings) => settings.maxRunningIssueThreads,
  );
  const environmentLabel =
    useSettingsScope().environments.find((candidate) => candidate.environmentId === environmentId)
      ?.label ?? "this environment";
  // The grant `requiredScopesForServerSettingsPatch` names for these keys, on this environment.
  const canEdit = useEnvironmentScope(environmentId, AuthSettingsWriteScope);
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: "save GitHub boards",
  });
  const setBoardEnabled = useAtomCommand(issueEnvironment.setBoardEnabled, {
    label: "forget a GitHub board's switch",
  });
  const [editing, setEditing] = useState<{ readonly target: Target | null } | null>(null);
  const [removing, setRemoving] = useState<Target | null>(null);
  const [busy, setBusy] = useState(false);
  const editingIndex = editing?.target ? boardIndex(boards, editing.target) : null;
  const removingBoard = removing === null ? undefined : boards[boardIndex(boards, removing)];

  const save = async (patch: ServerSettingsPatch, title: string) => {
    const result = await updateSettings({ environmentId, input: { patch } });
    if (result._tag === "Success" || isAtomCommandInterrupted(result)) return result._tag;
    toastManager.add({ type: "error", title, description: failureText(result) });
    return "Failure";
  };

  // A board whose identity leaves the list is turned off first: the server refuses to switch a
  // board that settings no longer name, and a board added again must start off. The next list is
  // built after that wait, from the settings as the server last pushed them.
  const saveBoards = async (
    build: (current: ReadonlyArray<GitHubBoardConfig>) => Built,
    forget: GitHubBoardConfig | undefined,
    title: string,
  ) => {
    setBusy(true);
    if (forget !== undefined) {
      const off = await setBoardEnabled({
        environmentId,
        input: { owner: forget.owner, number: forget.number, enabled: false },
      });
      if (off._tag === "Failure") {
        setBusy(false);
        if (!isAtomCommandInterrupted(off)) {
          toastManager.add({
            type: "error",
            title,
            description: `${forget.owner}/${forget.number} stays in the list and may already be off. ${failureText(off)}`,
          });
        }
        return false;
      }
    }
    const built = build(
      registry.get(serverEnvironment.settingsValueAtom(environmentId))?.githubBoards ?? [],
    );
    if ("problem" in built) {
      setBusy(false);
      toastManager.add({
        type: "error",
        title,
        description:
          forget === undefined
            ? built.problem
            : `${built.problem} ${forget.owner}/${forget.number} is now off; turn it on again on the Issues page.`,
      });
      return false;
    }
    const saved = await save({ githubBoards: built.next }, title);
    setBusy(false);
    if (saved === "Failure" && forget !== undefined) {
      toastManager.add({
        type: "warning",
        title: `${forget.owner}/${forget.number} is off`,
        description: "It stays in the list; turn it on again on the Issues page.",
      });
    }
    return saved === "Success";
  };

  const saveEdited = async (draft: GitHubBoardDraft) => {
    const target = editing?.target ?? null;
    const original = editingIndex === null ? undefined : boards[editingIndex];
    const renamed =
      original !== undefined &&
      boardKey(original) !== boardKey({ owner: draft.owner, number: Number(draft.number) });
    const build = (current: ReadonlyArray<GitHubBoardConfig>): Built => {
      const at = target === null ? -1 : boardIndex(current, target);
      if (target !== null && at === -1)
        return { problem: `${named(target)} is no longer in the list as it was.` };
      const problem = Object.values(boardProblems(draft, current, at === -1 ? null : at))[0];
      if (problem !== undefined) return { problem };
      const board = boardFromDraft(draft, at === -1 ? null : current[at]!);
      return {
        next: at === -1 ? [...current, board] : current.map((item, i) => (i === at ? board : item)),
      };
    };
    if (await saveBoards(build, renamed ? original : undefined, "GitHub board not saved")) {
      setEditing(null);
    }
  };

  const remove = async (target: Target) => {
    setRemoving(null);
    await saveBoards(
      (current) => {
        const at = boardIndex(current, target);
        return at === -1
          ? { problem: `${named(target)} is no longer in the list as it was.` }
          : { next: current.filter((_, i) => i !== at) };
      },
      boards[boardIndex(boards, target)],
      `${named(target)} not removed`,
    );
  };

  return (
    <SettingsSection
      id={searchableSetting("github-boards").id}
      title="GitHub boards"
      headerAction={
        <Button
          size="sm"
          variant="outline"
          disabled={!canEdit || busy}
          onClick={() => setEditing({ target: null })}
        >
          <PlusIcon className="size-3.5" /> Add board
        </Button>
      }
    >
      {canEdit ? null : (
        <p className="px-3 py-3 text-xs text-muted-foreground sm:px-4">
          This connection lacks permission to change settings on {environmentLabel}.
        </p>
      )}
      {boards.length === 0 ? (
        <p className="px-3 py-3 text-sm text-muted-foreground sm:px-4">
          No boards yet. Add one to list its issues on the Issues page.
        </p>
      ) : (
        boards.map((board, index) => (
          <div
            // A hand-written file can name a board twice: the later ones count their turn.
            key={`${boardKey(board)}#${boards.slice(0, index).filter((other) => boardKey(other) === boardKey(board)).length}`}
            className="flex items-center gap-3 px-3 py-3 first:rounded-t-xl sm:px-4"
          >
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">
                {board.owner}/{board.number}
              </p>
              <p className="truncate text-xs text-muted-foreground">
                Status field: {board.statusField}
                {board.waitForBlockers ? " · Waits for blockers" : ""}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <Button
                size="sm"
                variant="outline"
                disabled={!canEdit || busy}
                onClick={() => setEditing({ target: { index, board } })}
              >
                Edit
              </Button>
              <Menu>
                <MenuTrigger
                  render={
                    <Button
                      size="icon-sm"
                      variant="ghost-muted"
                      disabled={!canEdit || busy}
                      aria-label={`More for ${board.owner}/${board.number}`}
                    />
                  }
                >
                  <MoreVertical />
                </MenuTrigger>
                <MenuPopup align="end">
                  <MenuItem variant="destructive" onClick={() => setRemoving({ index, board })}>
                    Remove
                  </MenuItem>
                </MenuPopup>
              </Menu>
            </div>
          </div>
        ))
      )}
      <ReadIntervalRow
        seconds={Math.round(Duration.toMillis(interval) / 1_000)}
        disabled={!canEdit}
        onCommit={(seconds, onFailed) =>
          void save(
            { githubBoardReadInterval: Duration.seconds(seconds) },
            "Board read interval not saved",
          ).then((saved) => {
            if (saved !== "Success") onFailed();
          })
        }
      />
      <SettingsRow
        title="Issue threads at once"
        description="How many issue threads a playbook or Start runs together. Your own messages are not limited."
        control={
          <Select
            value={String(limit)}
            disabled={!canEdit}
            onValueChange={(next) => {
              if (next !== null && next !== String(limit)) {
                void save({ maxRunningIssueThreads: Number(next) }, "Thread limit not saved");
              }
            }}
          >
            <SelectTrigger aria-label="Issue threads at once" size="sm" className="w-24">
              <SelectValue>{String(limit)}</SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {THREAD_LIMITS.map((value) => (
                <SelectItem key={value} value={value}>
                  {value}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
      {editing === null ? null : (
        <BoardEditor
          key={editing.target === null ? "new" : `${editing.target.index}`}
          board={editing.target?.board ?? null}
          editingIndex={editingIndex}
          boards={boards}
          busy={busy}
          onSave={(draft) => void saveEdited(draft)}
          onClose={() => setEditing(null)}
        />
      )}
      <AlertDialog
        open={removingBoard !== undefined}
        onOpenChange={(open) => {
          if (!open) setRemoving(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Remove {removingBoard?.owner}/{removingBoard?.number}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Its issues' open threads stay open, and nothing more starts or settles from it.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button
              variant="destructive"
              onClick={() => {
                if (removing !== null) void remove(removing);
              }}
            >
              Remove board
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </SettingsSection>
  );
}

/** Seconds, as the other Settings intervals; a value under 10 is refused rather than raised. */
function ReadIntervalRow({
  seconds,
  disabled,
  onCommit,
}: {
  readonly seconds: number;
  readonly disabled: boolean;
  readonly onCommit: (seconds: number, onFailed: () => void) => void;
}) {
  // As IntervalSecondsField: a failed save falls back only if no later value was committed.
  const [field, setField] = useState({
    saved: seconds,
    draft: seconds as number | null,
    committed: seconds,
    revision: 0,
  });
  if (field.saved !== seconds) {
    setField({ ...field, saved: seconds, draft: seconds, committed: seconds });
  }
  const problem = intervalProblem(field.draft);
  return (
    <SettingsRow
      title="Board read interval"
      description={`How often the server reads the boards that are on, whether or not the Issues page is open. At least ${MIN_BOARD_READ_INTERVAL_SECONDS} seconds.`}
      status={
        problem ? (
          <span id="github-board-interval-problem" className="text-destructive">
            {problem}
          </span>
        ) : undefined
      }
      control={
        <>
          <NumberField
            value={field.draft}
            step={30}
            size="sm"
            className="w-32"
            disabled={disabled}
            onValueChange={(draft) => setField((current) => ({ ...current, draft }))}
            onValueCommitted={(next) => {
              if (next === null || intervalProblem(next) !== null) return;
              const rounded = Math.round(next);
              if (rounded === field.committed) {
                setField((current) => ({ ...current, draft: rounded }));
                return;
              }
              const revision = field.revision + 1;
              setField((current) => ({ ...current, draft: rounded, committed: rounded, revision }));
              onCommit(rounded, () =>
                setField((current) =>
                  current.revision !== revision
                    ? current
                    : {
                        ...current,
                        committed: current.saved,
                        draft: current.draft === rounded ? current.saved : current.draft,
                      },
                ),
              );
            }}
          >
            <NumberFieldGroup>
              <NumberFieldDecrement aria-label="Decrease board read interval" />
              <NumberFieldInput
                aria-label="Board read interval in seconds"
                aria-invalid={problem !== null || undefined}
                aria-describedby={problem ? "github-board-interval-problem" : undefined}
              />
              <NumberFieldIncrement aria-label="Increase board read interval" />
            </NumberFieldGroup>
          </NumberField>
          <span className="text-xs text-muted-foreground">seconds</span>
        </>
      }
    />
  );
}

function BoardEditor({
  board,
  editingIndex,
  boards,
  busy,
  onSave,
  onClose,
}: {
  /** The board as the dialog opened it; null for a new board. */
  readonly board: GitHubBoardConfig | null;
  /** Where that board is in the list now; -1 once it changed or left the list. */
  readonly editingIndex: number | null;
  readonly boards: ReadonlyArray<GitHubBoardConfig>;
  readonly busy: boolean;
  readonly onSave: (draft: GitHubBoardDraft) => void;
  readonly onClose: () => void;
}) {
  const [draft, setDraft] = useState<GitHubBoardDraft>(() => boardDraft(board));
  // Each reason shows once its field was left or Save was pressed, not while the dialog opens.
  const [touched, setTouched] = useState<ReadonlySet<keyof GitHubBoardDraft>>(new Set());
  const [submitted, setSubmitted] = useState(false);
  const problems = boardProblems(draft, boards, editingIndex);
  const stale = editingIndex === -1;
  const valid = Object.keys(problems).length === 0 && !stale;
  const shown = (field: "owner" | "number" | "statusField") =>
    submitted || touched.has(field) ? problems[field] : undefined;
  const field = (name: "owner" | "number" | "statusField", label: string, placeholder: string) => (
    <div className="grid gap-1.5">
      <Label htmlFor={`github-board-${name}`}>{label}</Label>
      <Input
        id={`github-board-${name}`}
        value={draft[name]}
        placeholder={placeholder}
        inputMode={name === "number" ? "numeric" : undefined}
        aria-invalid={shown(name) !== undefined || undefined}
        aria-describedby={shown(name) ? `github-board-${name}-problem` : undefined}
        onChange={(event) => {
          const value = event.target.value;
          setDraft((current) => ({ ...current, [name]: value }));
        }}
        onBlur={() => setTouched((current) => new Set([...current, name]))}
      />
      {shown(name) ? (
        <p id={`github-board-${name}-problem`} className="text-xs text-destructive">
          {shown(name)}
        </p>
      ) : null}
    </div>
  );
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogPopup showCloseButton={!busy}>
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            setSubmitted(true);
            if (valid && !busy) onSave(draft);
          }}
        >
          <DialogHeader>
            <DialogTitle>{board === null ? "Add GitHub board" : "Edit GitHub board"}</DialogTitle>
            <DialogDescription>
              {board === null
                ? "A new board starts off; turn it on from the Issues page."
                : stale
                  ? `${board.owner}/${board.number} changed or left the list since this opened; cancel and open it again.`
                  : "A board given another owner or number starts off."}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            {/* Locked while saving, so an edit made mid-request is not lost when the dialog closes. */}
            <fieldset disabled={busy} className="grid gap-4">
              {field("owner", "Owner", "my-org")}
              {field("number", "Number", "1")}
              {field("statusField", "Status field", "Status")}
              <div className="flex items-center justify-between gap-3">
                <Label htmlFor="github-board-wait">Wait for blockers</Label>
                <Switch
                  id="github-board-wait"
                  checked={draft.waitForBlockers}
                  onCheckedChange={(waitForBlockers) =>
                    setDraft((current) => ({ ...current, waitForBlockers }))
                  }
                />
              </div>
            </fieldset>
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="ghost" disabled={busy} onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !valid}>
              Save board
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
