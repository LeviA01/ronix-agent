export type OptionalModuleConfig = {
  enabled: boolean;
  provider: string | null;
  endpoint: string | null;
};

export type OptionalModuleStatus = {
  id: "tts" | "stt";
  enabled: boolean;
  configured: boolean;
  provider: string | null;
};

export function moduleStatuses(modules: {
  tts: OptionalModuleConfig;
  stt: OptionalModuleConfig;
}): OptionalModuleStatus[] {
  return (["tts", "stt"] as const).map((id) => {
    const module = modules[id];
    return {
      id,
      enabled: module.enabled,
      configured: module.enabled && Boolean(module.provider && module.endpoint),
      provider: module.provider,
    };
  });
}
