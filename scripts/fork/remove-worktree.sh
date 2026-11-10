#!/usr/bin/env bash
# Removes a clean linked worktree. Copies its ignored .wip/ to the main checkout's
# .wip/shipped/<folder>/ and stops only processes found as port owners whose cwd is
# inside the worktree (AGENTS.md rule 1), so the agent that runs this survives.
set -euo pipefail

target=$(realpath "${1:?usage: remove-worktree.sh <worktree path>}")
main=$(git -C "$target" worktree list --porcelain | sed -n '1s/^worktree //p')

if [ "$target" = "$main" ]; then
  echo "remove-worktree: $target is the main checkout" >&2
  exit 1
fi
if ! git -C "$main" worktree list --porcelain | grep -qxF "worktree $target"; then
  echo "remove-worktree: $target is not a linked worktree of $main" >&2
  exit 1
fi
if [ -n "$(git -C "$target" status --porcelain)" ]; then
  echo "remove-worktree: $target has uncommitted or untracked changes" >&2
  git -C "$target" status --short >&2
  exit 1
fi

if [ -d "$target/.wip" ]; then
  dest="$main/.wip/shipped/$(basename "$target")"
  while IFS= read -r -d '' file; do
    rel=${file#"$target/.wip/"}
    if [ -e "$dest/$rel" ] && ! cmp -s "$file" "$dest/$rel"; then
      echo "remove-worktree: $dest/$rel already exists with different content" >&2
      exit 1
    fi
  done < <(find "$target/.wip" -type f -print0)
  mkdir -p "$dest"
  cp -a "$target/.wip/." "$dest/"
  echo "remove-worktree: kept .wip/ in $dest"
fi

# Stop a listener's whole process group, so its dev runner and workers stop too, only
# when every member's cwd is inside the worktree and the group holds no ancestor of
# this script; otherwise stop the listener alone.
protected=" "
pid=$$
while [ "$pid" -gt 1 ]; do
  protected+="$(ps -o pgid= -p "$pid" | tr -d ' ') "
  pid=$(ps -o ppid= -p "$pid" | tr -d ' ')
done
stopped=()
for pid in $(ss -H -ltnp | grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -u); do
  cwd=$(readlink "/proc/$pid/cwd" 2>/dev/null) || continue
  case "$cwd/" in
    "$target"/*) ;;
    *) continue ;;
  esac
  pgid=$(ps -o pgid= -p "$pid" | tr -d ' ')
  whole_group=yes
  [[ "$protected" == *" $pgid "* ]] && whole_group=no
  for member in $(pgrep -g "$pgid"); do
    member_cwd=$(readlink "/proc/$member/cwd" 2>/dev/null) || continue
    case "$member_cwd/" in
      "$target"/*) ;;
      *) whole_group=no ;;
    esac
  done
  if [ "$whole_group" = yes ]; then
    kill -- "-$pgid" 2>/dev/null && stopped+=("$pid")
  else
    kill "$pid" 2>/dev/null && stopped+=("$pid")
  fi
done
for pid in "${stopped[@]}"; do
  for _ in $(seq 50); do
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.2
  done
  if kill -0 "$pid" 2>/dev/null; then
    echo "remove-worktree: process $pid in $target did not stop" >&2
    exit 1
  fi
  echo "remove-worktree: stopped process $pid"
done

git -C "$main" worktree remove "$target"
echo "remove-worktree: removed $target"
