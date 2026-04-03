# CLAUDE.md — Sully Recruit

## Project Overview

Sully Recruit is a full-stack recruitment/staffing platform for managing candidates, jobs, companies, contacts, campaigns, and communications. It features AI-powered resume parsing, candidate matching, multi-channel outreach campaigns, real-time inbox, and pipeline management.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 18 + TypeScript + Vite |
| Styling | Tailwind CSS 3 + shadcn/ui (Radix primitives) |
| State | React Query (TanStack), React Hook Form + Zod |
| Backend | Python FastAPI + Uvicorn |
| Databases | Supabase (PostgreSQL) + MongoDB (via Motor async driver) |
| Auth | Supabase Auth + Microsoft OAuth |
| AI | Anthropic Claude API (resume parsing, search, matching, email generation) |
| Deployment | Vercel (frontend + serverless functions) |
| Task Queue | Trigger.dev |
| Rich Text | Tiptap editor |

## Repository Structure

```
sully-recruit/
├── frontend/                # React SPA (main application)
│   ├── src/
│   │   ├── pages/           # Route pages (Candidates, Jobs, Inbox, Pipeline, etc.)
│   │   ├── components/
│   │   │   ├── ui/          # shadcn-ui base components
│   │   │   ├── auth/        # Authentication components
│   │   │   ├── layout/      # Navigation, sidebars
│   │   │   ├── shared/      # ResumeDropZone, CallDetailModal, RichTextEditor
│   │   │   ├── candidates/  # Candidate-specific UI
│   │   │   ├── jobs/        # Job management
│   │   │   ├── companies/   # Company management
│   │   │   ├── contacts/    # Contact management
│   │   │   ├── campaigns/   # Campaign sequences
│   │   │   ├── inbox/       # Message inbox
│   │   │   └── pipeline/    # Pipeline visualization
│   │   ├── hooks/           # useData, useTasks, useProfiles, useToast
│   │   ├── contexts/        # AuthContext (Supabase-based)
│   │   ├── integrations/
│   │   │   └── supabase/    # Generated Supabase client + types
│   │   ├── lib/             # Utilities (booleanSearch, geocoding, sendScheduler)
│   │   ├── types/           # TypeScript interfaces (Lead, Job, Candidate, etc.)
│   │   ├── trigger/         # Trigger.dev scheduled tasks
│   │   └── test/            # Test setup
│   ├── supabase/
│   │   ├── migrations/      # Database schema migrations
│   │   └── config.toml      # Supabase local config
│   ├── package.json
│   ├── vite.config.ts
│   ├── tailwind.config.ts
│   ├── tsconfig.app.json
│   └── eslint.config.js
├── backend/                 # Python FastAPI server
│   ├── server.py            # Main API application (~1300 lines)
│   ├── resolve_unipile_bulk.py
│   └── requirements.txt
├── api/                     # Vercel serverless functions
│   └── parse-resume.js      # Resume extraction endpoint
├── vercel.json              # Vercel deployment config
├── trigger.config.ts        # Trigger.dev project config
└── CLAUDE.md                # This file
```

## Development Commands

All frontend commands run from `/frontend`:

```bash
npm run dev              # Start Vite dev server (port 3000)
npm run build            # Production build
npm run build:dev        # Dev mode build
npm run lint             # Run ESLint
npm run preview          # Preview production build
npm run test             # Run Vitest once
npm run test:watch       # Vitest watch mode
npm run trigger:dev      # Start Trigger.dev dev server
npm run trigger:deploy   # Deploy Trigger.dev tasks
```

Backend (from `/backend`):
```bash
pip install -r requirements.txt
uvicorn server:app --reload
```

## Architecture & Key Patterns

### Frontend

- **Component organization**: Domain-based folders under `src/components/` (candidates/, jobs/, etc.). Shared UI primitives live in `components/ui/`.
- **Data fetching**: React Query (`useQuery`/`useMutation`) for all server state. Custom hooks in `src/hooks/useData.ts` handle paginated batch fetching (5000+ records).
- **Forms**: React Hook Form with Zod schema validation.
- **Real-time**: Supabase channel subscriptions for live updates.
- **Routing**: React Router DOM v6. Route-level auth via `ProtectedRoute` wrapper.
- **Notifications**: Sonner toast library.
- **Path alias**: `@/` maps to `src/` (configured in tsconfig and vite).

### Backend

- **API structure**: Single `server.py` file with FastAPI `APIRouter` under `/api/` prefix.
- **Async operations**: All MongoDB operations use Motor async driver. FastAPI endpoints are async.
- **Streaming**: Long-running AI operations (resume search, candidate matching) use `StreamingResponse`.
- **Auth**: JWT validation for Supabase tokens. Service role key for admin operations.

### AI Integration (Claude API)

