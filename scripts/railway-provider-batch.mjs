#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const services = [
  {
    type: "marketplace-api",
    name: "marketplace-api",
    serviceName: "Fast Marketplace API",
    description: "Express marketplace API gateway for catalog, x402 execution, async jobs, and provider routing."
  },
  {
    type: "apify",
    name: "apify-amazon-product-scraper",
    actorId: "junglee/amazon-crawler",
    serviceName: "Amazon Product Scraper Proxy",
    description: "Run the Amazon Product Scraper actor through a marketplace-hosted async proxy."
  },
  {
    type: "apify",
    name: "apify-apple-app-store-scraper",
    actorId: "4bdullatif/appstore-scraper",
    serviceName: "Apple App Store Scraper Proxy",
    description: "Run the Apple App Store Scraper actor through a marketplace-hosted async proxy."
  },
  {
    type: "apify",
    name: "apify-cheerio-scraper",
    actorId: "apify/cheerio-scraper",
    serviceName: "Cheerio Scraper Proxy",
    description: "Run the Cheerio Scraper actor through a marketplace-hosted async proxy."
  },
  {
    type: "apify",
    name: "apify-contact-info-scraper",
    actorId: "vdrmota/contact-info-scraper",
    serviceName: "Contact Info Scraper Proxy",
    description: "Run the Contact Info Scraper actor through a marketplace-hosted async proxy."
  },
  {
    type: "apify",
    name: "apify-ecommerce-scraping-tool",
    actorId: "apify/e-commerce-scraping-tool",
    serviceName: "E-commerce Scraping Tool Proxy",
    description: "Run the E-commerce Scraping Tool actor through a marketplace-hosted async proxy."
  },
  {
    type: "apify",
    name: "apify-facebook-ads-library-scraper",
    actorId: "curious_coder/facebook-ads-library-scraper",
    serviceName: "Facebook Ads Library Scraper Proxy",
    description: "Run the Facebook Ads Library Scraper actor through a marketplace-hosted async proxy."
  },
  {
    type: "apify",
    name: "apify-facebook-posts-scraper",
    actorId: "apify/facebook-posts-scraper",
    serviceName: "Facebook Posts Scraper Proxy",
    description: "Run the Facebook Posts Scraper actor through a marketplace-hosted async proxy."
  },
  {
    type: "apify",
    name: "apify-g2-product-reviews-scraper",
    actorId: "powerai/g2-product-reviews-scraper",
    serviceName: "G2 Product Reviews Scraper Proxy",
    description: "Run the G2 Product Reviews Scraper actor through a marketplace-hosted async proxy."
  },
  {
    type: "apify",
    name: "apify-google-places-scraper",
    actorId: "compass/crawler-google-places",
    serviceName: "Google Places Scraper Proxy",
    description: "Run the Google Places Scraper actor through a marketplace-hosted async proxy."
  },
  {
    type: "apify",
    name: "apify-google-play-scraper",
    actorId: "curious_coder/google-play-scraper",
    serviceName: "Google Play Scraper Proxy",
    description: "Run the Google Play Scraper actor through a marketplace-hosted async proxy."
  },
  {
    type: "apify",
    name: "apify-google-search-scraper",
    actorId: "apify/google-search-scraper",
    serviceName: "Google Search Results Scraper Proxy",
    description: "Run the Google Search Results Scraper actor through a marketplace-hosted async proxy."
  },
  {
    type: "apify",
    name: "apify-indeed-scraper",
    actorId: "misceres/indeed-scraper",
    serviceName: "Indeed Scraper Proxy",
    description: "Run the Indeed Scraper actor through a marketplace-hosted async proxy."
  },
  {
    type: "apify",
    name: "apify-instagram-scraper",
    actorId: "apify/instagram-scraper",
    serviceName: "Instagram Scraper Proxy",
    description: "Run the Instagram Scraper actor through a marketplace-hosted async proxy."
  },
  {
    type: "apify",
    name: "apify-leads-finder",
    actorId: "code_crafter/leads-finder",
    serviceName: "Leads Finder Proxy",
    description: "Run the Leads Finder actor through a marketplace-hosted async proxy."
  },
  {
    type: "apify",
    name: "apify-linkedin-company-employees",
    actorId: "harvestapi/linkedin-company-employees",
    serviceName: "LinkedIn Company Employees Scraper Proxy",
    description: "Run the LinkedIn Company Employees Scraper actor through a marketplace-hosted async proxy."
  },
  {
    type: "apify",
    name: "apify-linkedin-jobs-scraper",
    actorId: "bebity/linkedin-jobs-scraper",
    serviceName: "LinkedIn Jobs Scraper Proxy",
    description: "Run the LinkedIn Jobs Scraper actor through a marketplace-hosted async proxy."
  },
  {
    type: "apify",
    name: "apify-linkedin-profile-scraper",
    actorId: "dev_fusion/linkedin-profile-scraper",
    serviceName: "LinkedIn Profile Scraper Proxy",
    description: "Run the LinkedIn Profile Scraper actor through a marketplace-hosted async proxy."
  },
  {
    type: "apify",
    name: "apify-reddit-community-scraper",
    actorId: "shahidirfan/reddit-community-scraper",
    serviceName: "Reddit Community Scraper Proxy",
    description: "Run the Reddit Community Scraper actor through a marketplace-hosted async proxy."
  },
  {
    type: "apify",
    name: "apify-tiktok-scraper",
    actorId: "clockworks/tiktok-scraper",
    serviceName: "TikTok Scraper Proxy",
    description: "Run the TikTok Scraper actor through a marketplace-hosted async proxy."
  },
  {
    type: "apify",
    name: "apify-trustpilot-reviews-scraper",
    actorId: "automation-lab/trustpilot",
    serviceName: "Trustpilot Reviews Scraper Proxy",
    description: "Run the Trustpilot Reviews Scraper actor through a marketplace-hosted async proxy."
  },
  {
    type: "apify",
    name: "apify-tweet-scraper",
    actorId: "apidojo/tweet-scraper",
    serviceName: "Tweet Scraper Proxy",
    description: "Run the Tweet Scraper actor through a marketplace-hosted async proxy."
  },
  {
    type: "apify",
    name: "apify-web-scraper",
    actorId: "apify/web-scraper",
    serviceName: "Web Scraper Proxy",
    description: "Run the Web Scraper actor through a marketplace-hosted async proxy."
  },
  {
    type: "apify",
    name: "apify-website-content-crawler",
    actorId: "apify/website-content-crawler",
    serviceName: "Website Content Crawler Proxy",
    description: "Run the Website Content Crawler actor through a marketplace-hosted async proxy."
  },
  {
    type: "apify",
    name: "apify-youtube-scraper",
    actorId: "streamers/youtube-scraper",
    serviceName: "YouTube Scraper Proxy",
    description: "Run the YouTube Scraper actor through a marketplace-hosted async proxy."
  },
  {
    type: "tavily",
    name: "tavily-mainnet",
    serviceName: "Tavily Proxy",
    description: "Search, extract, crawl, and map the web through a marketplace-hosted proxy."
  }
];

