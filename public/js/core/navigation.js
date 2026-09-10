export const SURFACES = ["learning", "development", "chat", "memory"];

export function isProjectSurface(surface) {
  return surface === "learning" || surface === "development";
}

export function projectSurface(project) {
  return project.kind === "learning" ? "learning" : "development";
}

export function projectsForSurface(projects, surface) {
  return isProjectSurface(surface)
    ? projects.filter((project) => projectSurface(project) === surface) : [];
}

export function availableSurface(surface, hasModule) {
  return SURFACES.includes(surface) && hasModule(surface === "memory" ? "development" : surface);
}

export function resolveSurface(surface, projects, navigation, hasModule) {
  if (surface === "projects") {
    const previous = projects.find((project) => project.id === navigation.projectId);
    surface = previous ? projectSurface(previous) : "development";
  }
  return availableSurface(surface, hasModule) ? surface
    : SURFACES.find((value) => availableSurface(value, hasModule)) ?? "chat";
}

export function migrateProjectNavigation(navigation, projects) {
  if (!navigation.projectsBySurface || typeof navigation.projectsBySurface !== "object"
    || Array.isArray(navigation.projectsBySurface)) {
    navigation.projectsBySurface = {};
    const previous = projects.find((project) => project.id === navigation.projectId);
    if (previous) navigation.projectsBySurface[projectSurface(previous)] = previous.id;
  }
}

export function selectedProjectId(projects, surface, navigation) {
  const visible = projectsForSurface(projects, surface);
  return visible.find((project) => project.id === navigation.projectsBySurface?.[surface])?.id
    ?? visible[0]?.id ?? null;
}
