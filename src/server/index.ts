import { resolve } from "node:path";
import { loadRouterConfig } from "../config/index.js";
import { createApp } from "./app.js";

async function main() {
  const configPath = process.env.ROUTEWEAVER_CONFIG
    ?? process.env.HERMES_ROUTER_CONFIG
    ?? resolve(process.cwd(), "config/router.yaml");
  const config = await loadRouterConfig(configPath);
  const app = createApp(config);
  const port = Number(process.env.PORT ?? 3000);
  const host = process.env.HOST ?? "0.0.0.0";
  await app.listen({ host, port });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
