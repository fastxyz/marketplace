import http from "node:http";

const port = Number(process.env.PORT ?? 4100);
const adminToken = process.env.MARKETPLACE_ADMIN_TOKEN ?? "test-admin-token";

const service = {
  summary: {
    slug: "mock-research-signals",
    name: "Mock Research Signals",
    ownerName: "Fast Marketplace",
    tagline: "Synthetic paid research endpoints for testing Fast-native agent purchases.",
    categories: ["Research", "Testing", "Developer Tools"],
    priceRange: "$0.05 USDC - $0.15 USDC",
    settlementToken: "USDC",
    endpointCount: 2,
    totalCalls: 18,
    revenue: "0.42",
    successRate30d: 75,
    volume30d: [
      { date: "2026-03-16", amount: "0.15" },
      { date: "2026-03-17", amount: "0.12" },
      { date: "2026-03-18", amount: "0.15" }
    ]
  },
  about: "A mock service for wallet and x402 smoke tests.",
  useThisServicePrompt: 'I want to use the "Mock Research Signals" service on Fast Marketplace.',
  skillUrl: "http://127.0.0.1:3100/skill.md",
  endpoints: [
    {
      routeId: "mock.quick-insight.v1",
      title: "Quick Insight",
      description: "Return a paid single-shot mock insight response.",
      price: "$0.05",
      tokenSymbol: "USDC",
      mode: "sync",
      method: "POST",
      path: "/api/mock/quick-insight",
      proxyUrl: "https://api.marketplace.example.com/api/mock/quick-insight",
      requestExample: { query: "fast-native data marketplaces" },
      responseExample: { summary: "Mock alpha signal." },
      usageNotes: "Low-latency single request."
    },
    {
      routeId: "mock.async-report.v1",
      title: "Async Report",
      description: "Create a paid async mock report job and return a job token.",
      price: "$0.15",
      tokenSymbol: "USDC",
      mode: "async",
      method: "POST",
      path: "/api/mock/async-report",
      proxyUrl: "https://api.marketplace.example.com/api/mock/async-report",
      requestExample: { topic: "consumer AI distribution shifts", delayMs: 5000 },
      responseExample: { report: "Mock report body." },
      usageNotes: "Async job with polling."
    }
  ]
};

const suggestions = [];

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      if (!raw) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function send(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function isAdmin(req) {
  return req.headers.authorization === `Bearer ${adminToken}`;
}

const server = http.createServer(async (req, res) => {
  if (!req.url || !req.method) {
    send(res, 404, { error: "Not found." });
    return;
  }

  if (req.method === "GET" && req.url === "/catalog/services") {
    send(res, 200, { services: [service.summary] });
    return;
  }

  if (req.method === "GET" && req.url === "/catalog/services/mock-research-signals") {
    send(res, 200, service);
    return;
  }

  if (req.method === "POST" && req.url === "/catalog/suggestions") {
    const body = await readBody(req);
    const suggestion = {
      id: `suggestion_${suggestions.length + 1}`,
      type: body.type,
      serviceSlug: body.serviceSlug ?? null,
      title: body.title,
      description: body.description,
      sourceUrl: body.sourceUrl ?? null,
      requesterName: body.requesterName ?? null,
      requesterEmail: body.requesterEmail ?? null,
      status: "submitted",
      internalNotes: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    suggestions.unshift(suggestion);
    send(res, 201, suggestion);
    return;
  }

  if (req.method === "GET" && req.url.startsWith("/internal/suggestions")) {
    if (!isAdmin(req)) {
      send(res, 401, { error: "Unauthorized" });
      return;
    }

    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    const status = url.searchParams.get("status");
    const filtered = status ? suggestions.filter((suggestion) => suggestion.status === status) : suggestions;
    send(res, 200, { suggestions: filtered });
    return;
  }

  if (req.method === "PATCH" && req.url.startsWith("/internal/suggestions/")) {
    if (!isAdmin(req)) {
      send(res, 401, { error: "Unauthorized" });
      return;
    }

    const id = req.url.split("/").pop();
    const body = await readBody(req);
    const suggestion = suggestions.find((item) => item.id === id);
    if (!suggestion) {
      send(res, 404, { error: "Not found" });
      return;
    }

    suggestion.status = body.status ?? suggestion.status;
    suggestion.internalNotes = body.internalNotes ?? suggestion.internalNotes;
    suggestion.updatedAt = new Date().toISOString();
    send(res, 200, suggestion);
    return;
  }

  send(res, 404, { error: "Not found." });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Mock catalog server listening on http://127.0.0.1:${port}`);
});
