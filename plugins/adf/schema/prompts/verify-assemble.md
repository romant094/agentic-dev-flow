<!-- verbatim schema/instructions/verify.md -->
It writes `<root>/openspec/changes/<change>/verify.md` from the template, the sections in the
template's order, each with its verdict as the verdict file displays it, its summary and the
verbatim content of its output file. A section with nothing to paste is a step that was
skipped: report it rather than describe what it would have said. The record's last line is the
verdict file's `line`, unchanged.
<!-- /verbatim -->
Commit nothing, and dispatch no agent; return the record's path.
