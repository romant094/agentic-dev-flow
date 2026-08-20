#!/usr/bin/env bash
set -e

CLAUDE_MODEL="${CLAUDE_MODEL:-claude-opus-5}"

# max_tokens caps thinking AND response text together. Claude Opus 5 thinks by default,
# so a budget sized for a thinking-off model truncates the review instead of the reasoning
# — and a truncated review fails the structural check below with exit 1, turning a config
# problem into a red pipeline. Hence the headroom.
CLAUDE_MAX_TOKENS="${CLAUDE_MAX_TOKENS:-32000}"

# adaptive | disabled. Keep adaptive: with thinking off, Claude Opus 5 can leak literal
# <thinking> tags into the visible response, which would land in claude-review.md. Lower
# CLAUDE_EFFORT to cut cost instead of switching this off.
CLAUDE_THINKING="${CLAUDE_THINKING:-adaptive}"

# low | medium | high | xhigh | max. The primary cost and latency lever — low and medium
# are strong on Claude Opus 5, and the review stays accurate there. Default medium.
CLAUDE_EFFORT="${CLAUDE_EFFORT:-medium}"

case "$CLAUDE_THINKING" in
  adaptive|disabled) ;;
  *) echo "CLAUDE_THINKING must be 'adaptive' or 'disabled', got '${CLAUDE_THINKING}'" >&2; exit 2 ;;
esac

case "$CLAUDE_EFFORT" in
  low|medium|high|xhigh|max) ;;
  *) echo "CLAUDE_EFFORT must be one of low medium high xhigh max, got '${CLAUDE_EFFORT}'" >&2; exit 2 ;;
esac

# The API rejects disabled thinking above 'high' effort with a 400. Catch it here, where it
# is a named configuration error and exit 2, rather than as an opaque API failure.
if [ "$CLAUDE_THINKING" = "disabled" ]; then
  case "$CLAUDE_EFFORT" in
    xhigh|max)
      echo "CLAUDE_THINKING=disabled is not accepted at CLAUDE_EFFORT=${CLAUDE_EFFORT} — use high or lower" >&2
      exit 2 ;;
  esac
fi

# Per-million-token list prices, used only for the cost line in the report. They are not
# discoverable from the API, so a model change needs a matching entry here or the reported
# cost silently describes a different model. Override any of them to correct a stale rate
# without editing this file.
case "$CLAUDE_MODEL" in
  claude-opus-5*|claude-opus-4-*|claude-fable-5*|claude-mythos-5*)
    PRICE_IN_DEFAULT=5.00;  PRICE_OUT_DEFAULT=25.00 ;;
  claude-sonnet-*)
    PRICE_IN_DEFAULT=3.00;  PRICE_OUT_DEFAULT=15.00 ;;
  claude-haiku-*)
    PRICE_IN_DEFAULT=1.00;  PRICE_OUT_DEFAULT=5.00 ;;
  *)
    # Unknown model: report zero rather than a confidently wrong number.
    PRICE_IN_DEFAULT=0;     PRICE_OUT_DEFAULT=0
    echo "[claude-review] no price table entry for ${CLAUDE_MODEL}; reported cost will be 0" >&2 ;;
esac

CLAUDE_PRICE_INPUT="${CLAUDE_PRICE_INPUT:-$PRICE_IN_DEFAULT}"
CLAUDE_PRICE_OUTPUT="${CLAUDE_PRICE_OUTPUT:-$PRICE_OUT_DEFAULT}"
# Cache writes bill at 1.25x input, cache reads at 0.1x input.
CLAUDE_PRICE_CACHE_WRITE="${CLAUDE_PRICE_CACHE_WRITE:-$(awk "BEGIN{printf \"%.4f\", $CLAUDE_PRICE_INPUT*1.25}")}"
CLAUDE_PRICE_CACHE_READ="${CLAUDE_PRICE_CACHE_READ:-$(awk "BEGIN{printf \"%.4f\", $CLAUDE_PRICE_INPUT*0.1}")}"

# shellcheck source=./review-verdict.sh
. "$(dirname "${BASH_SOURCE[0]}")/review-verdict.sh"

# The forge host: GITLAB_HOST overrides, CI_SERVER_HOST is predefined inside GitLab CI.
# Unset is a configuration error, not a review outcome, so it exits 2 like the other
# transport failures below and leaves the pipeline yellow rather than red.
GITLAB_HOST="${GITLAB_HOST:-${CI_SERVER_HOST:-}}"
if [ -z "$GITLAB_HOST" ]; then
  echo "Neither GITLAB_HOST nor CI_SERVER_HOST is set, so the merge request API host is unknown" >&2
  exit 2
fi

# Available models: https://platform.claude.com/docs/en/about-claude/models/overview
echo "[claude-review] model=${CLAUDE_MODEL} max_tokens=${CLAUDE_MAX_TOKENS} thinking=${CLAUDE_THINKING} effort=${CLAUDE_EFFORT}" >&2

