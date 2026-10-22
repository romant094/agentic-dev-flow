The hand-off comment adf-jira writes on an issue after the merge, in Jira wiki markup.

To change it, copy this file into the host project and name the copy in the registry config:
`"commentTemplate": "<path in the host>"`. Keep the three sections. The marker line of each
section is `<!-- <state> -->`; this preface, above the first marker, is not rendered.

Values: {{done}}, {{test}}, {{remains}} and {{tried}} are lists of short sentences, written by
the agent and checked by the core: a line that holds one repeats once per item. {{commit}} is a
commit hash. {{mr}} is the merge request URL from the forge, and it is empty with no forge. A
line that holds an empty value is dropped. Lines between a block's opening and closing marker
lines (a hash or a slash before the name, in double braces, each on its own line) are kept
only when the value is not empty.

<!-- taken -->
h3. Done
# {{done}}

h3. How to test
# {{test}}
{{#commit}}

Commit: {{commit}}
{{/commit}}
{{#mr}}

Merge request: {{mr}}
{{/mr}}
<!-- partial -->
{{#done}}
h3. Done
# {{done}}

{{/done}}
{{#test}}
h3. How to test
# {{test}}

{{/test}}
h3. Remains
# {{remains}}
{{#commit}}

Commit: {{commit}}
{{/commit}}
{{#mr}}

Merge request: {{mr}}
{{/mr}}
<!-- not-reproduced -->
h3. Does not reproduce
The issue does not reproduce on commit {{commit}}.

h3. Tried
# {{tried}}
{{#test}}

h3. How to retest
# {{test}}
{{/test}}
{{#mr}}

Merge request: {{mr}}
{{/mr}}
