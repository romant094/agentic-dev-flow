#!/usr/bin/env bash
# Verdict parsing for the AI code review gate.
#
# The verdict is not invented here. infra/claude/review-prompt.md mandates an
# Executive Summary row `| Overall | ... |` and defines its three values:
# BLOCK on any CRITICAL finding, REQUEST CHANGES on any HIGH finding, APPROVE
# otherwise. This file only reads what the prompt already states.
#
# Pure functions, no side effects, no exit — so the gate is unit-testable
# without running the network-bound review.sh.

# Prints the verdict found in the review file, or nothing.
# Returns 0 when a recognised verdict was printed, 1 otherwise.
extract_verdict() {
  local file="$1" row cell
  row="$(grep -m1 -i '^[[:space:]]*|[[:space:]]*\**Overall\**[[:space:]]*|' "$file" 2>/dev/null)" || true
  [ -n "$row" ] || return 1

  # The verdict is the row's VALUE CELL — the text between the second and third
  # pipe — never the whole row, and it is compared for equality rather than
  # searched for a mentioned token. Scanning the row let prose beside the verdict
  # decide it, in both directions and both harmful:
  #
  #   `APPROVE - 0 BLOCK-level findings`  read as BLOCK   -> failed a clean branch
  #   `BLOCKED - I cannot APPROVE this`   read as APPROVE -> passed a blocked one
  #
  # The second is the dangerous one: a severe verdict in an inflected form leaves
  # only the APPROVE arm able to match, and it matched the word sitting in the
  # explanation. Reducing to the cell and comparing exactly removes the whole class
  # instead of one member of it, and every non-canonical cell now fails closed.
  #
  # Stripping to [A-Z ] discards the emoji and punctuation the prompt's own format
  # puts in this cell; `REQUEST CHANGES` keeps its space, which is why the space is
  # kept and runs of it are squeezed.
  #
  # `$3` is the value cell only because the grep above anchors the row on
  # `^[[:space:]]*|` — with the leading pipe guaranteed, field 1 is what precedes it,
  # field 2 is the label and field 3 is the value. That coupling is load-bearing: a
  # row without the leading pipe never matches the grep and never reaches awk, so the
  # index is an invariant rather than an assumption. Relax the row pattern and this
  # field number has to be revisited with it.
  #
  # BRE, not `sed -E`. -E is not in POSIX sed and this runs on the CI image's busybox,
  # which cannot be verified from a developer machine — the same reason `grep -w` was
  # rejected here, and the same failure mode if the bet is wrong: sed errors, `cell` is
  # empty, and every merge request answers "no recognised verdict". The BRE spelling
  # costs nothing, so there is no reason to take the bet at all.
  cell="$(printf '%s' "$row" | awk -F'|' '{print $3}' \
    | tr '[:lower:]' '[:upper:]' \
    | sed 's/[^A-Z ]//g; s/^ *//; s/ *$//; s/  */ /g')"

  case "$cell" in
    BLOCK|'REQUEST CHANGES'|APPROVE) echo "$cell" ;;
    *)                               return 1 ;;
  esac
}

# Prints the exit code the gate should use for a verdict.
# An empty or unrecognised verdict is blocking: a review whose verdict cannot
# be read is a review that did not happen, and must not pass as an approval.
verdict_exit_code() {
  case "$1" in
    APPROVE) echo 0 ;;
    *)       echo 1 ;;
  esac
}
