import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { createApifyServiceApp } from "./app.js";

describe("apify service", () => {
  it("reports health and serves the verification token", async () => {
    const app = createApifyServiceApp({
      apifyApiToken: "apify-test-token",
      actorId: "apify~instagram-scraper",
      verificationToken: "verify-me"
    });

    const health = await request(app).get("/health");
    expect(health.status).toBe(200);
    expect(health.body).toMatchObject({
      ok: true,
      actorId: "apify~instagram-scraper"
    });

    const verification = await request(app).get("/.well-known/fast-marketplace-verification.txt");
    expect(verification.status).toBe(200);
    expect(verification.text).toBe("verify-me");
  });

  it("starts an Apify run and returns marketplace async acceptance", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      data: {
        id: "run_123",
        status: "RUNNING",
        defaultDatasetId: "dataset_123",
        defaultKeyValueStoreId: "store_123"
      }
    }), {
      status: 201,
      headers: {
        "content-type": "application/json"
      }
    }));

    const app = createApifyServiceApp({
      apifyApiToken: "apify-test-token",
      actorId: "apify~instagram-scraper"
    });

    const response = await request(app)
      .post("/run")
      .send({
        directUrls: ["https://instagram.com/example"]
      });
    expect(response.status).toBe(202);
    expect(response.body).toEqual({
      status: "accepted",
      providerJobId: "run_123",
      pollAfterMs: 5000,
      providerState: {
        actorId: "apify~instagram-scraper",
        datasetId: "dataset_123",
        keyValueStoreId: "store_123"
      }
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.apify.com/v2/acts/apify~instagram-scraper/runs",
      expect.objectContaining({
        method: "POST"
      })
    );
  });

  it("registers actor-specific operation routes and advertises them in OpenAPI", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      data: {
        id: "run_456",
        status: "RUNNING",
        defaultDatasetId: "dataset_456",
        defaultKeyValueStoreId: "store_456"
      }
    }), {
      status: 201,
      headers: {
        "content-type": "application/json"
      }
    }));

    const app = createApifyServiceApp({
      apifyApiToken: "apify-test-token",
      actorId: "apify/instagram-scraper"
    });

    const openapi = await request(app).get("/openapi.json");
    expect(openapi.status).toBe(200);
    expect(Object.keys(openapi.body.paths)).toEqual([
      "/profile-posts",
      "/hashtag-posts",
      "/place-posts",
      "/post-comments"
    ]);

    const response = await request(app)
      .post("/profile-posts")
      .send({
        directUrls: ["https://www.instagram.com/example/"],
        resultsType: "posts",
        resultsLimit: 25
      });

    expect(response.status).toBe(202);
    expect(response.body.providerJobId).toBe("run_456");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.apify.com/v2/acts/apify%2Finstagram-scraper/runs",
      expect.objectContaining({
        method: "POST"
      })
    );
  });

  it("registers expanded Amazon actor routes in OpenAPI", async () => {
    const app = createApifyServiceApp({
      apifyApiToken: "apify-test-token",
      actorId: "junglee/amazon-crawler"
    });

    const openapi = await request(app).get("/openapi.json");
    expect(openapi.status).toBe(200);
    expect(Object.keys(openapi.body.paths)).toEqual([
      "/scrape-products",
      "/product-details",
      "/category-products"
    ]);
  });

  it("registers Google Search actor routes in OpenAPI", async () => {
    const app = createApifyServiceApp({
      apifyApiToken: "apify-test-token",
      actorId: "apify/google-search-scraper"
    });

    const openapi = await request(app).get("/openapi.json");
    expect(openapi.status).toBe(200);
    expect(Object.keys(openapi.body.paths)).toEqual([
      "/search-results"
    ]);
  });

  it("polls an Apify run and returns completed dataset items", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url === "https://api.apify.com/v2/actor-runs/run_123") {
        return new Response(JSON.stringify({
          data: {
            id: "run_123",
            status: "SUCCEEDED",
            defaultDatasetId: "dataset_123"
          }
        }), {
          status: 200,
          headers: {
            "content-type": "application/json"
          }
        });
      }

      if (url.startsWith("https://api.apify.com/v2/datasets/dataset_123/items")) {
        return new Response(JSON.stringify([
          {
            id: "item_1"
          }
        ]), {
          status: 200,
          headers: {
            "content-type": "application/json"
          }
        });
      }

      return new Response("not found", { status: 404 });
    });

    const app = createApifyServiceApp({
      apifyApiToken: "apify-test-token",
      actorId: "apify~instagram-scraper"
    });

    const response = await request(app)
      .post("/runs/poll")
      .send({
        providerJobId: "run_123",
        providerState: {
          datasetId: "dataset_123"
        }
      });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      status: "completed",
      result: {
        runId: "run_123",
        actorId: "apify~instagram-scraper",
        status: "SUCCEEDED",
        items: [
          {
            id: "item_1"
          }
        ],
        output: null
      }
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("surfaces Apify result-fetch failures instead of returning an empty completed result", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url === "https://api.apify.com/v2/actor-runs/run_404") {
        return new Response(JSON.stringify({
          data: {
            id: "run_404",
            status: "SUCCEEDED",
            defaultDatasetId: "dataset_missing"
          }
        }), {
          status: 200,
          headers: {
            "content-type": "application/json"
          }
        });
      }

      if (url.startsWith("https://api.apify.com/v2/datasets/dataset_missing/items")) {
        return new Response(JSON.stringify({
          error: "Dataset not found"
        }), {
          status: 404,
          headers: {
            "content-type": "application/json"
          }
        });
      }

      return new Response("not found", { status: 404 });
    });

    const app = createApifyServiceApp({
      apifyApiToken: "apify-test-token",
      actorId: "apify~instagram-scraper"
    });

    const response = await request(app)
      .post("/runs/poll")
      .send({
        providerJobId: "run_404",
        providerState: {
          datasetId: "dataset_missing"
        }
      });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      status: "failed",
      permanent: true,
      error: "Apify dataset fetch failed with status 404.",
      providerState: {
        actorId: "apify~instagram-scraper",
        datasetId: "dataset_missing",
        keyValueStoreId: null
      }
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
