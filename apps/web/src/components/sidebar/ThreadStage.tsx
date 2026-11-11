// Fork-only (jehhynes/t3code#73): what a running thread is working on, from its shell's stage.
import { ListTodoIcon } from "lucide-react";

import type { SidebarThreadSummary } from "../../types";
import { textDirection } from "~/textDirection";

export function threadStage(thread: SidebarThreadSummary): string | null {
  return thread.source.stage ?? null;
}

export function ThreadStageLabel(props: { stage: string }) {
  return (
    <span
      className="min-w-0 flex-1 truncate font-normal text-secondary-label text-xs"
      dir={textDirection(props.stage)}
    >
      {props.stage}
    </span>
  );
}

export function ThreadStageHoverLine(props: { thread: SidebarThreadSummary }) {
  const stage = threadStage(props.thread);
  if (stage === null) return null;
  return (
    <div className="flex min-w-0 items-start gap-2">
      <ListTodoIcon aria-hidden className="mt-0.5 size-3 shrink-0 stroke-muted-foreground" />
      <div className="min-w-0 flex-1 wrap-break-word text-foreground/75" dir={textDirection(stage)}>
        {stage}
      </div>
    </div>
  );
}
