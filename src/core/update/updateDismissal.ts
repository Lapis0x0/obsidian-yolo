type UpdateDismissalState = {
  softDismissedUpdateVersion: string
  mutedUpdateVersion: string
}

export function isUpdateVersionSoftDismissed(
  state: UpdateDismissalState,
  version: string,
): boolean {
  return state.softDismissedUpdateVersion === version
}

export function isUpdateVersionMuted(
  state: UpdateDismissalState,
  version: string,
): boolean {
  return state.mutedUpdateVersion === version
}

export function dismissUpdateVersion(
  state: UpdateDismissalState,
  version: string,
): UpdateDismissalState {
  const wasSoftDismissed = isUpdateVersionSoftDismissed(state, version)

  return {
    ...state,
    softDismissedUpdateVersion: version,
    mutedUpdateVersion: wasSoftDismissed
      ? version
      : state.mutedUpdateVersion,
  }
}
