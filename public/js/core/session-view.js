import { state } from "./state.js";

// Keep only recently visited, fully loaded views. Nothing is persisted to disk.
const views = new Map();
const MAX_VIEWS = 8;
let revision = 0;

export function invalidateSessionView() {
  revision += 1;
  state.historyLoading = false;
}

export function sessionViewToken() {
  const currentRevision = revision;
  const id = state.sessionId;
  return () => revision === currentRevision && state.sessionId === id;
}

export function rememberSessionView(scrollTop = 0) {
  if (!state.historyReady || !state.sessionId || state.selectedSession?.id !== state.sessionId) return;
  const id = state.sessionId;
  views.delete(id);
  views.set(id, {
    events: [...state.events],
    archivedMessages: [...state.archivedMessages],
    approvals: { ...state.approvals },
    selectedSession: { ...state.selectedSession },
    lastSequence: state.lastSequence,
    firstSequence: state.firstSequence,
    hasMoreEvents: state.hasMoreEvents,
    liveTurnActive: state.liveTurnActive,
    liveResponse: state.liveResponse ? { ...state.liveResponse } : null,
    scrollTop,
  });
  while (views.size > MAX_VIEWS) views.delete(views.keys().next().value);
}

export function hasSessionView(id) {
  return views.has(id);
}

export function restoreSessionView(id) {
  const view = views.get(id);
  if (!view) return null;
  views.delete(id);
  views.set(id, view);
  const { scrollTop, ...snapshot } = view;
  Object.assign(state, snapshot, {
    events: [...view.events],
    archivedMessages: [...view.archivedMessages],
    approvals: { ...view.approvals },
    selectedSession: { ...view.selectedSession },
    liveResponse: view.liveResponse ? { ...view.liveResponse } : null,
    historyReady: true,
  });
  return view;
}

export function forgetSessionView(id) {
  views.delete(id);
}
