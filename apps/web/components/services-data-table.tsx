"use client";

import React from "react";
import Link from "next/link";
import { ChevronRight } from "lucide-react";
import {
  type ColumnDef,
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type SortingState
} from "@tanstack/react-table";
import type {
  ExternalServiceCatalogEndpoint,
  MarketplaceServiceCatalogEndpoint,
  ServiceDetail,
  ServiceSummary
} from "@marketplace/shared";

import { fetchServiceDetail } from "@/lib/api";
import { getClientApiBaseUrl } from "@/lib/api-base-url";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

function formatSummaryPriceRange(priceRange: string): string {
  return priceRange === "Free" ? priceRange : `${priceRange} per call`;
}

function serviceAccessLabel(service: ServiceSummary): string {
  return service.serviceType === "marketplace_proxy" ? service.settlementLabel : service.accessModelLabel;
}

function servicePricingLabel(service: ServiceSummary): string {
  return service.serviceType === "marketplace_proxy"
    ? formatSummaryPriceRange(service.priceRange)
    : "Provider-defined";
}

function serviceTrafficLabel(service: ServiceSummary): string {
  return service.serviceType === "marketplace_proxy" ? String(service.totalCalls) : "Direct";
}

function serviceWebsiteUrl(service: ServiceSummary): string | null {
  return "websiteUrl" in service ? service.websiteUrl ?? null : null;
}

function inferWebsiteUrlFromServiceName(serviceName: string): string | null {
  const normalized = serviceName.toLowerCase();

  const exactMappings: Array<[string, string]> = [
    ["cheerio scraper", "https://cheerio.js.org"],
    ["tweet scraper", "https://x.com"],
    ["tavily proxy", "https://tavily.com"],
    ["zapper x402 api", "https://zapper.com"],
    ["stableenrich apollo api", "https://www.apollo.io"],
    ["stableenrich clado api", "https://clado.ai"],
    ["stableenrich exa api", "https://exa.ai"],
    ["stableenrich firecrawl api", "https://firecrawl.dev"],
    ["stableenrich google maps api", "https://www.google.com"],
    ["stableenrich hunter api", "https://hunter.io"],
    ["stableenrich reddit api", "https://www.reddit.com"],
    ["stableenrich serper api", "https://serper.dev"],
    ["stableenrich whitepages api", "https://www.whitepages.com"],
    ["stablesocial facebook api", "https://www.facebook.com"],
    ["stablesocial instagram api", "https://www.instagram.com"],
    ["stablesocial reddit api", "https://www.reddit.com"],
    ["stablesocial tiktok api", "https://www.tiktok.com"]
  ];

  for (const [serviceFragment, websiteUrl] of exactMappings) {
    if (normalized.includes(serviceFragment)) {
      return websiteUrl;
    }
  }

  if (normalized.includes("linkedin")) return "https://www.linkedin.com";
  if (normalized.includes("amazon")) return "https://www.amazon.com";
  if (normalized.includes("facebook")) return "https://www.facebook.com";
  if (normalized.includes("instagram")) return "https://www.instagram.com";
  if (normalized.includes("tiktok")) return "https://www.tiktok.com";
  if (normalized.includes("youtube")) return "https://www.youtube.com";
  if (normalized.includes("google")) return "https://www.google.com";
  if (normalized.includes("indeed")) return "https://www.indeed.com";
  if (normalized.includes("reddit")) return "https://www.reddit.com";
  if (normalized.includes("g2")) return "https://www.g2.com";
  if (normalized.includes("x.com") || normalized.includes("tweet")) return "https://x.com";

  return null;
}

