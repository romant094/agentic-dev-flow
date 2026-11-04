# ADF npm workspaces

This plugin provides the `provision` hook of the ADF extension contract for an npm-workspaces monorepo. Each worktree gets its own `node_modules`. A guard blocks `npm install` and its kin in a linked worktree.

Full documentation: [the guide page](../../docs/guide/plugins/adf-npm-workspaces.md).
