import { loadStoredJson, loadString } from "./storage.js";

const THEMES = new Set(["terminal", "neon", "moon"]);

function storedTheme() {
  const theme = loadString("ronix-agent-theme", "terminal");
  return THEMES.has(theme) ? theme : "terminal";
}

export { THEMES };

export const state = {
  projects: [],
  projectRoots: [],
  models: [],
  modelError: null,
  pendingProject: null,
  sessions: [],
  sessionId: null,
  source: null,
  reconnectTimer: null,
  lastSequence: 0,
  firstSequence: 0,
  hasMoreEvents: false,
  events: [],
  approvals: {},
  sessionRefreshTimer: null,
  liveTurnActive: false,
  liveResponse: null,
  liveRenderFrame: null,
  selectedSession: null,
  theme: storedTheme(),
  settingsTab: "projects",
  showTechnical: loadString("ronix-agent-technical") === "true",
  learningMode: loadString("ronix-agent-learning-mode", "course") || "course",
  progressTab: loadString("ronix-agent-progress-tab", "summary") || "summary",
  learning: null,
  gitStatus: null,
  gitProjectId: null,
  gitLoading: false,
  gitError: null,
  gitSyncRunning: null,
  gitSyncMessage: null,
  drafts: loadStoredJson("ronix-agent-drafts", {}),
  navigation: loadStoredJson("ronix-agent-navigation", {
    projectId: null,
    sessionsByProject: {},
  }),
  modelPreference: loadStoredJson("ronix-agent-model-preference", {}),
};

if (
  !state.navigation.sessionsByProject
  || typeof state.navigation.sessionsByProject !== "object"
  || Array.isArray(state.navigation.sessionsByProject)
) {
  state.navigation.sessionsByProject = {};
}
