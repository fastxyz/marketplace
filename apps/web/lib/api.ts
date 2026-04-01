import type {
  BuyerActivityResponse,
  CreateProviderEndpointDraftInput,
  CreateProviderServiceInput,
  OpenApiImportPreview,
  ProviderRequestRecord,
  ProviderAccountRecord,
  ProviderEndpointDraftRecord,
  ProviderServiceDetailRecord,
  ProviderServiceStatus,
  ServiceDetail,
  ServiceSummary,
  SettlementMode,
  SuggestionRecord,
  SuggestionStatus,
  SuggestionType,
  UpdateProviderEndpointDraftInput,
  UpdateProviderServiceInput
} from "@marketplace/shared";
import { clearStoredWalletSession } from "@/lib/wallet-session";
import { getServerApiBaseUrl } from "@/lib/api-base-url";

export interface ProviderRuntimeKeySummary {
  id: string;
  keyPrefix: string;
  createdAt: string;
  updatedAt: string;
}

function getApiBaseUrl(): string {
  return getServerApiBaseUrl();
}

function getAdminToken(): string {
  const token = process.env.MARKETPLACE_ADMIN_TOKEN;
  if (!token) {
    throw new Error("MARKETPLACE_ADMIN_TOKEN is required for admin web actions.");
  }

  return token;
}

async function fetchMarketplace<T>(input: {
  path: string;
  apiBaseUrl?: string;
  accessToken?: string;
  init?: RequestInit;
}): Promise<T> {
  const response = await fetch(`${(input.apiBaseUrl ?? getApiBaseUrl()).replace(/\/$/, "")}${input.path}`, {
    cache: "no-store",
    ...input.init,
    headers: {
      ...(input.accessToken ? { Authorization: `Bearer ${input.accessToken}` } : {}),
      ...(input.init?.headers ?? {})
    }
  });

  if (response.status === 204) {
    return undefined as T;
  }

  if (response.status === 401 && input.accessToken) {
    clearStoredWalletSession();
    throw new Error("Wallet session expired. Reconnect your wallet.");
  }

  if (!response.ok) {
    const message = await response.text();
    throw new Error(message || `Marketplace request failed: ${response.status}`);
  }

  return response.json() as Promise<T>;
}

export async function fetchServices(): Promise<ServiceSummary[]> {
  const data = await fetchMarketplace<{ services: ServiceSummary[] }>({
    path: "/catalog/services"
  });
  return data.services;
}

export async function fetchServiceDetail(slug: string, apiBaseUrl?: string): Promise<ServiceDetail | null> {
  const response = await fetch(`${(apiBaseUrl ?? getApiBaseUrl()).replace(/\/$/, "")}/catalog/services/${slug}`, {
    cache: "no-store"
  });

  if (response.status === 404) {
    return null;
  }

  if (response.status === 401) {
    clearStoredWalletSession();
    throw new Error("Wallet session expired. Reconnect your wallet.");
  }

  if (!response.ok) {
    throw new Error(await response.text());
  }

  return response.json() as Promise<ServiceDetail>;
}

export async function fetchBuyerActivity(input: {
  apiBaseUrl: string;
  accessToken: string;
  range?: "7d" | "30d" | "90d" | "all";
  limit?: number;
}): Promise<BuyerActivityResponse> {
  const params = new URLSearchParams();
  params.set("range", input.range ?? "30d");
  if (input.limit !== undefined) {
    params.set("limit", String(input.limit));
  }

  return fetchMarketplace<BuyerActivityResponse>({
    apiBaseUrl: input.apiBaseUrl,
    path: `/buyer/me/activity?${params.toString()}`,
    accessToken: input.accessToken
  });
}

export async function createSuggestion(input: {
  type: SuggestionType;
  serviceSlug?: string;
  title: string;
  description: string;
  sourceUrl?: string;
  requesterName?: string;
  requesterEmail?: string;
}): Promise<SuggestionRecord> {
  return fetchMarketplace<SuggestionRecord>({
    path: "/catalog/suggestions",
    init: {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify(input)
    }
  });
}

