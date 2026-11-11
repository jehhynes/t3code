// Fork-only: board issues waiting for their playbook's Start (jehhynes/t3code#6).
import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, IssueBoardResult } from "@t3tools/contracts";
import { ChevronDownIcon, ClockIcon, PlayIcon, RotateCcwIcon, XIcon } from "lucide-react";
import { useState } from "react";

import { useNowMinute } from "~/hooks/useNowMinute";
import { useClientSettings } from "~/hooks/useSettings";
import { cn } from "~/lib/utils";
import { issueEnvironment } from "~/state/issues";
import { formatChatTimestampTooltip, formatUpcomingTimestamp } from "~/timestampFormat";
import { useAtomCommand } from "~/state/use-atom-command";

import { requestCustomSnooze } from "../CustomSnoozeDialog";
import { useSnoozeWakeClock } from "../Sidebar.logic";
import { pickSnoozePreset, resolveSnoozePresets } from "../Sidebar.snooze";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { Group, GroupSeparator } from "../ui/group";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuItemDetail,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { toastManager } from "../ui/toast";
import { PULL_REQUEST_ROW_CLASS } from "../pullRequest/PullRequestListRow";
import { BoardRowLines } from "./IssueBoardSection";
import {
  type WaitingIssue,
  holdText,
  isSnoozed,
  otherPlaybooks,
  waitingIssueKey,
  waitingIssues,
} from "./issueStartList.logic";
import { useIssueDraftStart } from "./useIssueDraftStart";

const ROW_CLASS = cn(PULL_REQUEST_ROW_CLASS, "@container/issue-row-meta px-3 py-2.5");