function parseArgs(argv) {
  const args = { command: argv[2], envFile: ".env.local", services: null };
  for (let index = 3; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--env-file") args.envFile = argv[++index];
    else if (arg === "--services") args.services = new Set(argv[++index].split(",").map((value) => value.trim()));
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function readEnvFile(envFile) {
  const resolved = path.resolve(envFile);
  const content = fs.readFileSync(resolved, "utf8");
  const env = {};
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const equalsIndex = trimmed.indexOf("=");
    const key = trimmed.slice(0, equalsIndex);
    let value = trimmed.slice(equalsIndex + 1);
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

function runRailway(args, options = {}) {
  const result = spawnSync("railway", args, {
    cwd: process.cwd(),
    encoding: "utf8",
    input: options.input,
    stdio: options.input === undefined ? ["ignore", "pipe", "pipe"] : ["pipe", "pipe", "pipe"]
  });

  if (result.status !== 0) {
    const stderr = result.stderr.trim();
    const stdout = result.stdout.trim();
    throw new Error(`railway ${args.join(" ")} failed${stderr ? `: ${stderr}` : ""}${stdout ? `\n${stdout}` : ""}`);
  }

  return result.stdout.trim();
}

function listExistingServices() {
  return new Map(JSON.parse(runRailway(["service", "list", "--json"])).map((service) => [service.name, service]));
}

function selectedServices(args) {
  return services.filter((service) => !args.services || args.services.has(service.name));
}

function setVars(service, vars) {
  const entries = Object.entries(vars).filter(([, value]) => value !== undefined && value !== "");
  if (entries.length === 0) return;
  runRailway([
    "variable",
    "set",
    "--service",
    service.name,
    "--skip-deploys",
    ...entries.map(([key, value]) => `${key}=${value}`)
  ]);
}

function setSecret(service, key, value) {
  if (!value) throw new Error(`${key} is required for ${service.name}`);
  runRailway(["variable", "set", "--service", service.name, "--skip-deploys", "--stdin", key], { input: value });
}

function configure(args) {
  const env = readEnvFile(args.envFile);
  const existing = listExistingServices();
  const skipped = [];

  for (const service of selectedServices(args)) {
    if (!existing.has(service.name)) {
      skipped.push(service.name);
      continue;
    }

    if (service.type === "marketplace-api") {
      setVars(service, {
        MARKETPLACE_BASE_URL: "https://marketplace-api-production.up.railway.app",
        MARKETPLACE_WEB_BASE_URL: "https://marketplace.fast.xyz",
        MARKETPLACE_FAST_NETWORK: "mainnet",
        MARKETPLACE_FACILITATOR_URL: "https://api.fast.xyz/x402",
        MARKETPLACE_TREASURY_ADDRESS: env.MARKETPLACE_TREASURY_ADDRESS,
        MARKETPLACE_ADMIN_TOKEN: env.MARKETPLACE_ADMIN_TOKEN,
        MARKETPLACE_SESSION_SECRET: env.MARKETPLACE_SESSION_SECRET,
        MARKETPLACE_SECRETS_KEY: env.MARKETPLACE_SECRETS_KEY,
        FAST_RPC_URL: env.FAST_RPC_URL,
        RAILPACK_BUILD_CMD: "npm run build:runtime",
        RAILPACK_START_CMD: "npm run start:api",
        NIXPACKS_BUILD_CMD: "npm run build:runtime",
        NIXPACKS_START_CMD: "npm run start:api"
      });
    } else if (service.type === "apify") {
      setSecret(service, "APIFY_API_TOKEN", env.APIFY_API_TOKEN);
      setVars(service, {
        APIFY_ACTOR_ID: service.actorId,
        APIFY_API_BASE_URL: "https://api.apify.com/v2",
        APIFY_SERVICE_NAME: service.serviceName,
        APIFY_SERVICE_DESCRIPTION: service.description,
        APIFY_DEFAULT_POLL_AFTER_MS: "5000",
        APIFY_DATASET_ITEM_LIMIT: "100",
        RAILPACK_BUILD_CMD: "npm run build:runtime",
        RAILPACK_START_CMD: "npm run start:apify-service",
        NIXPACKS_BUILD_CMD: "npm run build:runtime",
        NIXPACKS_START_CMD: "npm run start:apify-service"
      });
    } else {
      setSecret(service, "TAVILY_API_KEY", env.TAVILY_API_KEY);
      setVars(service, {
        TAVILY_API_BASE_URL: "https://api.tavily.com",
        RAILPACK_BUILD_CMD: "npm run build:runtime",
        RAILPACK_START_CMD: "npm run start:tavily-service",
        NIXPACKS_BUILD_CMD: "npm run build:runtime",
        NIXPACKS_START_CMD: "npm run start:tavily-service"
      });
    }

    console.log(`configured ${service.name}`);
  }

  for (const service of skipped) console.log(`skipped missing ${service}`);
}

function deploy(args) {
  const existing = listExistingServices();
  for (const service of selectedServices(args)) {
    if (!existing.has(service.name)) {
      console.log(`skipped missing ${service.name}`);
      continue;
    }
    runRailway(["up", "--service", service.name, "--detach", "--message", `Deploy ${service.name}`]);
    console.log(`deployed ${service.name}`);
  }
}

function domains(args) {
  const existing = listExistingServices();
  for (const service of selectedServices(args)) {
    if (!existing.has(service.name)) {
      console.log(`skipped missing ${service.name}`);
      continue;
    }
    const output = runRailway(["domain", "--service", service.name, "--json"]);
    console.log(`${service.name} ${output}`);
  }
}

const args = parseArgs(process.argv);

if (args.command === "configure") configure(args);
else if (args.command === "deploy") deploy(args);
else if (args.command === "domains") domains(args);
else {
  console.error("Usage: railway-provider-batch.mjs <configure|deploy|domains> [--env-file PATH] [--services a,b]");
  process.exit(1);
}
