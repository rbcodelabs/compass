/** After archiving, leave the conversation panel: back to the previous crumb, or close it when there is none. */
export function leaveArchivedConversation(input: {
  historyStack: readonly unknown[]
  jumpToCrumb: (index: number) => void
  closePanel: () => void
}): void {
  const previous = input.historyStack.length - 2
  if (previous >= 0) input.jumpToCrumb(previous)
  else input.closePanel()
}
