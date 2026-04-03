import { execFileSync } from "node:child_process";

const cwd = "/Users/chris/Documents/Workspace/ai-agent-marketplace";
const serverUuid = "j404s8cc04o8g4coss4kkk8c";
const projectUuid = "eo0w0w04s4g8osgo4oocg84w";
const repo = "https://github.com/seichris/ai-agent-marketplace.git";
const branch = process.env.APIFY_ROLLOUT_BRANCH
  ?? (execFileSync("git", ["branch", "--show-current"], { cwd, encoding: "utf8" }).trim() || "main");
const sharedBuild = "npm install && npm run build:runtime";
const sharedStart = "npm run start:apify-service";
const healthPath = "/health";

const apps = [
  {
    existingUuid: "ih8wkc9s58udj62wtkz3bmyh",
    name: "fast-provider-apify-website-content",
    domain: "fastmainnetapifywebsitecontent.8o.vc",
    actorId: "apify/website-content-crawler",
    serviceName: "Website Content Crawler",
    serviceDescription:
      "Marketplace-hosted async proxy for the Apify Website Content Crawler actor.",
    verificationToken: "verify_pending_website_content",
  },
  {
    name: "fast-provider-apify-web-scraper",
    domain: "fastmainnetapifywebscraper.8o.vc",
    actorId: "apify/web-scraper",
    serviceName: "Web Scraper",
    serviceDescription:
      "Marketplace-hosted async proxy for the Apify Web Scraper actor.",
    verificationToken: "verify_pending_web_scraper",
  },
  {
    name: "fast-provider-apify-linkedin-profile",
    domain: "fastmainnetapifylinkedinprofile.8o.vc",
    actorId: "dev_fusion/linkedin-profile-scraper",
    serviceName: "LinkedIn Profile Scraper",
    serviceDescription:
      "Marketplace-hosted async proxy for the Apify LinkedIn Profile Scraper actor.",
    verificationToken: "verify_pending_linkedin_profile",
  },
  {
    name: "fast-provider-apify-contact-info",
    domain: "fastmainnetapifycontactinfo.8o.vc",
    actorId: "vdrmota/contact-info-scraper",
    serviceName: "Contact Info Scraper",
    serviceDescription:
      "Marketplace-hosted async proxy for the Apify Contact Info Scraper actor.",
    verificationToken: "verify_pending_contact_info",
  },
  {
    name: "fast-provider-apify-leads-finder",
    domain: "fastmainnetapifyleadsfinder.8o.vc",
    actorId: "code_crafter/leads-finder",
    serviceName: "Leads Finder",
    serviceDescription:
      "Marketplace-hosted async proxy for the Apify Leads Finder actor.",
    verificationToken: "verify_pending_leads_finder",
  },
  {
    name: "fast-provider-apify-facebook-ads-library",
    domain: "fastmainnetapifyfacebookadslibrary.8o.vc",
    actorId: "curious_coder/facebook-ads-library-scraper",
    serviceName: "Facebook Ad Library Scraper",
    serviceDescription:
      "Marketplace-hosted async proxy for the Apify Facebook Ad Library Scraper actor.",
    verificationToken: "verify_pending_facebook_ads_library",
  },
  {
    name: "fast-provider-apify-linkedin-jobs",
    domain: "fastmainnetapifylinkedinjobs.8o.vc",
    actorId: "bebity/linkedin-jobs-scraper",
    serviceName: "LinkedIn Jobs Scraper",
    serviceDescription:
      "Marketplace-hosted async proxy for the Apify LinkedIn Jobs Scraper actor.",
    verificationToken: "verify_pending_linkedin_jobs",
  },
  {
    name: "fast-provider-apify-ecommerce",
    domain: "fastmainnetapifyecommerce.8o.vc",
    actorId: "apify/e-commerce-scraping-tool",
    serviceName: "E-commerce Scraping Tool",
    serviceDescription:
      "Marketplace-hosted async proxy for the Apify E-commerce Scraping Tool actor.",
    verificationToken: "verify_pending_ecommerce",
  },
  {
    name: "fast-provider-apify-linkedin-employees",
    domain: "fastmainnetapifylinkedinemployees.8o.vc",
    actorId: "harvestapi/linkedin-company-employees",
    serviceName: "LinkedIn Company Employees Scraper",
    serviceDescription:
      "Marketplace-hosted async proxy for the Apify LinkedIn Company Employees Scraper actor.",
    verificationToken: "verify_pending_linkedin_employees",
  },
  {
    name: "fast-provider-apify-indeed",
    domain: "fastmainnetapifyindeed.8o.vc",
    actorId: "misceres/indeed-scraper",
    serviceName: "Indeed Scraper",
    serviceDescription:
      "Marketplace-hosted async proxy for the Apify Indeed Scraper actor.",
    verificationToken: "verify_pending_indeed",
  },
  {
    name: "fast-provider-apify-g2-reviews",
    domain: "fastmainnetapifyg2reviews.8o.vc",
    actorId: "powerai/g2-product-reviews-scraper",
    serviceName: "G2 Product Reviews Scraper",
    serviceDescription:
      "Marketplace-hosted async proxy for the Apify G2 Product Reviews Scraper actor.",
    verificationToken: "verify_pending_g2_reviews",
  },
  {
    name: "fast-provider-apify-cheerio",
    domain: "fastmainnetapifycheerio.8o.vc",
    actorId: "apify/cheerio-scraper",
    serviceName: "Cheerio Scraper",
    serviceDescription:
      "Marketplace-hosted async proxy for the Apify Cheerio Scraper actor.",
    verificationToken: "verify_pending_cheerio",
  },
  {
    name: "fast-provider-apify-amazon",
    domain: "fastmainnetapifyamazon.8o.vc",
    actorId: "junglee/amazon-crawler",
    serviceName: "Amazon Product Scraper",
    serviceDescription:
      "Marketplace-hosted async proxy for the Apify Amazon Product Scraper actor.",
    verificationToken: "verify_pending_amazon",
  },
  {
    name: "fast-provider-apify-google-search",
    domain: "fastmainnetapifygooglesearch.8o.vc",
    actorId: "apify/google-search-scraper",
    serviceName: "Google Search Results Scraper",
    serviceDescription:
      "Marketplace-hosted async proxy for the Apify Google Search Results Scraper actor.",
    verificationToken: "verify_pending_google_search",
  },
  {
    name: "fast-provider-apify-trustpilot",
    domain: "fastmainnetapifytrustpilot.8o.vc",
    actorId: "automation-lab/trustpilot",
    serviceName: "Trustpilot Reviews Scraper",
    serviceDescription:
      "Marketplace-hosted async proxy for the Apify Trustpilot Reviews Scraper actor.",
    verificationToken: "verify_pending_trustpilot",
  },
  {
    name: "fast-provider-apify-google-play",
    domain: "fastmainnetapifygoogleplay.8o.vc",
    actorId: "curious_coder/google-play-scraper",
    serviceName: "Google Play Scraper",
    serviceDescription:
      "Marketplace-hosted async proxy for the Apify Google Play Scraper actor.",
    verificationToken: "verify_pending_google_play",
  },
  {
    name: "fast-provider-apify-appstore",
    domain: "fastmainnetapifyappstore.8o.vc",
    actorId: "4bdullatif/appstore-scraper",
    serviceName: "Apple App Store Scraper",
    serviceDescription:
      "Marketplace-hosted async proxy for the Apify Apple App Store Scraper actor.",
    verificationToken: "verify_pending_appstore",
  },
  {
    name: "fast-provider-apify-reddit",
    domain: "fastmainnetapifyreddit.8o.vc",
    actorId: "shahidirfan/reddit-community-scraper",
    serviceName: "Reddit Community Scraper",
    serviceDescription:
      "Marketplace-hosted async proxy for the Apify Reddit Community Scraper actor.",
    verificationToken: "verify_pending_reddit",
  },
];

