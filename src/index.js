import { loadConfigFromEnv } from "./config.js";
import { startApiServer } from "./server.js";

async function main() {
  const config = loadConfigFromEnv(process.env);
  const app = await startApiServer(config);
  // eslint-disable-next-line no-console
  console.log(`proton-calendar-api listening on ${app.baseUrl}`);
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error.message);
  process.exit(1);
});
