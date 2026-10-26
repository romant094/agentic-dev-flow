# Planning Guide

<!--
How this project gathers information for a change's plan. /adf:init created this file; the
team owns it. The flow gives its text to every artifact that names it in the schema (the plan
first), so write it for an agent that has never seen the project. Delete a section that does
not apply, and keep each one short: everything here is read on every plan.
-->

## Where to look

<!-- The sources to read before planning, by authority: the knowledge base, the code, the
documentation, a running system. Name the paths. -->

## Packages

<!-- The project's packages or top-level source directories, and the order a change usually
lands in them, if one depends on another. -->

## How to run the checks

<!-- The commands that build, test and lint the project, and which of them a task's
verification runs. -->

## Whole-suite command

<!-- The one command that runs every test of the project with no cache, so a pass proves the
current code. Apply runs it once, at the end. When this section is empty, apply finds the
command in the project's own files, proposes it, and writes it here once the developer
confirms. -->

## Fresh-run proof

<!-- One line, in backticks, that the whole-suite output contains only when nothing was replayed
from a cache, such as a test runner's or a build tool's cache counter at zero. A run whose
output lacks it fails, since it may be cached. Delete the section when the command's output
proves nothing of the kind. -->

## Test-first shares

<!-- The untracked paths a test-first task's new test needs to run in a fresh checkout, one per
line, such as a local environment file; what a `provision` plugin gives every worktree is not
listed here. With this section, the flow proves each
test-first task itself before its review: the new test runs in a throwaway worktree of the
commit's parent, where it must fail, then on the commit, where it must pass, with these paths
linked into it and nothing installed. Leave the section empty when the tests need no untracked
path. Delete it to leave that proof to the task's reviewer. -->

## Worktree copies

<!-- The untracked files every worktree the flow makes needs from the main checkout, each path in
backticks, such as a local environment file. Each is copied when the worktree has none, never
linked; a path git does not ignore is skipped. The project's plugins adjust the copies, for
example a database address. -->

## Worktree preparation

<!-- The commands that rebuild what a fresh worktree lacks because git ignores it, such as a
built shared package or generated code, one list item each: the command in backticks, then the
input paths whose change makes it run again, each in backticks, for example
- `npm run build --workspace <package>` from `packages/<package>`
The flow's scripts run each command in a new worktree once its providers have run, and again
before a covering or whole-suite run, or after a group merge, when its inputs changed since its
last run there. /adf:init proposes candidates and writes the ones the developer confirms. -->

## Checks that need the developer

<!-- Checks an implementer cannot run on its own, such as a pass against a live environment or
real hardware, or anything that needs consent at the time. Say when the plan needs one, where
in the plan it goes (in the task group that lands the path it checks, run once by the
orchestrator, never inside an implementer task) and what the developer must confirm first. -->