function run(args) {
  return execFileSync("coolify", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
}

function extractJson(output) {
  const lines = output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("{") || line.startsWith("["));
  if (lines.length === 0) {
    throw new Error(`No JSON found in output:\n${output}`);
  }
  return JSON.parse(lines.at(-1));
}

function getAppList() {
  return extractJson(run(["app", "list", "--format", "json"]));
}

function getEnvList(appUuid) {
  return extractJson(
    run(["app", "env", "list", appUuid, "--show-sensitive", "--format", "json"]),
  );
}

function createApp() {
  const output = run([
    "app",
    "create",
    "public",
    "--server-uuid",
    serverUuid,
    "--project-uuid",
    projectUuid,
    "--environment-name",
    "production",
    "--git-repository",
    repo,
    "--git-branch",
    branch,
    "--build-pack",
    "nixpacks",
    "--ports-exposes",
    "4040",
    "--format",
    "json",
  ]);
  const body = extractJson(output);
  if (!body.uuid) {
    throw new Error(`Create app did not return a uuid:\n${output}`);
  }
  return body.uuid;
}

function updateApp(appUuid, entry) {
  run([
    "app",
    "update",
    appUuid,
    "--name",
    entry.name,
    "--git-branch",
    branch,
    "--domains",
    `https://${entry.domain}`,
    "--build-command",
    sharedBuild,
    "--start-command",
    sharedStart,
    "--health-check-enabled",
    "--health-check-path",
    healthPath,
    "--ports-exposes",
    "4040",
    "--format",
    "json",
  ]);
}

