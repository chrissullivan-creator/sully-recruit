# Sully Recruit — Git Push Diagnostics Skill

Runbook for diagnosing `git push` failures or hangs from the Claude Code web
environment. Read this first before changing `.git/config`, running
`--force`, or filing an issue about "pushes are broken."

## Environment at a glance

| Thing | Value | Notes |
|---|---|---|
| Remote `origin` | `http://local_proxy@127.0.0.1:54856/git/chrissullivan-creator/sully-recruit` | **Not github.com.** A local proxy on `127.0.0.1:54856` forwards to GitHub. |
| Credential helper | *(none)* | Auth is handled by the proxy; do not add one. |
| Shallow clone | Yes — `.git/shallow` present | Push works, but some history ops may error. |
| CI on push | *(none)* | No `.github/workflows/` exists. Vercel comments on PRs but does not block. |
| Branch protection | *(none visible)* | PRs merge as soon as you click merge. |
| Active hooks | *(none)* | `.git/hooks/*.sample` only, no `.husky/`. |

## First-aid: the 60-second triage

Run these in order when a push misbehaves:

```bash
# 1. Is the proxy alive?
curl -sI http://127.0.0.1:54856/ | head -1

# 2. What's the remote set to?
git remote -v

# 3. Is the local branch diverged from origin?
git fetch origin && git status -sb

# 4. Inspect the last few refs / reflog entries
git reflog -10
```

If step 1 returns nothing or a 5xx, the proxy is down — **do not** change
config. Just retry.

## Retry policy (from the harness)

For `git push`, always use `git push -u origin <branch-name>` and, if it fails
due to a **network error only**, retry up to 4 times with exponential
backoff: **2s, 4s, 8s, 16s**.

Do **not** retry on non-network errors (rejected, permission, shallow-update,
conflict) — those need human judgment.

## Error → action cheat sheet

| Error message contains | Likely cause | First action |
|---|---|---|
| `fatal: unable to access` / `Could not resolve host` / `Connection refused` | Proxy down or flaky | Wait 2s, retry. Up to 4 attempts with exponential backoff. |
| `shallow update not allowed` | Local clone is shallow and you're pushing a commit whose parent isn't in the pack | Run `git fetch --unshallow origin` once, then push again. |
| `! [rejected] ... (non-fast-forward)` | Someone pushed to the branch after you fetched | `git pull --rebase origin <branch>`, resolve conflicts, push again. **Never** `--force` without user approval. |
| `! [rejected] ... (fetch first)` | Same as above | Same fix. |
| `Permission denied` / `403` | Auth broke at the proxy | Do not edit credential config. Surface to the user — probably a harness/session issue. |
| Push hangs > 60s with no output | Proxy silently stalled | Ctrl-C, run the 60-second triage above, then retry. |
| `error: RPC failed; HTTP 408 curl 22` | Proxy timeout mid-upload | Retry. If it fails repeatedly on the same push, the payload may be too large — inspect with `git diff --stat origin/main...HEAD`. |

## Things NOT to do

- **Do not** add a credential helper (`git config credential.helper ...`). The
  proxy handles auth; layering a helper causes double-auth hangs.
- **Do not** change `remote.origin.url` to `https://github.com/...`. The
  harness only whitelists the local proxy.
- **Do not** `git push --force` or `--force-with-lease` without explicit user
  approval, per repo conventions.
- **Do not** `rm .git/shallow`. If the shallow boundary bites you, run
  `git fetch --unshallow origin` which is the safe, reversible way.
- **Do not** skip hooks with `--no-verify`. There are no active hooks here,
  so if a hook *does* fire later, investigate it first.

## Known quirks

- The PR list occasionally shows several PRs "merged N minutes ago" in quick
  succession. That's a burst of independent merges, not a queue / delay —
  verified by inspecting the per-PR `merged_at` timestamps in the GitHub API.
- Stale `claude/*` branches accumulate on origin because the harness doesn't
  auto-delete on merge. They are safe to ignore; clean up periodically with
  user approval.
- `.gitignore` has been corrupted in the past by a bad `echo -e` script
  duplicating the env-file block. If you see `-e` lines on their own, the
  fix is a straight rewrite of that block — no behavior change, just dedupe.

## When to escalate to the user

- Proxy unreachable for more than 4 retries in a row.
- Push rejected for a reason not in the table above.
- Any situation that would require `--force`, destructive ops, or editing
  `.git/config`.