export async function fetchAdminSuggestions(status?: SuggestionStatus): Promise<SuggestionRecord[]> {
  const query = status ? `?status=${status}` : "";
  const data = await fetchMarketplace<{ suggestions: SuggestionRecord[] }>({
    path: `/internal/suggestions${query}`,
    init: {
      headers: {
        Authorization: `Bearer ${getAdminToken()}`
      }
    }
  });

  return data.suggestions;
}

export async function patchAdminSuggestion(
  id: string,
  input: { status?: SuggestionStatus; internalNotes?: string | null }
): Promise<SuggestionRecord> {
  return fetchMarketplace<SuggestionRecord>({
    path: `/internal/suggestions/${id}`,
    init: {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${getAdminToken()}`,
        "content-type": "application/json"
      },
      body: JSON.stringify(input)
    }
  });
}

async function fetchAdminMarketplaceNullable<T>(path: string): Promise<T | null> {
  const response = await fetch(`${getApiBaseUrl().replace(/\/$/, "")}${path}`, {
    cache: "no-store",
    headers: {
      Authorization: `Bearer ${getAdminToken()}`
    }
  });

  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    const message = await response.text();
    throw new Error(message || `Marketplace request failed: ${response.status}`);
  }

  return response.json() as Promise<T>;
}

export async function fetchAdminProviderServices(status?: ProviderServiceStatus): Promise<ProviderServiceDetailRecord[]> {
  const query = status ? `?status=${status}` : "";
  const data = await fetchMarketplace<{ services: ProviderServiceDetailRecord[] }>({
    path: `/internal/provider-services${query}`,
    init: {
      headers: {
        Authorization: `Bearer ${getAdminToken()}`
      }
    }
  });

  return data.services;
}

export async function fetchAdminProviderService(serviceId: string): Promise<ProviderServiceDetailRecord | null> {
  return fetchAdminMarketplaceNullable<ProviderServiceDetailRecord>(`/internal/provider-services/${serviceId}`);
}

export async function fetchSubmittedAdminProviderService(serviceId: string): Promise<ProviderServiceDetailRecord | null> {
  return fetchAdminMarketplaceNullable<ProviderServiceDetailRecord>(`/internal/provider-services/${serviceId}/submitted`);
}

export async function requestAdminProviderServiceChanges(
  serviceId: string,
  input: { reviewNotes: string; reviewerIdentity?: string | null }
): Promise<ProviderServiceDetailRecord> {
  return fetchMarketplace<ProviderServiceDetailRecord>({
    path: `/internal/provider-services/${serviceId}/request-changes`,
    init: {
      method: "POST",
      headers: {
        Authorization: `Bearer ${getAdminToken()}`,
        "content-type": "application/json"
      },
      body: JSON.stringify(input)
    }
  });
}

export async function publishAdminProviderService(
  serviceId: string,
  input: { reviewerIdentity?: string | null; settlementMode?: SettlementMode | null }
): Promise<ProviderServiceDetailRecord> {
  return fetchMarketplace<ProviderServiceDetailRecord>({
    path: `/internal/provider-services/${serviceId}/publish`,
    init: {
      method: "POST",
      headers: {
        Authorization: `Bearer ${getAdminToken()}`,
        "content-type": "application/json"
      },
      body: JSON.stringify(input)
    }
  });
}

export async function updateAdminProviderServiceSettlementMode(
  serviceId: string,
  input: { reviewerIdentity?: string | null; settlementMode: SettlementMode }
): Promise<ProviderServiceDetailRecord> {
  return fetchMarketplace<ProviderServiceDetailRecord>({
    path: `/internal/provider-services/${serviceId}/settlement-mode`,
    init: {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${getAdminToken()}`,
        "content-type": "application/json"
      },
      body: JSON.stringify(input)
    }
  });
}

