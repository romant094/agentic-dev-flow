<!-- Every apply dispatch. -->
Every path you use is absolute, and git runs as `git -C <worktree>`: a working-directory
sentence does not bind your later tool calls, and one group that ignored its worktree that way
bypassed the review gate. Stage your files by path, never everything, and never stash, clean,
restore or check out over the working tree: a broad staging command in a shared checkout once
destroyed two uncommitted files of the developer's.
