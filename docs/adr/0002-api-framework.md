# ADR-0002: API framework

Status: Accepted

## Context

`apps/api` exposes the control plane at `/api/v1` to the web app, the Python media worker (stage
result callbacks), and eventually customers. Requirements: schema-first request/response
validation shared with the front end, generated OpenAPI for Python and external clients,
first-class SSE, low overhead per request (99.9% availability with modest Fargate task counts),
TypeScript strict, easy to test in-process.

Options: Fastify with `fastify-type-provider-zod` and `@fastify/swagger`; NestJS; Express with
manual validation; tRPC; Hono.

## Decision

Fastify 5 with Zod type provider. Route schemas are defined once as Zod objects in
`packages/contracts`, attached to routes for validation and serialization, and emitted as OpenAPI
3.1 at `/api/v1/openapi.json`. The same Zod schemas are exported to JSON Schema for
`services/media-worker`, which generates pydantic models from them. SSE is served through a small
plugin over Fastify's raw reply stream. Errors use a single envelope
`{ error: { code, message, details?, requestId } }` mapped from `packages/domain` typed errors.

## Consequences

- Positive: one source of truth for contracts across TS and Python; fastest of the mainstream
  Node frameworks; plugin encapsulation makes tenant scoping and auth composable; `inject()`
  allows route tests without a socket.
- Negative: less opinionated structure than NestJS, so application services and repositories
  follow a documented layout (`architecture.md` §3) and lint rules enforce that routes never touch
  the database directly. OpenAPI from Zod needs care for discriminated unions and `bigint`
  (microsecond fields are serialized as strings in JSON and validated by a `usString` schema).
- Rejected NestJS (DI and decorators add weight without buying anything the plugin model does not),
  tRPC (no OpenAPI for Python and external clients), Express (no schema integration), Hono (SSE and
  plugin ecosystem less mature for our needs at time of decision).