Claude is used for several core features:
- **Resume parsing** (`/api/parse-resume`): Extracts structured data from uploaded resumes via Vercel serverless function.
- **Resume search** (`/api/resume-search-ai`): Multi-turn conversational search across candidates with streaming.
- **Candidate matching** (`/api/match-candidates-to-job`): Scores candidates against job requirements.
- **Sequence generation** (`/api/write-sequence-step`): Generates campaign outreach emails.
- **Email generation** (`/api/generate-sendout-email`): Creates sendout emails.
- **Unified search** (`/api/unified-search`): Natural language search across all entities.

### External Integrations

- **Microsoft Graph**: Calendar sync, Outlook email integration.
- **Unipile**: LinkedIn profile data and messaging.
- **RingCentral**: Call recording webhooks and transcripts.
- **Supabase Storage**: Resume file hosting.
- **Trigger.dev**: Async task scheduling (resume ingestion, deduplication, data sync).

## Data Models

Key types are defined in `frontend/src/types/index.ts`:

- **Candidate**: 13-stage pipeline (`back_of_resume` → `accepted`/`declined`)
- **Job**: Pipeline stages (`lead`, `hot`, `offer_made`, `closed_won`, `lost`)
- **Company**: Target vs. Client status tracking
- **Contact**: Hiring managers, recruiters, with communication history
- **Campaign**: Multi-step outreach sequences with delay scheduling
- **Communication**: Unified model for email, LinkedIn, SMS, calls, notes

## Code Conventions

- **TypeScript**: Non-strict mode (`strict: false`, `noImplicitAny: false`). Path alias `@/` for imports.
- **Naming**: `camelCase` for variables/functions, `PascalCase` for components and types.
- **Components**: One component per file, organized by domain. Prefer shadcn/ui primitives for UI elements.
- **Styling**: Tailwind utility classes. Custom design tokens defined as CSS variables in `index.css` (HSL-based). Color palette: dark forest green (primary), cream (background), burnished gold (accent).
- **Error handling**: Toast notifications via Sonner for user-facing errors.
- **Imports**: Use `@/` path alias (e.g., `import { Button } from "@/components/ui/button"`).

## Testing

- **Frontend**: Vitest + @testing-library/react with jsdom environment. Config in `vitest.config.ts`, setup in `src/test/setup.ts`.
- **Backend**: Pytest (minimal test suite currently).
- **Test files**: Follow `*.test.ts` or `*.spec.ts` naming pattern.

## Environment Variables

Frontend vars use `VITE_` prefix. Key variables:

| Variable | Purpose |
|----------|---------|
| `VITE_SUPABASE_URL` | Supabase project URL |
| `VITE_SUPABASE_ANON_KEY` | Supabase anonymous/public key |
| `SUPABASE_URL` | Backend Supabase URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Backend admin key |
| `ANTHROPIC_API_KEY` | Claude API key |
| `MONGO_URL` | MongoDB connection string |
| `UNIPILE_API_KEY` | LinkedIn integration |
| `RINGCENTRAL_*` | Call recording integration |

## Key Files Reference

| File | Purpose |
|------|---------|
| `frontend/src/contexts/AuthContext.tsx` | Authentication provider & session management |
| `frontend/src/hooks/useData.ts` | Core data fetching hook with pagination |
| `frontend/src/types/index.ts` | All TypeScript interfaces and data models |
| `frontend/src/integrations/supabase/client.ts` | Supabase client initialization |
| `frontend/src/integrations/supabase/types.ts` | Auto-generated Supabase types |
| `backend/server.py` | All backend API endpoints |
| `api/parse-resume.js` | Vercel serverless resume parser |
| `frontend/src/components/ui/` | shadcn-ui component library |
| `frontend/tailwind.config.ts` | Design system tokens & custom colors |
| `vercel.json` | Deployment routing & rewrites |

## Guidelines for AI Assistants

1. **Read before editing**: Always read a file before modifying it. Understand the existing patterns.
2. **Follow domain organization**: Place new components in the appropriate domain folder under `components/`.
3. **Use existing UI primitives**: Prefer shadcn/ui components from `components/ui/` over custom implementations.
4. **Use the path alias**: Import with `@/` prefix, not relative paths.
5. **Respect the data layer**: Use React Query hooks for data fetching. Don't bypass the Supabase client.
6. **Don't tighten TypeScript**: The project intentionally uses non-strict TypeScript. Don't add strict type annotations where they aren't already used.
7. **Tailwind for styling**: Use Tailwind utility classes. Reference existing CSS variables for colors.
8. **Toast for errors**: Use Sonner toast for user-facing notifications.
9. **Backend is a single file**: All API routes live in `backend/server.py`. Add new endpoints there.
10. **Test with Vitest**: Write frontend tests using Vitest + Testing Library patterns.
