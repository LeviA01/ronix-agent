export function isAgentMessage(item) {
  return item?.type === "agentMessage" || item?.type === "agent_message";
}

export function isToolItem(item) {
  return isCommandItem(item) || isFileChangeItem(item);
}

export function isCommandItem(item) {
  return ["commandExecution", "command_execution"].includes(item?.type);
}

export function isFileChangeItem(item) {
  return ["fileChange", "file_change"].includes(item?.type);
}

export function isLiveEvent(event) {
  return [
    "codex.turn.started",
    "codex.item.started",
    "codex.item.agentMessage.delta",
    "codex.turn.completed",
    "turn.interrupted",
    "session.error",
  ].includes(event.type);
}

export function isSessionStateEvent(event) {
  return [
    "session.ready",
    "session.error",
    "session.stopped",
    "session.resumed",
    "session.settings",
    "turn.interrupted",
    "codex.turn.started",
    "codex.turn.completed",
  ].includes(event.type);
}

export function isNearBottom(container) {
  return container.scrollHeight - container.scrollTop - container.clientHeight < 120;
}

export function visibleEvents(events) {
  return events.filter((event) => {
    if (event.type === "user.message") return true;
    if (event.type === "turn.error" || event.type === "session.error") return true;
    if (event.type === "turn.interrupted") return true;
    if (event.type !== "codex.item.completed") return false;

    const itemType = event.payload?.item?.type;
    return [
      "agent_message", "command_execution", "file_change", "error",
      "agentMessage", "commandExecution", "fileChange",
    ].includes(itemType);
  });
}
