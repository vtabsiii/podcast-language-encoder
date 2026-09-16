# ADR-0001: Web hosting for apps/web

Status: Accepted (scaffold phase; revisit after M2)

## Context

`apps/web` is a Next.js App Router application with server components, route handlers that proxy
SSE from the API, and authenticated pages. Options considered:

1. AWS Amplify Hosting (managed Next.js SSR).
2. Static export to S3 + CloudFront with all data fetched client-side.
3. CloudFront + S3 for static assets, Next.js `standalone` output running on ECS Fargate for SSR
   and route handlers, behind the same ALB as `apps/api`.

Constraints: everything else is CDK in one account; SSE streams from the processing view can be
long-lived; the review studio needs signed CloudFront URLs for media; the team already operates
Fargate for the API; local development must mirror production behaviour.

## Decision

Option 3: CloudFront in front of S3 (immutable `_next/static` and public assets) and an ECS
Fargate service running the Next.js standalone server for everything else. CloudFront behaviours:
`/_next/static/*` and `/assets/*` → S3 origin (long cache); `/api/*` → API ALB; default → web
Fargate origin (no cache except explicit `Cache-Control`). Media is served from the derived and
deliverables buckets via CloudFront signed URLs on a separate distribution behaviour.

## Consequences

- Positive: one deployment mechanism (CDK, same pipeline as the API); SSE and long requests are
  not subject to Amplify's function timeouts; the web tier sits in the VPC and can call the API
  privately; no vendor-specific build settings; local `next start` matches production.
- Negative: we operate two Fargate services instead of a managed platform; image builds are slower
  than Amplify's; no built-in preview environments (branch previews will be per-PR CDK stacks or
  skipped). Cold scale-out is slower than Lambda-based hosting.
- Rejected option 1 because SSE proxying and VPC access are awkward and it splits deployment
  tooling. Rejected option 2 because server components and auth redirects would be lost and the
  client would have to hold tokens for every media request.
- Assumption A-05 records this; if Fargate operational cost proves excessive, the fallback is
  option 1 with SSE moved to a direct API origin.
