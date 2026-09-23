# `src/core/tools/native/`

Tools that touch the real filesystem directly (`node:fs`), bypassing every
Obsidian abstraction: any path, any extension, hidden directories, and
locations outside the vault. Desktop-only, and exposed only to the Max chat
mode.

The directory is **grouping, not identity**: what a tool is available in is
declared by its owning capability's `chatModes` field
(`src/core/tools/capabilities/native-files.ts`), never by where its file
lives; `capabilities/` remains the single registration point, exactly as it is
for `internal/` — the earlier precedent for grouping a family of tools into a
subdirectory.

Shared here:

- `paths.ts` — the path contract all of these tools advertise and resolve
  against (`NATIVE_PATH_ARG_DESCRIPTION`, `resolveNativeFilePathArg`,
  `resolveNativePath`, `getVaultBasePath`), plus `isInsideVault`, the
  synchronous vault-boundary judgment the tool gateway needs for out-of-vault
  approval, and `runSerialByNativePath`, the per-file queue every native
  write runs its read-modify-write in.
- `text.ts` — the binary-file guard applied before bytes are decoded for the
  model.
- `current-text.ts` — `readNativeCurrentText`, a file's current text for
  comparison and diffing (the pending-write preview, and the CLI runtimes
  reading what an external agent changes): small text files only, every
  failure reported as `unreadable` rather than thrown.

`line-slicing.ts` deliberately stays in the tools root: the vault-backed
`fs_read` shares it, so it is not native-only.
