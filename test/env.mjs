// Loaded by `node --import` before every spec: the suite runs the same in either runtime. The
// variables that select a runtime or its home are removed, so child processes inherit the clean
// environment too; a test that needs one sets it itself.
for (const name of ['CODEX_THREAD_ID', 'CODEX_HOME', 'ADF_RUNTIME', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CONFIG_DIR']) delete process.env[name]
