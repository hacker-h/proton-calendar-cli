import { loadConfigFromEnv } from "./config.js";
import { loadDotEnv } from "./env-file.js";
import { startApiServer } from "./server.js";

async function main() {
  loadDotEnv(process.env);
  const config = loadConfigFromEnv(process.env);
  const app = await startApiServer(config);
  console.log(`proton-calendar-api listening on ${app.baseUrl}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