export async function suspendAdminProviderService(
  serviceId: string,
  input: { reviewNotes?: string | null; reviewerIdentity?: string | null }
): Promise<ProviderServiceDetailRecord> {
  return fetchMarketplace<ProviderServiceDetailRecord>({
    path: `/internal/provider-services/${serviceId}/suspend`,
    init: {
      method: "POST",
      headers: {
        Authorization: `Bearer ${getAdminToken()}`,
        "content-type": "application/json"
      },
      body: JSON.stringify(input)
    }
  });
}

export async function fetchProviderAccount(
  apiBaseUrl: string,
  accessToken: string
): Promise<ProviderAccountRecord | null> {
  const response = await fetch(`${apiBaseUrl.replace(/\/$/, "")}/provider/me`, {
    cache: "no-store",
    headers: {
      Authorization: `Bearer ${accessToken}`
    }
  });

  if (response.status === 404) {
    return null;
  }

  if (response.status === 401) {
    clearStoredWalletSession();
    throw new Error("Wallet session expired. Reconnect your wallet.");
  }

  if (!response.ok) {
    throw new Error(await response.text());
  }

  return response.json() as Promise<ProviderAccountRecord>;
}

export async function fetchProviderRequests(
  apiBaseUrl: string,
  accessToken: string
): Promise<ProviderRequestRecord[]> {
  const data = await fetchMarketplace<{ requests: ProviderRequestRecord[] }>({
    apiBaseUrl,
    accessToken,
    path: "/provider/requests"
  });

  return data.requests;
}

export async function claimProviderRequest(
  apiBaseUrl: string,
  accessToken: string,
  requestId: string
): Promise<ProviderRequestRecord> {
  return fetchMarketplace<ProviderRequestRecord>({
    apiBaseUrl,
    accessToken,
    path: `/provider/requests/${requestId}/claim`,
    init: {
      method: "POST"
    }
  });
}

export async function upsertProviderAccount(
  apiBaseUrl: string,
  accessToken: string,
  input: {
    displayName: string;
    bio?: string | null;
    websiteUrl?: string | null;
    contactEmail?: string | null;
  }
): Promise<ProviderAccountRecord> {
  return fetchMarketplace<ProviderAccountRecord>({
    apiBaseUrl,
    accessToken,
    path: "/provider/me",
    init: {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify(input)
    }
  });
}

export async function fetchProviderServices(
  apiBaseUrl: string,
  accessToken: string
): Promise<ProviderServiceDetailRecord[]> {
  const data = await fetchMarketplace<{ services: ProviderServiceDetailRecord[] }>({
    apiBaseUrl,
    accessToken,
    path: "/provider/services"
  });

  return data.services;
}

export async function fetchProviderService(
  apiBaseUrl: string,
  accessToken: string,
  serviceId: string
): Promise<ProviderServiceDetailRecord | null> {
  const response = await fetch(`${apiBaseUrl.replace(/\/$/, "")}/provider/services/${serviceId}`, {
    cache: "no-store",
    headers: {
      Authorization: `Bearer ${accessToken}`
    }
  });

  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    throw new Error(await response.text());
  }

  return response.json() as Promise<ProviderServiceDetailRecord>;
}

export async function createProviderService(
  apiBaseUrl: string,
  accessToken: string,
  input: CreateProviderServiceInput
): Promise<ProviderServiceDetailRecord> {
  return fetchMarketplace<ProviderServiceDetailRecord>({
    apiBaseUrl,
    accessToken,
    path: "/provider/services",
    init: {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify(input)
    }
  });
}

export async function updateProviderService(
  apiBaseUrl: string,
  accessToken: string,
  serviceId: string,
  input: UpdateProviderServiceInput
): Promise<void> {
  await fetchMarketplace({
    apiBaseUrl,
    accessToken,
    path: `/provider/services/${serviceId}`,
    init: {
      method: "PATCH",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify(input)
    }
  });
}

