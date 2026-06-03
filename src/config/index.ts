import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import { routerConfigSchema, type RouterConfig } from "./schema.js";

function deepMerge<T>(base: T, override: Partial<T>): T {
  if (Array.isArray(base) || Array.isArray(override)) {
    return override as T;
  }

  const output: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(override as Record<string, unknown>)) {
    if (value === undefined) {
      continue;
    }

    const current = output[key];
    output[key] =
      current && typeof current === "object" && !Array.isArray(current) && value && typeof value === "object" && !Array.isArray(value)
        ? deepMerge(current, value)
        : value;
  }
  return output as T;
}

export async function loadRouterConfig(configPath: string, envOverride?: Partial<RouterConfig>): Promise<RouterConfig> {
  const raw = await readFile(configPath, "utf8");
  const parsed = parse(raw) as RouterConfig;
  return routerConfigSchema.parse(envOverride ? deepMerge(parsed, envOverride) : parsed);
}