rm -f .env ~/.ssh/id_rsa

# All temp files cleaned up unconditionally on exit
MR_DIFF_JSON=$(mktemp)
MR_DIFF=$(mktemp)
PAYLOAD_FILE=$(mktemp)
CURL_CONFIG=$(mktemp)
COMMENT_FILE=$(mktemp)
chmod 600 "$CURL_CONFIG"
trap 'rm -f "$MR_DIFF_JSON" "$MR_DIFF" "$PAYLOAD_FILE" "$CURL_CONFIG" "$COMMENT_FILE"' EXIT INT TERM

curl --fail \
  --header "PRIVATE-TOKEN: $GITLAB_API_TOKEN" \
  "https://$GITLAB_HOST/api/v4/projects/${CI_PROJECT_ID}/merge_requests/$CI_MERGE_REQUEST_IID/diffs" \
  > "$MR_DIFF_JSON" || {
  echo "Could not fetch the merge request diff from GitLab — transport failure, not a review outcome" >&2
  exit 2
}

# A 200 with a non-JSON body (proxy interstitial, gateway page, truncated stream) would
# make the jq below exit 5 under `set -e` — neither the gate's 0/1 nor the pipeline's
# allowed 2. Validate the body first so a transport problem stays a transport problem.
jq -e . "$MR_DIFF_JSON" >/dev/null 2>&1 || {
  echo "GitLab returned a merge request diff that is not JSON — transport failure, not a review outcome" >&2
  exit 2
}

# Convert to unified diff, skip generated/lock files (anchored patterns)
jq -r '
  .[] |
  select(
    .diff != "" and
    .collapsed != true and
    (.new_path | test(
      "(^|/)package-lock\\.json$|(^|/)yarn\\.lock$|(^|/)pnpm-lock\\.yaml$|\\.min\\.js$|\\.min\\.css$|\\.map$|(^|/)dist/|(^|\\.)(generated)\\.|/__snapshots__/|(^|/)coverage/"
    ) | not)
  ) |
  "diff --git a/\(.old_path) b/\(.new_path)\n--- a/\(.old_path)\n+++ b/\(.new_path)\n\(.diff)"
' "$MR_DIFF_JSON" > "$MR_DIFF"

# Both the prompt and the diff are read from files rather than passed as arguments.
# `--arg diff "$(cat ...)"` puts the whole diff in a single argv entry, and Linux caps one
# argument at MAX_ARG_STRLEN — 128 KiB — independently of the much larger ARG_MAX total.
# A 137 KiB diff killed this job with "Argument list too long", exit 126: neither the
# gate's 0/1 nor the pipeline's allowed 2, so a large merge request failed the pipeline
# for a reason that had nothing to do with its code. Do not "verify" this on macOS, which
# imposes no per-argument limit and passes at any size the CI runner would reject.
jq -n \
  --rawfile prompt infra/claude/review-prompt.md \
  --rawfile diff "$MR_DIFF" \
  --arg model "$CLAUDE_MODEL" \
  --argjson max_tokens "$CLAUDE_MAX_TOKENS" \
  --arg thinking "$CLAUDE_THINKING" \
  --arg effort "$CLAUDE_EFFORT" \
  '{
    model: $model,
    max_tokens: $max_tokens,
    thinking: {type: $thinking},
    output_config: {effort: $effort},
    messages: [{
      role: "user",
      content: [
        {type: "text", text: $prompt, cache_control: {type: "ephemeral"}},
        {type: "text", text: ("Here is the MR diff:\n" + $diff)}
      ]
    }]
  }' > "$PAYLOAD_FILE"

# Pass API key via curl config file to avoid /proc/cmdline exposure on shared runners
echo "header = \"x-api-key: $ANTHROPIC_API_KEY\"" > "$CURL_CONFIG"
unset ANTHROPIC_API_KEY

RESPONSE=$(curl --fail -s https://api.anthropic.com/v1/messages \
  --tlsv1.2 \
  --ssl-reqd \
  --config "$CURL_CONFIG" \
  --header "anthropic-version: 2023-06-01" \
  --header "anthropic-beta: prompt-caching-2024-07-31" \
  --header "Content-Type: application/json" \
  --data "@$PAYLOAD_FILE") || {
  echo "Anthropic API call failed — transport failure, not a review outcome" >&2
  exit 2
}

# Same guard as the diff payload: a non-JSON 200 must not reach the jq extractions below,
# where its exit 5 would become this script's exit status.
printf '%s' "$RESPONSE" | jq -e . >/dev/null 2>&1 || {
  echo "Anthropic API returned a body that is not JSON — transport failure, not a review outcome" >&2
  exit 2
}