function upsertEnv(appUuid, envs) {
  const existing = new Map(getEnvList(appUuid).map((item) => [item.key, item]));
  for (const [key, value] of envs) {
    const current = existing.get(key);
    if (current) {
      if (String(current.real_value) === String(value)) {
        continue;
      }
      run(["app", "env", "update", appUuid, current.uuid, "--value", String(value)]);
    } else {
      run(["app", "env", "create", appUuid, "--key", key, "--value", String(value)]);
    }
  }
}

function startApp(appUuid) {
  run(["app", "start", appUuid]);
}

const currentApps = getAppList();
const byName = new Map(currentApps.map((app) => [app.name, app]));
let apifyToken = process.env.APIFY_TOKEN ?? process.env.APIFY_API_TOKEN ?? null;
if (!apifyToken) {
  const existingTokenApp = byName.get("fast-provider-apify-website-content");
  if (!existingTokenApp?.uuid) {
    throw new Error("APIFY token is not set and no existing Apify app was found to copy it from.");
  }
  const existingEnv = getEnvList(existingTokenApp.uuid);
  const tokenEnv = existingEnv.find((item) => item.key === "APIFY_API_TOKEN");
  if (!tokenEnv?.real_value) {
    throw new Error("APIFY token is not set and could not be read from the existing Apify app env.");
  }
  apifyToken = String(tokenEnv.real_value);
}

const only = new Set(
  String(process.env.APIFY_ROLLOUT_ONLY ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
);
const byDomain = new Map();
for (const app of currentApps) {
  for (const domain of String(app.fqdn ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)) {
    byDomain.set(domain, app);
  }
}
const results = [];

for (const entry of apps) {
  if (
    only.size > 0
    && !only.has(entry.name)
    && !only.has(entry.domain)
    && !only.has(entry.actorId)
  ) {
    continue;
  }

  const targetDomain = `https://${entry.domain}`;
  const existing = byName.get(entry.name) ?? byDomain.get(targetDomain);
  const appUuid = existing?.uuid ?? entry.existingUuid ?? createApp();

  updateApp(appUuid, entry);
  upsertEnv(appUuid, [
    ["NIXPACKS_NODE_VERSION", "22"],
    ["APIFY_API_TOKEN", apifyToken],
    ["APIFY_ACTOR_ID", entry.actorId],
    ["APIFY_SERVICE_NAME", entry.serviceName],
    ["APIFY_SERVICE_DESCRIPTION", entry.serviceDescription],
    ["APIFY_API_BASE_URL", "https://api.apify.com/v2"],
    ["APIFY_DEFAULT_POLL_AFTER_MS", "5000"],
    ["APIFY_DATASET_ITEM_LIMIT", "100"],
    ["APIFY_SERVICE_PORT", "4040"],
    ["APIFY_SITE_PROOF", entry.verificationToken],
  ]);

  startApp(appUuid);

  results.push({
    name: entry.name,
    uuid: appUuid,
    domain: targetDomain,
    actorId: entry.actorId,
  });
  console.log(JSON.stringify(results.at(-1)));
}

console.log(JSON.stringify(results, null, 2));
