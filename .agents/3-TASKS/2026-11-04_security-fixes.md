# Security Fixes Task List
**Date:** 2026-11-04  
**Source:** Security audit of weather-pontianak Cloudflare Worker

## Tasks

| ID | Title | Description | Priority | Status | Dependencies | Files |
|----|-------|-------------|----------|--------|--------------|-------|
| T-01 | Add fetch timeout to _fetchJson | Add AbortController with 10s timeout to all external API calls | High | Done | - | src/index.js |
| T-02 | Add rate limiting on /run endpoint | Implement KV-based rate limit (10 req/min per IP) | Medium | Done | - | src/index.js |
| T-03 | RAIN_THRESHOLD as var | Keep in [vars] (not secret) for easy tweaking | Low | Done | - | wrangler.toml, .dev.vars.example |
| T-04 | Test all fixes locally | Verify timeout, rate limit, and auth work in wrangler dev | High | Done | T-01, T-02, T-03 | - |
| T-05 | Deploy to production | Deploy with secrets and verify | High | Done | T-04 | - |

## Summary
- **Total tasks:** 5
- **Done:** 5
- **Blocked:** 0

## Notes
- All fixes implemented and tested locally
- RAIN_THRESHOLD kept as var (easier to tweak, no security impact)
- Deploy was blocked by API token permission (needs Workers Scripts:Edit); fixed via `wrangler login`
- 2026-11-24: deployed to production and verified (`/run` returns 200, secrets set)