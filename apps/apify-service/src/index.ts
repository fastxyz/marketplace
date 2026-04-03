import { createApifyServiceApp } from "./app.js";

const port = Number(process.env.APIFY_SERVICE_PORT ?? process.env.PORT ?? 4040);
const apifyApiToken = process.env.APIFY_API_TOKEN;
const actorId = process.env.APIFY_ACTOR_ID;

if (!apifyApiToken) {
  throw new Error("APIFY_API_TOKEN is required.");
}

if (!actorId) {
  throw new Error("APIFY_ACTOR_ID is required.");
}

const app = createApifyServiceApp({
  apifyApiToken,
  actorId,
  apifyApiBaseUrl: process.env.APIFY_API_BASE_URL,
  serviceName: process.env.APIFY_SERVICE_NAME,
  serviceDescription: process.env.APIFY_SERVICE_DESCRIPTION,
  verificationToken: process.env.APIFY_SITE_PROOF ?? process.env.MARKETPLACE_VERIFICATION_TOKEN,
  defaultPollAfterMs: Number(process.env.APIFY_DEFAULT_POLL_AFTER_MS ?? 5000),
  datasetItemLimit: Number(process.env.APIFY_DATASET_ITEM_LIMIT ?? 100)
});

app.listen(port, () => {
  console.log(`Apify service listening on http://localhost:${port}`);
});
