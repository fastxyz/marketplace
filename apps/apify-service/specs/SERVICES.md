# Apify Service Matrix

These marketplace services all reuse `apps/apify-service`.

Each service should be:

- one standalone Coolify app
- one public HTTPS host
- one marketplace provider service
- published as `verified_escrow`
- modeled as an async `fixed_x402` route for now

The six rows at the top are already deployed in Coolify. The remaining rows are the new batch requested for marketplace onboarding.

## Suggested Mapping

| Status | Actor ID | Service Name | Slug | API Namespace | Suggested Coolify App | Suggested Host | Spec Template |
| --- | --- | --- | --- | --- | --- | --- | --- |
| live | `compass/crawler-google-places` | `Google Places Scraper` | `apify-google-places-scraper` | `apify-google-places` | `fast-provider-apify-google-places` | `fastmainnetapifygoogleplaces.8o.vc` | `google-places.mainnet.template.json` |
| live | `clockworks/tiktok-scraper` | `TikTok Scraper` | `apify-tiktok-scraper` | `apify-tiktok` | `fast-provider-apify-tiktok` | `fastmainnetapifytiktok.8o.vc` | `tiktok.mainnet.template.json` |
| live | `apify/instagram-scraper` | `Instagram Scraper` | `apify-instagram-scraper` | `apify-instagram` | `fast-provider-apify-instagram` | `fastmainnetapifyinstagram.8o.vc` | `instagram.mainnet.template.json` |
| live | `apidojo/tweet-scraper` | `Tweet Scraper` | `apify-tweet-scraper` | `apify-tweet` | `fast-provider-apify-tweet` | `fastmainnetapifytweet.8o.vc` | `tweet.mainnet.template.json` |
| live | `apify/facebook-posts-scraper` | `Facebook Posts Scraper` | `apify-facebook-posts-scraper` | `apify-facebook-posts` | `fast-provider-apify-facebook-posts` | `fastmainnetapifyfacebookposts.8o.vc` | `facebook-posts.mainnet.template.json` |
| live | `streamers/youtube-scraper` | `YouTube Scraper` | `apify-youtube-scraper` | `apify-youtube` | `fast-provider-apify-youtube` | `fastmainnetapifyyoutube.8o.vc` | `youtube.mainnet.template.json` |
| new | `apify/website-content-crawler` | `Website Content Crawler` | `apify-website-content-crawler` | `apify-website-content` | `fast-provider-apify-website-content` | `fastmainnetapifywebsitecontent.8o.vc` | `website-content-crawler.mainnet.template.json` |
| new | `apify/web-scraper` | `Web Scraper` | `apify-web-scraper` | `apify-web` | `fast-provider-apify-web-scraper` | `fastmainnetapifywebscraper.8o.vc` | `web-scraper.mainnet.template.json` |
| new | `dev_fusion/linkedin-profile-scraper` | `LinkedIn Profile Scraper` | `apify-linkedin-profile-scraper` | `apify-linkedin-profile` | `fast-provider-apify-linkedin-profile` | `fastmainnetapifylinkedinprofile.8o.vc` | `linkedin-profile.mainnet.template.json` |
| new | `vdrmota/contact-info-scraper` | `Contact Info Scraper` | `apify-contact-info-scraper` | `apify-contact-info` | `fast-provider-apify-contact-info` | `fastmainnetapifycontactinfo.8o.vc` | `contact-info.mainnet.template.json` |
| new | `code_crafter/leads-finder` | `Leads Finder` | `apify-leads-finder` | `apify-leads` | `fast-provider-apify-leads-finder` | `fastmainnetapifyleadsfinder.8o.vc` | `leads-finder.mainnet.template.json` |
| new | `curious_coder/facebook-ads-library-scraper` | `Facebook Ad Library Scraper` | `apify-facebook-ads-library-scraper` | `apify-facebook-ads-library` | `fast-provider-apify-facebook-ads-library` | `fastmainnetapifyfacebookadslibrary.8o.vc` | `facebook-ads-library.mainnet.template.json` |
| new | `bebity/linkedin-jobs-scraper` | `LinkedIn Jobs Scraper` | `apify-linkedin-jobs-scraper` | `apify-linkedin-jobs` | `fast-provider-apify-linkedin-jobs` | `fastmainnetapifylinkedinjobs.8o.vc` | `linkedin-jobs.mainnet.template.json` |
| new | `apify/e-commerce-scraping-tool` | `E-commerce Scraping Tool` | `apify-ecommerce-scraping-tool` | `apify-ecommerce` | `fast-provider-apify-ecommerce` | `fastmainnetapifyecommerce.8o.vc` | `ecommerce.mainnet.template.json` |
| new | `harvestapi/linkedin-company-employees` | `LinkedIn Company Employees Scraper` | `apify-linkedin-company-employees` | `apify-linkedin-employees` | `fast-provider-apify-linkedin-employees` | `fastmainnetapifylinkedinemployees.8o.vc` | `linkedin-company-employees.mainnet.template.json` |
| new | `misceres/indeed-scraper` | `Indeed Scraper` | `apify-indeed-scraper` | `apify-indeed` | `fast-provider-apify-indeed` | `fastmainnetapifyindeed.8o.vc` | `indeed.mainnet.template.json` |
| new | `powerai/g2-product-reviews-scraper` | `G2 Product Reviews Scraper` | `apify-g2-product-reviews-scraper` | `apify-g2-reviews` | `fast-provider-apify-g2-reviews` | `fastmainnetapifyg2reviews.8o.vc` | `g2-product-reviews.mainnet.template.json` |
| new | `apify/cheerio-scraper` | `Cheerio Scraper` | `apify-cheerio-scraper` | `apify-cheerio` | `fast-provider-apify-cheerio` | `fastmainnetapifycheerio.8o.vc` | `cheerio.mainnet.template.json` |
| new | `junglee/amazon-crawler` | `Amazon Product Scraper` | `apify-amazon-product-scraper` | `apify-amazon` | `fast-provider-apify-amazon` | `fastmainnetapifyamazon.8o.vc` | `amazon.mainnet.template.json` |

## Required Coolify Env Per App

- shared across the batch today: one `APIFY_API_TOKEN`
- `APIFY_API_TOKEN`
- `APIFY_ACTOR_ID`
- `APIFY_SERVICE_NAME`
- `APIFY_SERVICE_DESCRIPTION`
- `APIFY_API_BASE_URL=https://api.apify.com/v2`
- `APIFY_DEFAULT_POLL_AFTER_MS=5000`
- `APIFY_DATASET_ITEM_LIMIT=100`
- `APIFY_SERVICE_PORT=4040`
- `MARKETPLACE_VERIFICATION_TOKEN`

Each app then gets its own matching provider spec from this folder.

## Shared Marketplace Convention

- payout wallet in the existing Apify provider specs: `fast1rv8wsdd5pnkwt4u637g2yj4tpuyq26rzw8380rfhpnsnljz7v3tqv4njuq`
- provider contact email convention for these marketplace-owned specs: `marketplace@fast.xyz`

## Suggested Shared App Config

- Build pack: `nixpacks`
- Base directory: repo root
- Domain: use the matching suggested host above
- Port: `4040`
- Build command: `npm install && npm run build`
- Start command: `npm run start:apify-service`
- Health check path: `/health`

## Pricing Note

The new provider-spec templates include starter `fixed_x402` prices so they can be synced immediately, but those prices should be reviewed before submit/publish. Apify costs vary a lot across these actors.
