<!-- verbatim schema/instructions/verify.md -->
A verify dispatch is read-only: it edits no file of the change or of the project, commits
nothing, and dispatches no agent.
<!-- /verbatim -->
Its reply has the role `verify-<id>`: write it as one JSON
object under `${CLAUDE_PLUGIN_ROOT}/schema/verify-<id>.schema.json` to `{{replyFile}}`, and
return that path instead of a prose report.
<!-- verbatim schema/instructions/verify.md -->
The reply states no verdict and writes no section:
the script checks the reply, computes the verdict and writes the section from it.
<!-- /verbatim -->
<!-- verbatim schema/instructions/verify.md -->
git runs as `git -C <root>`. No dispatch text asks
for a repository-wide git mutation.
<!-- /verbatim -->
