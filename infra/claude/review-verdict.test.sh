#!/usr/bin/env bash
# Unit tests for the review verdict gate. Run: bash infra/claude/review-verdict.test.sh
set -u

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./review-verdict.sh
. "$script_dir/review-verdict.sh"

failures=0

expect_equal() {
  local label="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then
    echo "ok — $label"
  else
    echo "FAIL — $label: expected '$expected', got '$actual'" >&2
    failures=$((failures + 1))
  fi
}

fixture() {
  local body="$1"
  local file
  file="$(mktemp)"
  printf '%s\n' "$body" > "$file"
  echo "$file"
}

f="$(fixture '### Executive Summary
| Metric | Value |
|--------|-------|
| Overall | 🔴 BLOCK |
| Security (CRITICAL) | 1 |')"
expect_equal 'BLOCK is extracted' 'BLOCK' "$(extract_verdict "$f")"
expect_equal 'BLOCK exits 1' '1' "$(verdict_exit_code "$(extract_verdict "$f")")"
rm -f "$f"

f="$(fixture '| Overall | 🟡 REQUEST CHANGES |')"
expect_equal 'REQUEST CHANGES is extracted' 'REQUEST CHANGES' "$(extract_verdict "$f")"
expect_equal 'REQUEST CHANGES exits 1' '1' "$(verdict_exit_code "$(extract_verdict "$f")")"
rm -f "$f"

f="$(fixture '| Overall | 🟢 APPROVE |')"
expect_equal 'APPROVE is extracted' 'APPROVE' "$(extract_verdict "$f")"
expect_equal 'APPROVE exits 0' '0' "$(verdict_exit_code "$(extract_verdict "$f")")"
rm -f "$f"

f="$(fixture '| Overall | BLOCK |')"
expect_equal 'verdict is read without an emoji' 'BLOCK' "$(extract_verdict "$f")"
rm -f "$f"

f="$(fixture '| **Overall** | 🔴 BLOCK |')"
expect_equal 'verdict is read with a bolded label' 'BLOCK' "$(extract_verdict "$f")"
rm -f "$f"

f="$(fixture '### Executive Summary
| Metric | Value |
|--------|-------|
| Security (CRITICAL) | 0 |')"
expect_equal 'missing verdict yields nothing' '' "$(extract_verdict "$f")"
expect_equal 'missing verdict exits 1' '1' "$(verdict_exit_code "$(extract_verdict "$f")")"
rm -f "$f"

f="$(fixture '| Overall | LOOKS FINE TO ME |')"
expect_equal 'unrecognised verdict yields nothing' '' "$(extract_verdict "$f")"
expect_equal 'unrecognised verdict exits 1' '1' "$(verdict_exit_code "$(extract_verdict "$f")")"
rm -f "$f"

f="$(fixture '| Overall | 🔴 BLOCK / 🟡 REQUEST CHANGES / 🟢 APPROVE |')"
expect_equal 'an uncollapsed template row is not a verdict' '' "$(extract_verdict "$f")"
expect_equal 'an uncollapsed template row fails closed' '1' "$(verdict_exit_code "$(extract_verdict "$f")")"
rm -f "$f"

# Case tolerance. The row grep has always been case-insensitive; these assert the
# value match agrees with it, so a review that writes `Approve` is not failed as
# an unrecognised verdict on a branch it actually approved.
f="$(fixture '| Overall | 🟢 Approve |')"
expect_equal 'a mixed-case APPROVE is recognised' 'APPROVE' "$(extract_verdict "$f")"
expect_equal 'a mixed-case APPROVE exits 0' '0' "$(verdict_exit_code "$(extract_verdict "$f")")"
rm -f "$f"

f="$(fixture '| overall | block |')"
expect_equal 'a lower-case BLOCK is recognised' 'BLOCK' "$(extract_verdict "$f")"
expect_equal 'a lower-case BLOCK exits 1' '1' "$(verdict_exit_code "$(extract_verdict "$f")")"
rm -f "$f"

f="$(fixture '| Overall | Request Changes |')"
expect_equal 'a mixed-case REQUEST CHANGES is recognised' 'REQUEST CHANGES' "$(extract_verdict "$f")"
expect_equal 'a mixed-case REQUEST CHANGES exits 1' '1' "$(verdict_exit_code "$(extract_verdict "$f")")"
rm -f "$f"

# Prose in the verdict cell must not decide the verdict, in EITHER direction.
# Scanning the whole row let a word beside the verdict outvote it: a mention of
# BLOCK failed a clean branch, and — far worse — an inflected BLOCKED left only the
# APPROVE arm able to match, so the word APPROVE sitting in the explanation passed a
# branch the review had blocked. Every non-canonical cell now fails closed instead.

f="$(fixture '| Overall | 🔴 BLOCKED — I cannot APPROVE this branch |')"
expect_equal 'an inflected BLOCKED never reads as APPROVE' '' "$(extract_verdict "$f")"
expect_equal 'an inflected BLOCKED fails closed' '1' "$(verdict_exit_code "$(extract_verdict "$f")")"
rm -f "$f"

f="$(fixture '| Overall | REQUESTING CHANGES; do not APPROVE |')"
expect_equal 'an inflected REQUEST CHANGES never reads as APPROVE' '' "$(extract_verdict "$f")"
expect_equal 'an inflected REQUEST CHANGES fails closed' '1' "$(verdict_exit_code "$(extract_verdict "$f")")"
rm -f "$f"

f="$(fixture '| Overall | 🟢 APPROVE — 0 BLOCK-level findings |')"
expect_equal 'punctuation-adjacent BLOCK does not silently pass as APPROVE' '' "$(extract_verdict "$f")"
expect_equal 'punctuation-adjacent prose fails closed' '1' "$(verdict_exit_code "$(extract_verdict "$f")")"
rm -f "$f"

f="$(fixture '| Overall | 🟢 APPROVE (no BLOCK/REQUEST CHANGES items) |')"
expect_equal 'a parenthesised mention is not a verdict' '' "$(extract_verdict "$f")"
rm -f "$f"

f="$(fixture '| Overall | APPROVED |')"
expect_equal 'APPROVED is not APPROVE' '' "$(extract_verdict "$f")"
expect_equal 'APPROVED fails closed' '1' "$(verdict_exit_code "$(extract_verdict "$f")")"
rm -f "$f"

# Near-canonical spellings fail closed too. The prompt mandates three exact tokens,
# so a hyphenated or run-together variant is an unrecognised verdict rather than
# something to guess at. Pinned so the strictness stays a decision.
f="$(fixture '| Overall | REQUEST-CHANGES |')"
expect_equal 'a hyphenated REQUEST-CHANGES is not a verdict' '' "$(extract_verdict "$f")"
expect_equal 'a hyphenated REQUEST-CHANGES fails closed' '1' "$(verdict_exit_code "$(extract_verdict "$f")")"
rm -f "$f"

# The row grep anchors on a leading pipe, which is what makes awk field 3 the value
# cell. A row without it must not reach awk at all.
f="$(fixture 'Overall | APPROVE |')"
expect_equal 'a row without the leading pipe is not matched' '' "$(extract_verdict "$f")"
expect_equal 'a row without the leading pipe fails closed' '1' "$(verdict_exit_code "$(extract_verdict "$f")")"
rm -f "$f"

if [ "$failures" -ne 0 ]; then
  echo "$failures test(s) failed" >&2
  exit 1
fi
echo 'all verdict tests passed'
