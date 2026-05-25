import { createArchiveIsServiceApp, normalizeArchiveIsTimeoutMs } from "./app.js";

const port = Number(process.env.ARCHIVE_IS_SERVICE_PORT ?? process.env.PORT ?? 4060);
const timeoutMs = normalizeArchiveIsTimeoutMs(process.env.ARCHIVE_IS_TIMEOUT_MS);

const app = createArchiveIsServiceApp({
  archiveHost: parseArchiveHost(process.env.ARCHIVE_IS_BASE_HOST),
  timeoutMs,
  verificationToken: process.env.MARKETPLACE_VERIFICATION_TOKEN
});

app.listen(port, () => {
  console.log(`Archive.is service listening on http://localhost:${port}`);
});

function parseArchiveHost(value: string | undefined) {
  if (value === undefined || value === "") {
    return undefined;
  }

  if (value !== "archive.today" && value !== "archive.is" && value !== "archive.ph") {
    throw new Error("ARCHIVE_IS_BASE_HOST must be archive.today, archive.is, or archive.ph.");
  }

  return value;
}
