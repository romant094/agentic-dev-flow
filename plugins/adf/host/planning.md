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

## Test-first shares

<!-- The untracked paths a test-first task's new test needs to run in a fresh checkout, one per
line, such as node_modules or a local environment file. With this section, the flow proves each
test-first task itself before its review: the new test runs in a throwaway worktree of the
commit's parent, where it must fail, then on the commit, where it must pass, with these paths
linked into it and nothing installed. Leave the section empty when the tests need no untracked
path. Delete it to leave that proof to the task's reviewer. -->

## Checks that need the developer

<!-- Checks an implementer cannot run on its own, such as a pass against a live environment or
real hardware, or anything that needs consent at the time. Say when the plan needs one, where
in the plan it goes (in the task group that lands the path it checks, run once by the
orchestrator, never inside an implementer task) and what the developer must confirm first. -->
