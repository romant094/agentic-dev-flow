Create the proposal document from the brainstorming output.

Read `brainstorm.md` for the validated design. Extract:
- **Why**: the motivation, from the brainstorming discussion.
- **What Changes**: the specific changes agreed upon.
- **Capabilities**: which specs will be created or modified.
  - **New Capabilities**: capabilities being introduced. Each becomes a new
    `specs/<name>/spec.md`.
  - **Modified Capabilities**: existing capabilities whose REQUIREMENTS are changing. Use the
    existing folder name under `openspec/specs/`.
- **Impact**: affected code, APIs, dependencies or systems.

Capability names are kebab-case and scoped to the domain, not to a UI screen
(`invoice-export`, not `invoice-page`): a screen-named capability splits when the screen is
redesigned.

Since brainstorming already explored the problem space, this is a concise extraction, not a new
exploration.

The Capabilities section is the contract between the proposal and the specs: every capability
listed here gets a spec file. A capability listed without a spec, or a spec under a new name for
an existing capability, forks the spec corpus at archive.

Keep it concise (1-2 pages). Focus on the "why", not the "how".