export async function createProviderEndpoint(
  apiBaseUrl: string,
  accessToken: string,
  serviceId: string,
  input: CreateProviderEndpointDraftInput
): Promise<ProviderEndpointDraftRecord> {
  return fetchMarketplace<ProviderEndpointDraftRecord>({
    apiBaseUrl,
    accessToken,
    path: `/provider/services/${serviceId}/endpoints`,
    init: {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify(input)
    }
  });
}

export async function importProviderOpenApi(
  apiBaseUrl: string,
  accessToken: string,
  serviceId: string,
  documentUrl: string
): Promise<OpenApiImportPreview> {
  return fetchMarketplace<OpenApiImportPreview>({
    apiBaseUrl,
    accessToken,
    path: `/provider/services/${serviceId}/openapi/import`,
    init: {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        documentUrl
      })
    }
  });
}

export async function updateProviderEndpoint(
  apiBaseUrl: string,
  accessToken: string,
  serviceId: string,
  endpointId: string,
  input: UpdateProviderEndpointDraftInput
): Promise<ProviderEndpointDraftRecord> {
  return fetchMarketplace<ProviderEndpointDraftRecord>({
    apiBaseUrl,
    accessToken,
    path: `/provider/services/${serviceId}/endpoints/${endpointId}`,
    init: {
      method: "PATCH",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify(input)
    }
  });
}

export async function deleteProviderEndpoint(
  apiBaseUrl: string,
  accessToken: string,
  serviceId: string,
  endpointId: string
): Promise<void> {
  await fetchMarketplace<void>({
    apiBaseUrl,
    accessToken,
    path: `/provider/services/${serviceId}/endpoints/${endpointId}`,
    init: {
      method: "DELETE"
    }
  });
}

export async function createProviderVerificationChallenge(
  apiBaseUrl: string,
  accessToken: string,
  serviceId: string
): Promise<{ verificationId: string; token: string; expectedUrl: string }> {
  return fetchMarketplace({
    apiBaseUrl,
    accessToken,
    path: `/provider/services/${serviceId}/verification-challenge`,
    init: {
      method: "POST"
    }
  });
}

export async function verifyProviderService(
  apiBaseUrl: string,
  accessToken: string,
  serviceId: string
) {
  return fetchMarketplace({
    apiBaseUrl,
    accessToken,
    path: `/provider/services/${serviceId}/verify`,
    init: {
      method: "POST"
    }
  });
}

export async function fetchProviderRuntimeKey(
  apiBaseUrl: string,
  accessToken: string,
  serviceId: string
): Promise<ProviderRuntimeKeySummary | null> {
  const data = await fetchMarketplace<{ runtimeKey: ProviderRuntimeKeySummary | null }>({
    apiBaseUrl,
    accessToken,
    path: `/provider/services/${serviceId}/runtime-key`
  });
  return data.runtimeKey;
}

export async function rotateProviderRuntimeKey(
  apiBaseUrl: string,
  accessToken: string,
  serviceId: string
): Promise<{ runtimeKey: ProviderRuntimeKeySummary; plaintextKey: string }> {
  return fetchMarketplace<{ runtimeKey: ProviderRuntimeKeySummary; plaintextKey: string }>({
    apiBaseUrl,
    accessToken,
    path: `/provider/services/${serviceId}/runtime-key`,
    init: {
      method: "POST"
    }
  });
}

export async function submitProviderService(
  apiBaseUrl: string,
  accessToken: string,
  serviceId: string
): Promise<ProviderServiceDetailRecord> {
  return fetchMarketplace<ProviderServiceDetailRecord>({
    apiBaseUrl,
    accessToken,
    path: `/provider/services/${serviceId}/submit`,
    init: {
      method: "POST"
    }
  });
}
