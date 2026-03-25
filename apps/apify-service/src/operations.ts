export interface ApifyProxyRouteDefinition {
  path: `/${string}`;
  operationId: string;
  summary: string;
  description: string;
  requestSchemaJson: Record<string, unknown>;
  requestExample: Record<string, unknown>;
}

export const GENERIC_APIFY_PROXY_ROUTE: ApifyProxyRouteDefinition = {
  path: "/run",
  operationId: "run",
  summary: "Run actor",
  description: "Start an async Apify actor run with raw input JSON.",
  requestSchemaJson: {
    type: "object",
    additionalProperties: true
  },
  requestExample: {
    startUrls: [
      {
        url: "https://example.com"
      }
    ]
  }
};

const APIFY_PROXY_ROUTE_PRESETS: Record<string, ApifyProxyRouteDefinition[]> = {
  "compass/crawler-google-places": [
    {
      path: "/search-places",
      operationId: "search-places",
      summary: "Search places",
      description: "Search Google Maps by term and return matching places.",
      requestSchemaJson: {
        type: "object",
        required: ["searchStringsArray"],
        properties: {
          searchStringsArray: {
            type: "array",
            minItems: 1,
            items: {
              type: "string",
              minLength: 1
            }
          },
          maxCrawledPlacesPerSearch: {
            type: "integer",
            minimum: 1
          }
        },
        additionalProperties: true
      },
      requestExample: {
        searchStringsArray: ["coffee shops"],
        locationQuery: "San Francisco, California, United States",
        maxCrawledPlacesPerSearch: 20
      }
    },
    {
      path: "/place-details",
      operationId: "place-details",
      summary: "Fetch place details",
      description: "Extract detailed Google Maps fields for known place IDs or direct place URLs.",
      requestSchemaJson: {
        type: "object",
        properties: {
          placeIds: {
            type: "array",
            minItems: 1,
            items: {
              type: "string",
              minLength: 1
            }
          },
          startUrls: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              required: ["url"],
              properties: {
                url: {
                  type: "string",
                  format: "uri"
                }
              },
              additionalProperties: false
            }
          },
          scrapePlaceDetailPage: {
            type: "boolean"
          }
        },
        anyOf: [
          { required: ["placeIds"] },
          { required: ["startUrls"] }
        ],
        additionalProperties: true
      },
      requestExample: {
        placeIds: ["ChIJJQz5EZzKw4kRCZ95UajbyGw"],
        scrapePlaceDetailPage: true
      }
    },
    {
      path: "/place-reviews",
      operationId: "place-reviews",
      summary: "Fetch place reviews",
      description: "Extract Google Maps reviews for known places.",
      requestSchemaJson: {
        type: "object",
        properties: {
          placeIds: {
            type: "array",
            minItems: 1,
            items: {
              type: "string",
              minLength: 1
            }
          },
          startUrls: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              required: ["url"],
              properties: {
                url: {
                  type: "string",
                  format: "uri"
                }
              },
              additionalProperties: false
            }
          },
          scrapePlaceDetailPage: {
            type: "boolean"
          },
          maxReviews: {
            type: "integer",
            minimum: 1
          },
          reviewsSort: {
            type: "string"
          }
        },
        anyOf: [
          { required: ["placeIds"] },
          { required: ["startUrls"] }
        ],
        additionalProperties: true
      },
      requestExample: {
        placeIds: ["ChIJJQz5EZzKw4kRCZ95UajbyGw"],
        scrapePlaceDetailPage: true,
        maxReviews: 25,
        reviewsSort: "newest"
      }
    },
    {
      path: "/lead-enrichment",
      operationId: "lead-enrichment",
      summary: "Enrich business leads",
      description: "Search Google Maps and enrich matched businesses with contacts, social profiles, and lead records.",
      requestSchemaJson: {
        type: "object",
        required: ["searchStringsArray"],
        properties: {
          searchStringsArray: {
            type: "array",
            minItems: 1,
            items: {
              type: "string",
              minLength: 1
            }
          },
          locationQuery: {
            type: "string"
          },
          maxCrawledPlacesPerSearch: {
            type: "integer",
            minimum: 1
          },
          website: {
            type: "string"
          },
          scrapePlaceDetailPage: {
            type: "boolean"
          },
          scrapeContacts: {
            type: "boolean"
          },
          scrapeSocialMediaProfiles: {
            type: "object",
            additionalProperties: true
          },
          maximumLeadsEnrichmentRecords: {
            type: "integer",
            minimum: 1
          }
        },
        additionalProperties: true
      },
      requestExample: {
        searchStringsArray: ["dentists"],
        locationQuery: "Austin, Texas, United States",
        maxCrawledPlacesPerSearch: 20,
        website: "allPlaces",
        scrapePlaceDetailPage: true,
        scrapeContacts: true,
        scrapeSocialMediaProfiles: {
          facebooks: true,
          instagrams: true,
          youtubes: false,
          tiktoks: false,
          twitters: true
        },
        maximumLeadsEnrichmentRecords: 3
      }
    }
  ],
  "clockworks/tiktok-scraper": [
    {
      path: "/profile-posts",
      operationId: "profile-posts",
      summary: "Fetch profile posts",
      description: "Scrape videos from one or more TikTok profiles.",
      requestSchemaJson: {
        type: "object",
        required: ["profiles"],
        properties: {
          profiles: {
            type: "array",
            minItems: 1,
            items: {
              type: "string",
              minLength: 1
            }
          },
          resultsPerPage: {
            type: "integer",
            minimum: 1
          },
          profileScrapeSections: {
            type: "array",
            items: {
              type: "string",
              enum: ["videos", "reposts"]
            }
          },
          profileSorting: {
            type: "string",
            enum: ["latest", "popular", "oldest"]
          },
          excludePinnedPosts: {
            type: "boolean"
          }
        },
        additionalProperties: true
      },
      requestExample: {
        profiles: ["@example"],
        resultsPerPage: 25,
        profileScrapeSections: ["videos"],
        profileSorting: "latest",
        excludePinnedPosts: false
      }
    },
    {
      path: "/hashtag-posts",
      operationId: "hashtag-posts",
      summary: "Fetch hashtag posts",
      description: "Scrape TikTok videos for one or more hashtags.",
      requestSchemaJson: {
        type: "object",
        required: ["hashtags"],
        properties: {
          hashtags: {
            type: "array",
            minItems: 1,
            items: {
              type: "string",
              minLength: 1
            }
          },
          resultsPerPage: {
            type: "integer",
            minimum: 1
          }
        },
        additionalProperties: true
      },
      requestExample: {
        hashtags: ["aiagents"],
        resultsPerPage: 25
      }
    },
    {
      path: "/search-posts",
      operationId: "search-posts",
      summary: "Search TikTok posts",
      description: "Search TikTok by keyword and return top videos or profiles.",
      requestSchemaJson: {
        type: "object",
        required: ["searchQueries"],
        properties: {
          searchQueries: {
            type: "array",
            minItems: 1,
            items: {
              type: "string",
              minLength: 1
            }
          },
          resultsPerPage: {
            type: "integer",
            minimum: 1
          },
          searchSection: {
            type: "string",
            enum: ["", "/video", "/user"]
          },
          searchSorting: {
            type: "string",
            enum: ["0", "1", "3"]
          }
        },
        additionalProperties: true
      },
      requestExample: {
        searchQueries: ["fast wallet"],
        resultsPerPage: 25,
        searchSection: "/video",
        searchSorting: "0"
      }
    },
    {
      path: "/video-details",
      operationId: "video-details",
      summary: "Fetch video details",
      description: "Scrape one or more direct TikTok video URLs and optionally include related videos.",
      requestSchemaJson: {
        type: "object",
        required: ["postURLs"],
        properties: {
          postURLs: {
            type: "array",
            minItems: 1,
            items: {
              type: "string",
              format: "uri"
            }
          },
          scrapeRelatedVideos: {
            type: "boolean"
          },
          resultsPerPage: {
            type: "integer",
            minimum: 1
          }
        },
        additionalProperties: true
      },
      requestExample: {
        postURLs: ["https://www.tiktok.com/@example/video/7534061113365859586"],
        scrapeRelatedVideos: false,
        resultsPerPage: 10
      }
    }
  ],
  "apify/instagram-scraper": [
    {
      path: "/profile-posts",
      operationId: "profile-posts",
      summary: "Fetch profile posts",
      description: "Scrape posts from one or more Instagram profile URLs.",
      requestSchemaJson: {
        type: "object",
        required: ["directUrls", "resultsType"],
        properties: {
          directUrls: {
            type: "array",
            minItems: 1,
            items: {
              type: "string",
              format: "uri"
            }
          },
          resultsType: {
            type: "string",
            enum: ["posts", "details", "comments", "reels"]
          },
          resultsLimit: {
            type: "integer",
            minimum: 1
          }
        },
        additionalProperties: true
      },
      requestExample: {
        directUrls: ["https://www.instagram.com/example/"],
        resultsType: "posts",
        resultsLimit: 25
      }
    },
    {
      path: "/hashtag-posts",
      operationId: "hashtag-posts",
      summary: "Fetch hashtag posts",
      description: "Search Instagram hashtags and return posts for matching tags.",
      requestSchemaJson: {
        type: "object",
        required: ["search", "searchType", "resultsType"],
        properties: {
          search: {
            type: "string",
            minLength: 1
          },
          searchType: {
            type: "string",
            enum: ["hashtag", "user", "place"]
          },
          searchLimit: {
            type: "integer",
            minimum: 1
          },
          resultsType: {
            type: "string",
            enum: ["posts", "details", "comments", "reels"]
          },
          resultsLimit: {
            type: "integer",
            minimum: 1
          }
        },
        additionalProperties: true
      },
      requestExample: {
        search: "aiagents",
        searchType: "hashtag",
        searchLimit: 1,
        resultsType: "posts",
        resultsLimit: 25
      }
    },
    {
      path: "/place-posts",
      operationId: "place-posts",
      summary: "Fetch place posts",
      description: "Search Instagram places and return posts for matching locations.",
      requestSchemaJson: {
        type: "object",
        required: ["search", "searchType", "resultsType"],
        properties: {
          search: {
            type: "string",
            minLength: 1
          },
          searchType: {
            type: "string",
            enum: ["hashtag", "user", "place"]
          },
          searchLimit: {
            type: "integer",
            minimum: 1
          },
          resultsType: {
            type: "string",
            enum: ["posts", "details", "comments", "reels"]
          },
          resultsLimit: {
            type: "integer",
            minimum: 1
          }
        },
        additionalProperties: true
      },
      requestExample: {
        search: "Niagara Falls",
        searchType: "place",
        searchLimit: 1,
        resultsType: "posts",
        resultsLimit: 25
      }
    },
    {
      path: "/post-comments",
      operationId: "post-comments",
      summary: "Fetch post comments",
      description: "Scrape comments from one or more Instagram post URLs.",
      requestSchemaJson: {
        type: "object",
        required: ["directUrls", "resultsType"],
        properties: {
          directUrls: {
            type: "array",
            minItems: 1,
            items: {
              type: "string",
              format: "uri"
            }
          },
          resultsType: {
            type: "string",
            enum: ["comments"]
          },
          resultsLimit: {
            type: "integer",
            minimum: 1
          }
        },
        additionalProperties: true
      },
      requestExample: {
        directUrls: ["https://www.instagram.com/p/C3TTthZLoQK/"],
        resultsType: "comments",
        resultsLimit: 25
      }
    }
  ],
  "apidojo/tweet-scraper": [
    {
      path: "/search-tweets",
      operationId: "search-tweets",
      summary: "Search tweets",
      description: "Run advanced Twitter search queries and return matching tweets.",
      requestSchemaJson: {
        type: "object",
        required: ["searchTerms"],
        properties: {
          searchTerms: {
            type: "array",
            minItems: 1,
            items: {
              type: "string",
              minLength: 1
            }
          },
          sort: {
            type: "string"
          },
          tweetLanguage: {
            type: "string"
          }
        },
        additionalProperties: true
      },
      requestExample: {
        searchTerms: ["artificial intelligence"],
        sort: "Latest",
        tweetLanguage: "en"
      }
    },
    {
      path: "/profile-tweets",
      operationId: "profile-tweets",
      summary: "Fetch profile tweets",
      description: "Return tweets from a specific X profile using author filters.",
      requestSchemaJson: {
        type: "object",
        properties: {
          author: {
            type: "string",
            minLength: 1
          },
          searchTerms: {
            type: "array",
            minItems: 1,
            items: {
              type: "string",
              minLength: 1
            }
          },
          sort: {
            type: "string"
          }
        },
        anyOf: [
          { required: ["author"] },
          { required: ["searchTerms"] }
        ],
        additionalProperties: true
      },
      requestExample: {
        author: "NASA",
        searchTerms: ["from:NASA"],
        sort: "Latest"
      }
    },
    {
      path: "/hashtag-tweets",
      operationId: "hashtag-tweets",
      summary: "Fetch hashtag tweets",
      description: "Return tweets for one or more hashtag queries.",
      requestSchemaJson: {
        type: "object",
        required: ["searchTerms"],
        properties: {
          searchTerms: {
            type: "array",
            minItems: 1,
            items: {
              type: "string",
              minLength: 1
            }
          },
          sort: {
            type: "string"
          },
          tweetLanguage: {
            type: "string"
          }
        },
        additionalProperties: true
      },
      requestExample: {
        searchTerms: ["#AI lang:en"],
        sort: "Latest",
        tweetLanguage: "en"
      }
    },
    {
      path: "/verified-topic-tweets",
      operationId: "verified-topic-tweets",
      summary: "Fetch verified-user tweets",
      description: "Search topic tweets and limit results to verified authors.",
      requestSchemaJson: {
        type: "object",
        required: ["searchTerms"],
        properties: {
          searchTerms: {
            type: "array",
            minItems: 1,
            items: {
              type: "string",
              minLength: 1
            }
          },
          onlyVerifiedUsers: {
            type: "boolean"
          },
          sort: {
            type: "string"
          }
        },
        additionalProperties: true
      },
      requestExample: {
        searchTerms: ["cryptocurrency filter:verified"],
        onlyVerifiedUsers: true,
        sort: "Top"
      }
    }
  ],
  "apify/facebook-posts-scraper": [
    {
      path: "/page-posts",
      operationId: "page-posts",
      summary: "Fetch page posts",
      description: "Scrape posts from one or more public Facebook pages.",
      requestSchemaJson: {
        type: "object",
        required: ["startUrls"],
        properties: {
          startUrls: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              required: ["url"],
              properties: {
                url: {
                  type: "string",
                  format: "uri"
                }
              },
              additionalProperties: false
            }
          },
          resultsLimit: {
            type: "integer",
            minimum: 1
          }
        },
        additionalProperties: true
      },
      requestExample: {
        startUrls: [
          {
            url: "https://www.facebook.com/cern/"
          }
        ],
        resultsLimit: 25
      }
    },
    {
      path: "/video-posts",
      operationId: "video-posts",
      summary: "Fetch video posts",
      description: "Scrape Facebook posts and include video transcripts when available.",
      requestSchemaJson: {
        type: "object",
        required: ["startUrls"],
        properties: {
          startUrls: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              required: ["url"],
              properties: {
                url: {
                  type: "string",
                  format: "uri"
                }
              },
              additionalProperties: false
            }
          },
          resultsLimit: {
            type: "integer",
            minimum: 1
          },
          captionText: {
            type: "boolean"
          }
        },
        additionalProperties: true
      },
      requestExample: {
        startUrls: [
          {
            url: "https://www.facebook.com/cern/"
          }
        ],
        resultsLimit: 10,
        captionText: true
      }
    },
    {
      path: "/posts-by-date",
      operationId: "posts-by-date",
      summary: "Fetch posts by date range",
      description: "Scrape Facebook posts constrained to a newer and older date boundary.",
      requestSchemaJson: {
        type: "object",
        required: ["startUrls"],
        properties: {
          startUrls: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              required: ["url"],
              properties: {
                url: {
                  type: "string",
                  format: "uri"
                }
              },
              additionalProperties: false
            }
          },
          resultsLimit: {
            type: "integer",
            minimum: 1
          },
          onlyPostsNewerThan: {
            type: "string"
          },
          onlyPostsOlderThan: {
            type: "string"
          }
        },
        additionalProperties: true
      },
      requestExample: {
        startUrls: [
          {
            url: "https://www.facebook.com/cern/"
          }
        ],
        resultsLimit: 25,
        onlyPostsNewerThan: "2026-01-01",
        onlyPostsOlderThan: "2026-02-01"
      }
    },
    {
      path: "/page-posts-with-transcripts",
      operationId: "page-posts-with-transcripts",
      summary: "Fetch posts with transcripts",
      description: "Scrape public Facebook page posts and request transcript extraction for video posts.",
      requestSchemaJson: {
        type: "object",
        required: ["startUrls"],
        properties: {
          startUrls: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              required: ["url"],
              properties: {
                url: {
                  type: "string",
                  format: "uri"
                }
              },
              additionalProperties: false
            }
          },
          resultsLimit: {
            type: "integer",
            minimum: 1
          },
          captionText: {
            type: "boolean"
          }
        },
        additionalProperties: true
      },
      requestExample: {
        startUrls: [
          {
            url: "https://www.facebook.com/cern/"
          }
        ],
        resultsLimit: 25,
        captionText: true
      }
    }
  ],
  "streamers/youtube-scraper": [
    {
      path: "/search-videos",
      operationId: "search-videos",
      summary: "Search YouTube videos",
      description: "Search YouTube by term and return regular videos, shorts, or streams.",
      requestSchemaJson: {
        type: "object",
        required: ["searchQueries"],
        properties: {
          searchQueries: {
            type: "array",
            minItems: 1,
            items: {
              type: "string",
              minLength: 1
            }
          },
          maxResults: {
            type: "integer",
            minimum: 0
          },
          maxResultsShorts: {
            type: "integer",
            minimum: 0
          },
          maxResultStreams: {
            type: "integer",
            minimum: 0
          }
        },
        additionalProperties: true
      },
      requestExample: {
        searchQueries: ["fast blockchain"],
        maxResults: 10,
        maxResultsShorts: 0,
        maxResultStreams: 0
      }
    },
    {
      path: "/channel-videos",
      operationId: "channel-videos",
      summary: "Fetch channel videos",
      description: "Scrape regular videos from a YouTube channel URL.",
      requestSchemaJson: {
        type: "object",
        required: ["startUrls"],
        properties: {
          startUrls: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              required: ["url"],
              properties: {
                url: {
                  type: "string",
                  format: "uri"
                }
              },
              additionalProperties: false
            }
          },
          maxResults: {
            type: "integer",
            minimum: 0
          }
        },
        additionalProperties: true
      },
      requestExample: {
        startUrls: [
          {
            url: "https://www.youtube.com/@example"
          }
        ],
        maxResults: 25
      }
    },
    {
      path: "/playlist-videos",
      operationId: "playlist-videos",
      summary: "Fetch playlist videos",
      description: "Scrape videos from one or more YouTube playlist URLs.",
      requestSchemaJson: {
        type: "object",
        required: ["startUrls"],
        properties: {
          startUrls: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              required: ["url"],
              properties: {
                url: {
                  type: "string",
                  format: "uri"
                }
              },
              additionalProperties: false
            }
          },
          maxResults: {
            type: "integer",
            minimum: 0
          }
        },
        additionalProperties: true
      },
      requestExample: {
        startUrls: [
          {
            url: "https://www.youtube.com/playlist?list=PLObrtcm1Kw6PmbXg8bmfJN-o2Hgx8sidf"
          }
        ],
        maxResults: 25
      }
    },
    {
      path: "/video-subtitles",
      operationId: "video-subtitles",
      summary: "Fetch video subtitles",
      description: "Scrape YouTube video details and download subtitles when available.",
      requestSchemaJson: {
        type: "object",
        required: ["startUrls"],
        properties: {
          startUrls: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              required: ["url"],
              properties: {
                url: {
                  type: "string",
                  format: "uri"
                }
              },
              additionalProperties: false
            }
          },
          downloadSubtitles: {
            type: "boolean"
          },
          subtitlesLanguage: {
            type: "string"
          },
          subtitlesFormat: {
            type: "string"
          }
        },
        additionalProperties: true
      },
      requestExample: {
        startUrls: [
          {
            url: "https://www.youtube.com/watch?v=RjHzznQy6hI"
          }
        ],
        downloadSubtitles: true,
        subtitlesLanguage: "en",
        subtitlesFormat: "srt"
      }
    }
  ]
};

export function getApifyProxyRoutes(actorId: string): ApifyProxyRouteDefinition[] {
  const normalizedActorId = normalizeApifyActorId(actorId);
  return APIFY_PROXY_ROUTE_PRESETS[normalizedActorId] ?? [GENERIC_APIFY_PROXY_ROUTE];
}

function normalizeApifyActorId(actorId: string): string {
  return actorId.trim().replace(/~/g, "/");
}