# Parse response once
MODEL=$(echo "$RESPONSE" | jq -r '.model')
STOP_REASON=$(echo "$RESPONSE" | jq -r '.stop_reason')
USAGE=$(echo "$RESPONSE" | jq '.usage')
CONTENT_TYPE=$(echo "$RESPONSE" | jq -r '.type')
REVIEW_TEXT=$(echo "$RESPONSE" | jq -r '[.content[] | select(.type == "text")][0].text')

# Audit log for IEC 62443-3-3 SR 2.8 change-management trail
jq -n \
  --arg timestamp "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg mr "$CI_MERGE_REQUEST_IID" \
  --arg project "$CI_PROJECT_ID" \
  --arg actor "$GITLAB_USER_LOGIN" \
  --arg target_branch "$CI_MERGE_REQUEST_TARGET_BRANCH_NAME" \
  --arg model "$MODEL" \
  --arg stop_reason "$STOP_REASON" \
  --argjson usage "$USAGE" \
  '{
    timestamp: $timestamp, mr: $mr, project: $project,
    actor: $actor, target_branch: $target_branch,
    model: $model, stop_reason: $stop_reason, usage: $usage
  }' >&2

# Check for application-level API errors (log type only, not raw message — CWE-532)
if [ "$CONTENT_TYPE" = "error" ]; then
  ERROR_TYPE=$(echo "$RESPONSE" | jq -r '.error.type')
  echo "Anthropic API returned an application error (type=${ERROR_TYPE}). Check runner secrets configuration. Transport failure, not a review outcome." >&2
  exit 2
fi

if [ "$STOP_REASON" != "end_turn" ]; then
  echo "WARNING: Claude response was truncated (stop_reason=$STOP_REASON)" >&2
fi

if [ -z "$REVIEW_TEXT" ] || [ "$REVIEW_TEXT" = "null" ]; then
  echo "Anthropic API returned empty content — transport failure, not a review outcome" >&2
  exit 2
fi

# Structural validation to catch severe truncation or prompt injection
if ! echo "$REVIEW_TEXT" | grep -q "### Executive Summary"; then
  echo "ERROR: Review output missing expected structure (possible truncation or prompt injection)" >&2
  exit 1
fi

INPUT_TOKENS=$(echo "$USAGE" | jq -r '.input_tokens // 0')
OUTPUT_TOKENS=$(echo "$USAGE" | jq -r '.output_tokens // 0')
CACHE_WRITE_TOKENS=$(echo "$USAGE" | jq -r '.cache_creation_input_tokens // 0')
CACHE_READ_TOKENS=$(echo "$USAGE" | jq -r '.cache_read_input_tokens // 0')

COST=$(awk "BEGIN { printf \"%.4f\",
  ($INPUT_TOKENS/1000000*$CLAUDE_PRICE_INPUT) +
  ($OUTPUT_TOKENS/1000000*$CLAUDE_PRICE_OUTPUT) +
  ($CACHE_WRITE_TOKENS/1000000*$CLAUDE_PRICE_CACHE_WRITE) +
  ($CACHE_READ_TOKENS/1000000*$CLAUDE_PRICE_CACHE_READ)
}")

MODEL_HEADER="> 🤖 **Model:** ${MODEL}"
COST_HEADER="> 🪙 **Tokens** — Input: ${INPUT_TOKENS} | Output: ${OUTPUT_TOKENS} | Cache write: ${CACHE_WRITE_TOKENS} | Cache read: ${CACHE_READ_TOKENS} | **Cost: \$${COST}**"

printf '%s\n\n%s\n\n%s\n' "$MODEL_HEADER" "$COST_HEADER" "$REVIEW_TEXT" > claude-review.md
cat claude-review.md

# Same reason as the payload above: the review body goes to curl through a file, not
# through argv. A review is far smaller than a diff, but it is the same failure mode and
# it would surface on exactly the merge requests that most need the comment.
jq -Rs '{body: .}' < claude-review.md > "$COMMENT_FILE"

curl --fail --request POST \
  --header "PRIVATE-TOKEN: $GITLAB_API_TOKEN" \
  --header "Content-Type: application/json" \
  --data "@$COMMENT_FILE" \
  "https://$GITLAB_HOST/api/v4/projects/${CI_PROJECT_ID}/merge_requests/$CI_MERGE_REQUEST_IID/notes" || {
  echo "Could not post the review comment — the review is still available as the job artifact" >&2
  exit 2
}

# Gate last. The review is written and posted above, so a blocking verdict still
# leaves the developer both the artifact and the merge request comment.
VERDICT="$(extract_verdict claude-review.md)" || true
if [ -z "$VERDICT" ]; then
  echo "ERROR: review carries no recognised verdict in its Executive Summary — not treating this as an approval" >&2
  exit 1
fi

echo "[claude-review] verdict=${VERDICT}" >&2
exit "$(verdict_exit_code "$VERDICT")"
