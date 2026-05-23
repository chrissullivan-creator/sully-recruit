import type { VercelRequest, VercelResponse } from "@vercel/node";

/**
 * GET /api/brain/openapi
 *
 * OpenAPI 3.1 schema for the Sully Brain custom GPT. Paste the JSON
 * (or the URL) into ChatGPT → Configure GPT → Actions → Schema.
 *
 * NOTE: this endpoint is intentionally unauthenticated so ChatGPT can
 * fetch the spec when configuring the Action. The endpoints described
 * inside all require Bearer auth.
 */
export default function handler(req: VercelRequest, res: VercelResponse) {
  const host = (req.headers["x-forwarded-host"] || req.headers.host || "www.sullyrecruit.app") as string;
  const proto = ((req.headers["x-forwarded-proto"] as string) || "https").split(",")[0];
  const baseUrl = `${proto}://${host}`;

  const spec = {
    openapi: "3.1.0",
    info: {
      title: "Sully Brain",
      description:
        "Read-only assistant brain over Sully Recruit — people, jobs, communications, calendar, notes, send-out pipeline, and candidate→job matching. Hybrid (semantic + keyword) search backed by Postgres FTS and Voyage embeddings.",
      version: "1.0.0",
    },
    servers: [{ url: baseUrl }],
    security: [{ BearerAuth: [] }],
    components: {
      securitySchemes: {
        BearerAuth: { type: "http", scheme: "bearer" },
      },
    },
    paths: {
      "/api/brain/health": {
        get: {
          operationId: "healthCheck",
          summary: "Quick connectivity + row-count check. Call this first to confirm auth works.",
          responses: { "200": { description: "ok", content: { "application/json": { schema: { type: "object" } } } } },
        },
      },
      "/api/brain/search": {
        post: {
          operationId: "searchEverything",
          summary:
            "Hybrid (FTS + semantic) search across all indexed content. Use this whenever the user's question doesn't already point at a specific person or job.",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["query"],
                  properties: {
                    query: {
                      type: "string",
                      description: "Natural language. Combines keyword and semantic ranking.",
                    },
                    kinds: {
                      type: "array",
                      items: {
                        type: "string",
                        enum: ["candidate", "contact", "company", "job", "message", "call", "note", "send_out", "resume"],
                      },
                      description: "Restrict to specific source kinds. Omit to search everything.",
                    },
                    limit: { type: "integer", description: "Max rows (1-50). Default 12." },
                  },
                },
              },
            },
          },
          responses: { "200": { description: "Ranked hits.", content: { "application/json": { schema: { type: "object" } } } } },
        },
      },
      "/api/brain/person": {
        post: {
          operationId: "getPerson",
          summary:
            "Full profile for one person (candidate OR client). Provide either person_id OR a free-text query — if the query is ambiguous, the response includes up to 5 disambiguation candidates.",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    person_id: { type: "string", description: "uuid from candidates/contacts" },
                    query: { type: "string", description: "Name, email, or LinkedIn handle." },
                  },
                },
              },
            },
          },
          responses: { "200": { description: "Person record or disambiguation list.", content: { "application/json": { schema: { type: "object" } } } } },
        },
      },
      "/api/brain/person-comms": {
        post: {
          operationId: "getPersonCommunications",
          summary:
            "Last N messages (email, LinkedIn, SMS) and calls for a person, merged + sorted by time. Each row includes the actual body / AI call summary so you can quote verbatim instead of guessing.",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["person_id"],
                  properties: {
                    person_id: { type: "string" },
                    limit: { type: "integer", description: "Default 10, max 30." },
                  },
                },
              },
            },
          },
          responses: { "200": { description: "Communications timeline.", content: { "application/json": { schema: { type: "object" } } } } },
        },
      },
      "/api/brain/person-notes": {
        post: {
          operationId: "getPersonNotes",
          summary: "Recent recruiter-written notes for one person.",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["person_id"],
                  properties: {
                    person_id: { type: "string" },
                    limit: { type: "integer", description: "Default 10, max 30." },
                  },
                },
              },
            },
          },
          responses: { "200": { description: "Notes.", content: { "application/json": { schema: { type: "object" } } } } },
        },
      },
      "/api/brain/jobs": {
        post: {
          operationId: "searchJobs",
          summary: "Search open jobs by title/company/location/status.",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    query: { type: "string" },
                    status: { type: "string", description: "e.g. 'active', 'closed'." },
                    limit: { type: "integer", description: "Default 15, max 50." },
                  },
                },
              },
            },
          },
          responses: { "200": { description: "Jobs list.", content: { "application/json": { schema: { type: "object" } } } } },
        },
      },
      "/api/brain/job": {
        post: {
          operationId: "getJob",
          summary: "Full job detail plus send-outs grouped by stage and recent pipeline.",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["job_id"],
                  properties: { job_id: { type: "string" } },
                },
              },
            },
          },
          responses: { "200": { description: "Job + pipeline.", content: { "application/json": { schema: { type: "object" } } } } },
        },
      },
      "/api/brain/companies": {
        post: {
          operationId: "searchCompanies",
          summary: "Find companies by name or domain. Returns open-job count and contact count per company.",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["query"],
                  properties: {
                    query: { type: "string" },
                    limit: { type: "integer", description: "Default 10, max 25." },
                  },
                },
              },
            },
          },
          responses: { "200": { description: "Companies.", content: { "application/json": { schema: { type: "object" } } } } },
        },
      },
      "/api/brain/match-candidates": {
        post: {
          operationId: "matchCandidatesToJob",
          summary:
            "Rank candidates from the DB against a job (either pass job_id or pass an ad-hoc title+description). Returns the top N with similarity scores so you can write the rationale.",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    job_id: { type: "string", description: "Use an existing job in the DB." },
                    title: { type: "string", description: "Ad-hoc role title (used if job_id omitted)." },
                    company: { type: "string" },
                    description: { type: "string" },
                    location: { type: "string" },
                    compensation: { type: "string" },
                    limit: { type: "integer", description: "Default 15, max 50." },
                  },
                },
              },
            },
          },
          responses: { "200": { description: "Ranked candidates.", content: { "application/json": { schema: { type: "object" } } } } },
        },
      },
      "/api/brain/calendar": {
        post: {
          operationId: "getCalendar",
          summary: "Outlook + internal calendar lookups. Filter by person, date range, or free-text title.",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    person_id: { type: "string", description: "Only events with this person as attendee." },
                    from_date: { type: "string", description: "ISO date. Default = 30 days ago." },
                    to_date: { type: "string", description: "ISO date. Default = 60 days from now." },
                    query: { type: "string", description: "Match on title/description/location." },
                    limit: { type: "integer", description: "Default 25, max 100." },
                  },
                },
              },
            },
          },
          responses: { "200": { description: "Calendar events with attendees.", content: { "application/json": { schema: { type: "object" } } } } },
        },
      },
      "/api/brain/recent-activity": {
        post: {
          operationId: "getRecentActivity",
          summary:
            "Unified recent timeline across messages, calls, send-out stage moves, and calendar events. Optionally scope to one person.",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    person_id: { type: "string" },
                    days: { type: "integer", description: "Default 7, max 90." },
                    limit: { type: "integer", description: "Default 30, max 100." },
                  },
                },
              },
            },
          },
          responses: { "200": { description: "Activity feed.", content: { "application/json": { schema: { type: "object" } } } } },
        },
      },
    },
  };

  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "public, max-age=300");
  return res.status(200).json(spec);
}
