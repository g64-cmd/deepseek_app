/** Compare branch structure independently of archive-assigned message identifiers. */
export function branchShape(session) {
  const indices = new Map(session.messages.map((message, index) => [message.id, index]))
  const indexOf = (id) => {
    if (id === null || id === undefined) {
      return null
    }
    if (!indices.has(id)) {
      throw new Error('Branch references an unknown message')
    }
    return indices.get(id)
  }
  return {
    root: indexOf(session.rootMessageId),
    nodes: session.messages.map((message) => ({
      role: message.role,
      parent: indexOf(message.parentId),
      selected: indexOf(message.selectedChildId),
    })),
  }
}