function faviconUrlFromWebsiteUrl(websiteUrl: string): string | null {
  try {
    const hostname = new URL(websiteUrl).hostname;
    return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(hostname)}&sz=64`;
  } catch {
    return null;
  }
}

export function ServicesDataTable({ services }: { services: ServiceSummary[] }) {
  const [sorting, setSorting] = React.useState<SortingState>([{ id: "name", desc: false }]);
  const [expandedSlug, setExpandedSlug] = React.useState<string | null>(null);
  const [detailsBySlug, setDetailsBySlug] = React.useState<Record<string, ServiceDetail>>({});
  const [loadingSlug, setLoadingSlug] = React.useState<string | null>(null);
  const clientApiBaseUrl = React.useMemo(() => getClientApiBaseUrl(), []);
  const detailsBySlugRef = React.useRef(detailsBySlug);
  const inFlightDetailsRef = React.useRef<Record<string, Promise<ServiceDetail | null>>>({});

  React.useEffect(() => {
    detailsBySlugRef.current = detailsBySlug;
  }, [detailsBySlug]);

  const loadDetails = React.useCallback(async (service: ServiceSummary) => {
    const cachedDetail = detailsBySlugRef.current[service.slug];
    if (cachedDetail) {
      return cachedDetail;
    }

    const inFlightDetail = inFlightDetailsRef.current[service.slug];
    if (inFlightDetail) {
      return inFlightDetail;
    }

    setLoadingSlug(service.slug);
    const request = (async () => {
      const detail = await fetchServiceDetail(service.slug, clientApiBaseUrl);
      if (detail) {
        setDetailsBySlug((current) => ({ ...current, [service.slug]: detail }));
      }

      return detail;
    })();

    inFlightDetailsRef.current[service.slug] = request;

    try {
      return await request;
    } finally {
      delete inFlightDetailsRef.current[service.slug];
      setLoadingSlug((current) => (current === service.slug ? null : current));
    }
  }, [clientApiBaseUrl]);

  const preloadDetails = React.useCallback((service: ServiceSummary) => {
    void loadDetails(service);
  }, [loadDetails]);

  const toggleExpanded = React.useCallback(async (service: ServiceSummary) => {
    if (expandedSlug === service.slug) {
      setExpandedSlug(null);
      return;
    }

    setExpandedSlug(service.slug);
    await loadDetails(service);
  }, [expandedSlug, loadDetails]);

  const columns = React.useMemo<ColumnDef<ServiceSummary>[]>(() => [
    {
      accessorKey: "name",
      header: "Service",
      cell: ({ row }) => {
        const service = row.original;
        const websiteUrl = inferWebsiteUrlFromServiceName(service.name) ?? serviceWebsiteUrl(service);

        return (
          <div className="flex items-center gap-3">
            <ServiceFavicon
              serviceName={service.name}
              websiteUrl={websiteUrl}
            />
            <div>
              <div>{service.name}</div>
              <div>{service.tagline}</div>
            </div>
          </div>
        );
      }
    },
    {
      accessorKey: "ownerName",
      header: "Provider",
      cell: ({ row }) => <span>{row.original.ownerName}</span>
    },
    {
      id: "access",
      header: "Access",
      accessorFn: serviceAccessLabel
    },
    {
      id: "pricing",
      header: "Pricing",
      accessorFn: servicePricingLabel
    },
    {
      accessorKey: "endpointCount",
      header: "Endpoints"
    },
    {
      id: "traffic",
      header: "Calls",
      accessorFn: serviceTrafficLabel
    },
    {
      id: "details",
      header: "Details",
      cell: ({ row }) => {
        const expanded = expandedSlug === row.original.slug;

        return (
          <div className="flex justify-end">
            <Link
              href={`/services/${row.original.slug}`}
              onClick={(event) => event.stopPropagation()}
              aria-label={`Open ${row.original.name} details`}
            >
              <ChevronRight
                className={`h-4 w-4 text-muted-foreground transition-transform ${
                  expanded ? "rotate-90" : "group-hover/table-row:rotate-90"
                }`}
              />
            </Link>
          </div>
        );
      }
    }
  ], [expandedSlug]);

  const table = useReactTable({
    data: services,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel()
  });

  return (
    <Table className="w-full">
      <TableHeader>
        {table.getHeaderGroups().map((headerGroup) => (
          <TableRow key={headerGroup.id}>
            {headerGroup.headers.map((header) => {
              const canSort = header.column.getCanSort();
              const sort = header.column.getIsSorted();

              return (
                <TableHead key={header.id}>
                  {header.isPlaceholder ? null : canSort ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={header.column.getToggleSortingHandler()}
                    >
                      {String(flexRender(header.column.columnDef.header, header.getContext()))}
                      {sort === "asc" ? " ↑" : sort === "desc" ? " ↓" : ""}
                    </Button>
                  ) : (
                    flexRender(header.column.columnDef.header, header.getContext())
                  )}
                </TableHead>
              );
            })}
          </TableRow>
        ))}
      </TableHeader>
      <TableBody>
        {table.getRowModel().rows.length ? (
          table.getRowModel().rows.map((row) => {
            const service = row.original;
            const expanded = expandedSlug === service.slug;
            const detail = detailsBySlug[service.slug];
            const loading = loadingSlug === service.slug;

            return (
              <React.Fragment key={row.id}>
                <TableRow
                  className="group/table-row cursor-pointer"
                  onMouseEnter={() => preloadDetails(service)}
                  onFocus={() => preloadDetails(service)}
                  onTouchStart={() => preloadDetails(service)}
                  onClick={() => void toggleExpanded(service)}
                >
                  {row.getVisibleCells().map((cell) => (
                    <TableCell key={cell.id} className="py-4">
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </TableCell>
                  ))}
                </TableRow>
                {expanded ? (
                  <TableRow>
                    <TableCell colSpan={columns.length} className="bg-muted/20 px-2 py-4">
                      {loading && !detail ? <div className="text-sm text-muted-foreground">Loading details…</div> : null}
                      {detail ? <EndpointSubtable detail={detail} /> : null}
                    </TableCell>
                  </TableRow>
                ) : null}
              </React.Fragment>
            );
          })
        ) : (
          <TableRow>
            <TableCell colSpan={columns.length}>No services found.</TableCell>
          </TableRow>
        )}
      </TableBody>
    </Table>
  );
}

function EndpointSubtable({ detail }: { detail: ServiceDetail }) {
  return (
    <div className="grid gap-3">
      <div className="grid grid-cols-[360px_minmax(0,1fr)_120px] gap-4 text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">
        <div>Endpoint</div>
        <div>Description</div>
        <div>Price</div>
      </div>
      <div className="grid gap-2">
        {detail.serviceType === "marketplace_proxy"
          ? detail.endpoints.map((endpoint) => (
              <MarketplaceEndpointRow
                key={endpoint.routeId}
                endpoint={endpoint}
                serviceSlug={detail.summary.slug}
              />
            ))
          : detail.endpoints.map((endpoint) => (
              <ExternalEndpointRow
                key={endpoint.endpointId}
                endpoint={endpoint}
                serviceSlug={detail.summary.slug}
              />
            ))}
      </div>
    </div>
  );
}

function MarketplaceEndpointRow({
  endpoint,
  serviceSlug
}: {
  endpoint: MarketplaceServiceCatalogEndpoint;
  serviceSlug: string;
}) {
  const href = `/services/${serviceSlug}?endpoint=${encodeURIComponent(endpoint.routeId)}`;

  return (
    <div className="grid grid-cols-[360px_minmax(0,1fr)_120px] gap-4">
      <Link href={href} className="text-sm font-medium text-foreground hover:opacity-80">
        <div>{endpoint.method}</div>
        <div className="text-muted-foreground">{endpoint.path}</div>
      </Link>
      <Link href={href} className="text-sm hover:opacity-80">
        <div className="font-medium text-foreground">{endpoint.title}</div>
        <div className="text-muted-foreground">{endpoint.description}</div>
        <div className="text-muted-foreground">{endpoint.mode}</div>
      </Link>
      <div className="text-sm font-medium text-foreground">
        {endpoint.price}
        {endpoint.billingType === "fixed_x402" || endpoint.billingType === "topup_x402_variable" ? ` ${endpoint.tokenSymbol}` : ""}
      </div>
    </div>
  );
}

function ExternalEndpointRow({
  endpoint,
  serviceSlug
}: {
  endpoint: ExternalServiceCatalogEndpoint;
  serviceSlug: string;
}) {
  const href = `/services/${serviceSlug}?endpoint=${encodeURIComponent(endpoint.endpointId)}`;

  return (
    <div className="grid grid-cols-[360px_minmax(0,1fr)_120px] gap-4">
      <Link href={href} className="text-sm font-medium text-foreground hover:opacity-80">
        <div>{endpoint.method}</div>
        <div className="text-muted-foreground">{endpoint.publicUrl.replace(/^https?:\/\//, "")}</div>
      </Link>
      <Link href={href} className="text-sm hover:opacity-80">
        <div className="font-medium text-foreground">{endpoint.title}</div>
        <div className="text-muted-foreground">{endpoint.description}</div>
        <div className="text-muted-foreground">direct</div>
      </Link>
      <div className="text-sm font-medium text-foreground">Provider</div>
    </div>
  );
}

function ServiceFavicon({ serviceName, websiteUrl }: { serviceName: string; websiteUrl: string | null }) {
  const [imageFailed, setImageFailed] = React.useState(false);

  const faviconUrl = websiteUrl && !imageFailed ? faviconUrlFromWebsiteUrl(websiteUrl) : null;

  return (
    <div className="flex items-center gap-3">
      {faviconUrl ? (
        <img
          src={faviconUrl}
          alt={`${serviceName} favicon`}
          width={16}
          height={16}
          onError={() => setImageFailed(true)}
        />
      ) : (
        <div
          aria-hidden="true"
          className="flex h-4 w-4 items-center justify-center rounded-full border border-border text-[10px] font-medium uppercase"
        >
          {serviceName.slice(0, 1)}
        </div>
      )}
    </div>
  );
}
