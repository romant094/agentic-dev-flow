The description adf-jira writes on the issue that mirrors a group of debt entries, in Jira wiki
markup. /adf-jira:sync-debt renders it from the debt tree, and renders it again when an entry
joins or leaves the group.

To change it, copy this file into the host project and name the copy in the registry config:
`"debtTemplate": "<path in the host>"`. Keep the one section. Its marker line is
`<!-- description -->`; this preface, above the marker, is not rendered.

Values: the lines between the entries block's opening and closing marker lines (a hash or a
slash before the name entries, in double braces, each on its own line) repeat once per entry
of the group, in tree order. Inside them {{id}}, {{title}}, {{anchors}} (comma-separated),
{{class}} and {{block}} are that entry's. {{root}}, the debt tree's directory, may stand
anywhere. sync-debt rewrites a description only while its non-blank lines still have this
template's shape, or the shape of the one-entry description it wrote before this template, so
a description a person rewrote is left alone.

<!-- description -->
h3. Technical debt
{{#entries}}
* {{id}}: {{title}}
** Anchors: {{anchors}}
** Class: {{class}}
{{/entries}}

Mirrored from the technical debt tree {{root}}: each entry above is a row there that carries this issue's key.
