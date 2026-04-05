#!/usr/bin/env python3
"""
resolve_unipile_bulk.py

Bulk-resolve Unipile IDs for candidates who have a linkedin_url but no unipile_id.
Calls the resolve-unipile-id Supabase edge function at up to 3 concurrent requests/sec.
Automatically skips already-resolved candidates (resume-safe).

Usage:
    python resolve_unipile_bulk.py [--dry-run] [--limit N] [--batch-size N]

Requires .env with:
    SUPABASE_URL=https://xlobevmhzimxjtpiontf.supabase.co
    SUPABASE_SERVICE_ROLE_KEY=eyJ...
"""

import asyncio
import os
import re
import sys
import time
from pathlib import Path

import httpx
from dotenv import load_dotenv

# Load .env from project root or backend dir
for env_path in [Path(__file__).parent / ".env", Path(__file__).parent.parent / ".env"]:
    if env_path.exists():
        load_dotenv(env_path)
        break

SUPABASE_URL = os.environ.get("SUPABASE_URL", "")
SUPABASE_SERVICE_ROLE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")

if not SUPABASE_URL or not SUPABASE_SERVICE_ROLE_KEY:
    print("ERROR: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in .env")
    sys.exit(1)

HEADERS = {
    "apikey": SUPABASE_SERVICE_ROLE_KEY,
    "Authorization": f"Bearer {SUPABASE_SERVICE_ROLE_KEY}",
    "Content-Type": "application/json",
}

# Rate limiter: 3 concurrent requests/sec
CONCURRENCY = 3
semaphore = asyncio.Semaphore(CONCURRENCY)


def extract_linkedin_slug(url: str) -> str | None:
    """Extract the LinkedIn public identifier slug from a URL."""
    if not url:
        return None
    # Handle various URL formats
    url = url.strip().rstrip("/")
    # https://www.linkedin.com/in/john-doe-123abc
    # https://linkedin.com/in/john-doe-123abc?utm_source=...
    match = re.search(r"linkedin\.com/in/([^/?#]+)", url)
    if match:
        return match.group(1)
    return None


async def fetch_candidates_to_resolve(client: httpx.AsyncClient, limit: int = 0) -> list[dict]:
    """Fetch candidates where unipile_id IS NULL AND linkedin_url IS NOT NULL."""
    url = f"{SUPABASE_URL}/rest/v1/candidates"
    params = {
        "select": "id,linkedin_url,first_name,last_name",
        "unipile_id": "is.null",
        "linkedin_url": "not.is.null",
        "order": "created_at.desc",
    }
    if limit > 0:
        params["limit"] = str(limit)
    else:
        params["limit"] = "10000"

    resp = await client.get(url, params=params, headers=HEADERS)
    resp.raise_for_status()
    return resp.json()


async def resolve_one(
    client: httpx.AsyncClient,
    candidate: dict,
    dry_run: bool = False,
) -> dict:
    """Resolve a single candidate's Unipile ID via the edge function."""
    cid = candidate["id"]
    slug = extract_linkedin_slug(candidate["linkedin_url"])
    name = f"{candidate.get('first_name', '')} {candidate.get('last_name', '')}".strip()

    if not slug:
        return {"id": cid, "name": name, "status": "skip_no_slug", "slug": None}

    if dry_run:
        return {"id": cid, "name": name, "status": "dry_run", "slug": slug}

    async with semaphore:
        try:
            resp = await client.post(
                f"{SUPABASE_URL}/functions/v1/resolve-unipile-id",
                headers=HEADERS,
                json={"linkedin_slug": slug},
                timeout=30.0,
            )

            if resp.status_code != 200:
                return {"id": cid, "name": name, "status": f"error_{resp.status_code}", "slug": slug, "error": resp.text[:200]}

            data = resp.json()
            unipile_id = data.get("unipile_id")
            provider_id = data.get("provider_id")

            if not unipile_id:
                # Mark as failed so we don't retry endlessly
                await client.patch(
                    f"{SUPABASE_URL}/rest/v1/candidates",
                    params={"id": f"eq.{cid}"},
                    headers={**HEADERS, "Prefer": "return=minimal"},
                    json={"unipile_resolve_status": "not_found"},
                )
                return {"id": cid, "name": name, "status": "not_found", "slug": slug}

            # Update candidate with resolved IDs
            await client.patch(
                f"{SUPABASE_URL}/rest/v1/candidates",
                params={"id": f"eq.{cid}"},
                headers={**HEADERS, "Prefer": "return=minimal"},
                json={
                    "unipile_id": unipile_id,
                    "unipile_provider_id": provider_id,
                    "unipile_resolve_status": "resolved",
                },
            )
            return {"id": cid, "name": name, "status": "resolved", "slug": slug, "unipile_id": unipile_id}

        except httpx.TimeoutException:
            return {"id": cid, "name": name, "status": "timeout", "slug": slug}
        except Exception as e:
            return {"id": cid, "name": name, "status": "exception", "slug": slug, "error": str(e)[:200]}
        finally:
            # Rate limit: ~3 req/sec across all concurrent tasks
            await asyncio.sleep(1.0 / CONCURRENCY)


async def main():
    import argparse

    parser = argparse.ArgumentParser(description="Bulk resolve Unipile IDs for candidates")
    parser.add_argument("--dry-run", action="store_true", help="Preview without making changes")
    parser.add_argument("--limit", type=int, default=0, help="Max candidates to process (0=all)")
    parser.add_argument("--batch-size", type=int, default=50, help="Process in batches of N")
    args = parser.parse_args()

    print(f"Connecting to {SUPABASE_URL}...")

    async with httpx.AsyncClient() as client:
        candidates = await fetch_candidates_to_resolve(client, limit=args.limit)
        total = len(candidates)
        print(f"Found {total} candidates needing Unipile resolution")

        if total == 0:
            print("Nothing to do.")
            return

        if args.dry_run:
            print("[DRY RUN] Would resolve:")
            for c in candidates[:20]:
                slug = extract_linkedin_slug(c["linkedin_url"])
                name = f"{c.get('first_name', '')} {c.get('last_name', '')}".strip()
                print(f"  {name}: {slug}")
            if total > 20:
                print(f"  ... and {total - 20} more")
            return

        resolved = 0
        failed = 0
        skipped = 0
        start = time.time()

        for i in range(0, total, args.batch_size):
            batch = candidates[i : i + args.batch_size]
            tasks = [resolve_one(client, c) for c in batch]
            results = await asyncio.gather(*tasks)

            for r in results:
                if r["status"] == "resolved":
                    resolved += 1
                    print(f"  ✓ {r['name']} → {r.get('unipile_id', '?')}")
                elif r["status"] == "skip_no_slug":
                    skipped += 1
                elif r["status"] == "not_found":
                    failed += 1
                    print(f"  ✗ {r['name']} — not found on Unipile ({r['slug']})")
                else:
                    failed += 1
                    print(f"  ✗ {r['name']} — {r['status']}: {r.get('error', '')[:100]}")

            elapsed = time.time() - start
            processed = i + len(batch)
            rate = processed / elapsed if elapsed > 0 else 0
            print(f"  [{processed}/{total}] {resolved} resolved, {failed} failed, {skipped} skipped ({rate:.1f}/sec)")

        elapsed = time.time() - start
        print(f"\nDone in {elapsed:.1f}s — {resolved} resolved, {failed} failed, {skipped} skipped")


if __name__ == "__main__":
    asyncio.run(main())