/** A thread snooze's choices for a waiting issue: the environment's presets, then Custom… (#86). */
function IssueSnoozeMenu({
  issue,
  disabled,
  onSnooze,
}: {
  issue: WaitingIssue;
  disabled: boolean;
  /** A UTC ISO time. */
  onSnooze: (until: string) => void;
}) {
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  const [open, setOpen] = useState(false);
  const { environmentId } = issue;
  const presets = open
    ? // oxlint-disable-next-line react/purity -- Presets are resolved only while the menu is open, so each opening reads a fresh time.
      resolveSnoozePresets(new Date(), timestampFormat, environmentId)
    : [];
  const label = `Snooze ${issue.entry.displayKey}`;
  return (
    <Menu open={open} onOpenChange={setOpen}>
      <MenuTrigger
        render={
          <Button
            variant="outline"
            size="icon-xs"
            disabled={disabled}
            aria-label={label}
            title={disabled ? "You cannot start threads here." : label}
          />
        }
      >
        <ClockIcon aria-hidden />
      </MenuTrigger>
      <MenuPopup align="end">
        {presets.map((preset) => (
          <MenuItem
            key={preset.id}
            onClick={() => {
              const picked = pickSnoozePreset(presets, preset.id, timestampFormat, environmentId);
              if (picked) onSnooze(picked.snoozedUntil);
            }}
          >
            {preset.label}
            <MenuItemDetail>{preset.whenLabel}</MenuItemDetail>
          </MenuItem>
        ))}
        {presets.length > 0 ? <MenuSeparator /> : null}
        <MenuItem
          onClick={async () => {
            const choice = await requestCustomSnooze();
            if (choice) onSnooze(choice.snoozedUntil);
          }}
        >
          Custom…
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}

function SnoozedRow({
  issue,
  environmentLabel,
  busy,
  onSnooze,
  onCancel,
}: {
  issue: WaitingIssue;
  environmentLabel: string | undefined;
  busy: boolean;
  /** A UTC ISO time to change the wake to, or null to wake it now. */
  onSnooze: (until: string | null) => void;
  /** Takes back a Start queued before the snooze, which otherwise runs once it wakes. */
  onCancel: () => void;
}) {
  const canStart = useAtomValue(issueEnvironment.startPlaybook.permissionAtom(issue.environmentId));
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  // Ticks only while a Snoozed row shows, so "tomorrow" turns into "today" at midnight.
  const nowMinute = useNowMinute();
  const { entry } = issue;
  return (
    <div className={ROW_CLASS}>
      <BoardRowLines
        entry={entry}
        failure={entry.startFailure ?? null}
        returned={entry.returned}
        note={
          entry.snoozedUntil == null
            ? null
            : `Wakes ${formatUpcomingTimestamp(entry.snoozedUntil, timestampFormat, Date.parse(`${nowMinute}Z`))}`
        }
      />
      {entry.startQueued === true ? (
        <Button
          variant="outline"
          size="xs"
          disabled={busy || !canStart}
          title={canStart ? "Take back the queued start" : "You cannot start threads here."}
          onClick={onCancel}
        >
          <XIcon aria-hidden />
          Cancel start
        </Button>
      ) : null}
      {entry.hasOpenThread ? null : (
        <IssueSnoozeMenu issue={issue} disabled={busy || !canStart} onSnooze={onSnooze} />
      )}
      <Button
        variant="outline"
        size="xs"
        disabled={busy || !canStart}
        title={canStart ? "Wake it now" : "You cannot start threads here."}
        onClick={() => onSnooze(null)}
      >
        Unsnooze
      </Button>
      {environmentLabel ? (
        <span className="shrink-0 text-xs text-muted-foreground">{environmentLabel}</span>
      ) : null}
    </div>
  );
}

function WaitingRow({
  issue,
  environmentLabel,
  starting,
  onStart,
  onCancel,
  onDraft,
  onSnooze,
}: {
  issue: WaitingIssue;
  environmentLabel: string | undefined;
  starting: boolean;
  onStart: () => void;
  /** Takes back a Start queued until the issue's blockers close or a slot frees. */
  onCancel: () => void;
  /** Opens a draft with the issue's own playbook, or with `use`. */
  onDraft: (use?: string) => void;
  /** A UTC ISO time (jehhynes/t3code#86). */
  onSnooze: (until: string) => void;
}) {
  const canStart = useAtomValue(issueEnvironment.startPlaybook.permissionAtom(issue.environmentId));
  const { entry } = issue;
  const failure = entry.startFailure ?? null;
  const others = otherPlaybooks(issue);
  const action = failure === null ? "Start" : "Retry";
  // Fork-only (jehhynes/t3code#93): a triage playbook's classifier holds no start of its own.
  const hold = issue.triage === null ? issue.hold : null;
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  // Fork-only (jehhynes/t3code#100): a returning issue with nothing new waits for Start.
  const nothingNew =
    issue.triage === null && hold !== "slot" && entry.nothingNewSince != null
      ? `No comment by anyone else since its earlier thread started on ${formatChatTimestampTooltip(entry.nothingNewSince, timestampFormat)}, so it waits for Start.`
      : null;
  const otherPlaybooksMenu =
    others.length === 0 ? null : (
      <MenuGroup>
        <MenuGroupLabel>With another playbook</MenuGroupLabel>
        {others.map((name) => (
          <MenuItem key={name} onClick={() => onDraft(name)}>
            {name}…
          </MenuItem>
        ))}
      </MenuGroup>
    );
  return (
    <div className={ROW_CLASS}>
      <BoardRowLines
        entry={entry}
        failure={failure}
        hold={hold === null || hold === "slot" ? null : holdText(hold, entry.blockers)}
        note={
          issue.triage === "choosing"
            ? "Choosing a playbook…"
            : hold === "slot"
              ? holdText(hold, entry.blockers)
              : nothingNew === null
                ? null
                : "Nothing is newer than its earlier thread"
        }
        noteDetail={nothingNew}
        returned={entry.returned}
      />
      {entry.projectId === null ? (
        <span className="shrink-0 text-xs text-muted-foreground">
          No T3 Code project for {entry.scope}
        </span>
      ) : issue.triage !== null ? (
        // Fork-only (jehhynes/t3code#93): Retry asks the classifier again; a draft takes a playbook I pick.
        <Group aria-label={`Start ${entry.displayKey}`}>
          {issue.triage === "failed" ? (
            <Button
              variant="outline"
              size="xs"
              disabled={starting || !canStart}
              title={
                canStart
                  ? `Let playbook ${entry.playbook} choose again`
                  : "You cannot start threads here."
              }
              onClick={onStart}
            >
              <RotateCcwIcon aria-hidden />
              Retry
            </Button>
          ) : null}
          {/* A held issue takes no draft, as the server refuses one. */}
          {otherPlaybooksMenu === null ||
          issue.hold === "waits" ||
          issue.hold === "starts" ? null : (
            <>
              {issue.triage === "failed" ? <GroupSeparator /> : null}
              <Menu>
                <MenuTrigger
                  render={
                    <Button
                      variant="outline"
                      size="icon-xs"
                      disabled={starting || !canStart}
                      aria-label="Start with another playbook"
                    />
                  }
                >
                  <ChevronDownIcon aria-hidden />
                </MenuTrigger>
                <MenuPopup align="end">{otherPlaybooksMenu}</MenuPopup>
              </Menu>
            </>
          )}
        </Group>
      ) : hold === "starts" ? (
        entry.startQueued === true ? (
          <Button
            variant="outline"
            size="xs"
            disabled={starting || !canStart}
            title={canStart ? "Take back the queued start" : "You cannot start threads here."}
            onClick={onCancel}
          >
            <XIcon aria-hidden />
            Cancel start
          </Button>
        ) : null
      ) : (
        <Group aria-label={`Start ${entry.displayKey}`}>
          {/* Fork-only (jehhynes/t3code#76): a row waiting for a slot keeps the draft menu. */}
          {hold === "slot" ? (
            entry.startQueued === true ? (
              <Button
                variant="outline"
                size="xs"
                disabled={starting || !canStart}
                title={canStart ? "Take back the queued start" : "You cannot start threads here."}
                onClick={onCancel}
              >
                <XIcon aria-hidden />
                Cancel start
              </Button>
            ) : null
          ) : (
            <Button
              variant="outline"
              size="xs"
              disabled={starting || !canStart}
              title={
                !canStart
                  ? "You cannot start threads here."
                  : hold === "waits"
                    ? `${action} playbook ${entry.playbook} once its blockers close`
                    : `${action} playbook ${entry.playbook}`
              }
              onClick={onStart}
            >
              {failure === null ? <PlayIcon aria-hidden /> : <RotateCcwIcon aria-hidden />}
              {action}
            </Button>
          )}
          {issue.playbooks === undefined || hold === "waits" ? null : (
            <>
              {hold === "slot" && entry.startQueued !== true ? null : <GroupSeparator />}
              <Menu>
                <MenuTrigger
                  render={
                    <Button
                      variant="outline"
                      size="icon-xs"
                      disabled={starting || !canStart}
                      aria-label="More ways to start"
                    />
                  }
                >
                  <ChevronDownIcon aria-hidden />
                </MenuTrigger>
                <MenuPopup align="end">
                  <MenuItem onClick={() => onDraft()}>Start with guidance…</MenuItem>
                  {otherPlaybooksMenu === null ? null : (
                    <>
                      <MenuSeparator />
                      {otherPlaybooksMenu}
                    </>
                  )}
                </MenuPopup>
              </Menu>
            </>
          )}
        </Group>
      )}
      {/* An issue with an open thread is snoozed by snoozing its thread. */}
      {entry.hasOpenThread ? null : (
        <IssueSnoozeMenu issue={issue} disabled={starting || !canStart} onSnooze={onSnooze} />
      )}
      {environmentLabel ? (
        <span className="shrink-0 text-xs text-muted-foreground">{environmentLabel}</span>
      ) : null}
    </div>
  );
}

export function IssueStartList({
  answers,
  query,
  environmentLabels,
}: {
  /** The latest board answers; a new array arrives with each answer the server publishes. */
  answers: ReadonlyArray<readonly [EnvironmentId, IssueBoardResult]>;
  /** Narrows rows by title or key, as the boards are narrowed. */
  query: string;
  /** Each environment's label, where the page spans more than one. */
  environmentLabels: ReadonlyMap<EnvironmentId, string> | null;
}) {
  const startPlaybook = useAtomCommand(issueEnvironment.startPlaybook, {
    label: "issue playbook start",
  });
  const openDraft = useIssueDraftStart();
  const [starting, setStarting] = useState<ReadonlySet<string>>(new Set());
  // The server publishes the boards again after a Start; a started issue stays hidden while its
  // environment still shows the answer it was started from.
  const [started, setStarted] = useState<
    ReadonlyMap<string, { environmentId: EnvironmentId; answer: IssueBoardResult }>
  >(new Map());
  const answerOf = (environmentId: EnvironmentId) =>
    answers.find(([candidate]) => candidate === environmentId)?.[1];
  const stillHidden = [...started].filter(
    ([, { environmentId, answer }]) => answerOf(environmentId) === answer,
  );
  if (stillHidden.length !== started.size) setStarted(new Map(stillHidden));

  const needle = query.toLowerCase();
  const listed = waitingIssues(answers).filter(
    (issue) =>
      !started.has(waitingIssueKey(issue)) &&
      (needle.length === 0 ||
        issue.entry.title.toLowerCase().includes(needle) ||
        issue.entry.displayKey.toLowerCase().includes(needle)),
  );
  // Fork-only (jehhynes/t3code#86): re-renders once at the earliest wake, with no timer when
  // nothing is snoozed.
  const nowMs = useSnoozeWakeClock(listed.map((issue) => issue.entry));
  const issues = listed.filter((issue) => !isSnoozed(issue, nowMs));
  const snoozed = listed.filter((issue) => isSnoozed(issue, nowMs));
  if (listed.length === 0) return null;

  const start = async (issue: WaitingIssue) => {
    const key = waitingIssueKey(issue);
    setStarting((current) => new Set([...current, key]));
    const result = await startPlaybook({
      environmentId: issue.environmentId,
      input: { playbook: issue.entry.playbook, entry: issue.entry },
    });
    setStarting((current) => new Set([...current].filter((candidate) => candidate !== key)));
    // A Start queued behind open blockers keeps the row, which then says it is queued.
    if (result._tag === "Success" && result.value.threadId === null) return;
    if (result._tag === "Success") {
      const answer = answerOf(issue.environmentId);
      if (answer !== undefined) {
        const environmentId = issue.environmentId;
        setStarted((current) => new Map(current).set(key, { environmentId, answer }));
      }
      return;
    }
    if (!isAtomCommandInterrupted(result)) {
      const failure = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: `Could not start ${issue.entry.displayKey} with playbook ${issue.entry.playbook}`,
        description:
          typeof failure === "object" && failure !== null && "detail" in failure
            ? String(failure.detail)
            : String(failure),
      });
    }
  };

  const cancel = async (issue: WaitingIssue) => {
    const key = waitingIssueKey(issue);
    setStarting((current) => new Set([...current, key]));
    const result = await startPlaybook({
      environmentId: issue.environmentId,
      input: { playbook: issue.entry.playbook, cancelQueued: issue.entry },
    });
    setStarting((current) => new Set([...current].filter((candidate) => candidate !== key)));
    if (result._tag === "Success" || isAtomCommandInterrupted(result)) return;
    const failure = squashAtomCommandFailure(result);
    toastManager.add({
      type: "error",
      title: `Could not take back the start of ${issue.entry.displayKey}`,
      description:
        typeof failure === "object" && failure !== null && "detail" in failure
          ? String(failure.detail)
          : String(failure),
    });
  };

  const snooze = async (issue: WaitingIssue, until: string | null) => {
    const key = waitingIssueKey(issue);
    setStarting((current) => new Set([...current, key]));
    const result = await startPlaybook({
      environmentId: issue.environmentId,
      input: { playbook: issue.entry.playbook, snooze: issue.entry, until },
    });
    setStarting((current) => new Set([...current].filter((candidate) => candidate !== key)));
    if (result._tag === "Success" || isAtomCommandInterrupted(result)) return;
    const failure = squashAtomCommandFailure(result);
    toastManager.add({
      type: "error",
      title: `Could not ${until === null ? "unsnooze" : "snooze"} ${issue.entry.displayKey}`,
      description:
        typeof failure === "object" && failure !== null && "detail" in failure
          ? String(failure.detail)
          : String(failure),
    });
  };

  return (
    <>
      {issues.length === 0 ? null : (
        <section className="flex flex-col gap-1" aria-label="Waiting to start">
          <h2 className="flex items-center gap-1.5 px-3 text-xs font-medium text-muted-foreground">
            <PlayIcon aria-hidden className="size-3.5" />
            Waiting to start
          </h2>
          <div className="flex flex-col">
            {issues.map((issue) => {
              const key = waitingIssueKey(issue);
              return (
                <WaitingRow
                  key={key}
                  issue={issue}
                  environmentLabel={environmentLabels?.get(issue.environmentId)}
                  starting={starting.has(key)}
                  onStart={() => void start(issue)}
                  onCancel={() => void cancel(issue)}
                  onDraft={(use) => void openDraft(issue, use)}
                  onSnooze={(until) => void snooze(issue, until)}
                />
              );
            })}
          </div>
        </section>
      )}
      {snoozed.length === 0 ? null : (
        <Collapsible render={<section aria-label="Snoozed" />} className="flex flex-col gap-1">
          <h2 className="px-3 text-xs font-medium text-muted-foreground">
            <CollapsibleTrigger className="flex items-center gap-1.5 hover:text-foreground data-panel-open:[&_svg:last-child]:rotate-0">
              <ClockIcon aria-hidden className="size-3.5" />
              Snoozed
              <span className="font-normal">{snoozed.length}</span>
              <ChevronDownIcon aria-hidden className="size-3 -rotate-90" />
            </CollapsibleTrigger>
          </h2>
          <CollapsiblePanel animate={false} className="flex flex-col">
            {snoozed.map((issue) => {
              const key = waitingIssueKey(issue);
              return (
                <SnoozedRow
                  key={key}
                  issue={issue}
                  environmentLabel={environmentLabels?.get(issue.environmentId)}
                  busy={starting.has(key)}
                  onSnooze={(until) => void snooze(issue, until)}
                  onCancel={() => void cancel(issue)}
                />
              );
            })}
          </CollapsiblePanel>
        </Collapsible>
      )}
    </>
  );
}
