The correction comment adf-jira writes on an issue at `start`, in Jira wiki markup, when the
issue check corrected what the issue says.

To change it, copy this file into the host project and name the copy in the registry config:
`"correctionTemplate": "<path in the host>"`. Keep the one section. Its marker line is
`<!-- corrected -->`; this preface, above the marker, is not rendered.

Values: {{corrections}} holds one line per correction (what, the corrected value, and the old
value when there was one); {{answers}} holds one line per question the developer answered,
with the answer. A line that holds one repeats once per item; a line that holds an empty value
is dropped. Lines between a block's opening and closing marker lines (a hash or a slash before
the name, in double braces, each on its own line) are kept only when the value is not empty.

<!-- corrected -->
{{#corrections}}
h3. Corrected before the work started
# {{corrections}}
{{/corrections}}
{{#answers}}

h3. Answered by the developer
# {{answers}}
{{/answers}}
