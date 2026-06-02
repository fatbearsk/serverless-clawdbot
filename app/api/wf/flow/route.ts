// Mirror of the eager-generated flow route at a non-dot-prefix path.
// OpenNext / EdgeOne strip `.well-known/` directories from the deployed
// function bundle, so the original eager route file is missing at runtime.
// Re-exporting it from here causes webpack to inline the handler (plus the
// step registrations + compiled workflow VM code) into THIS route's chunk,
// which lives under `/api/_wf/flow` and survives the deploy untouched.
// Next.js rewrites in next.config.ts map `/.well-known/workflow/v1/flow`
// to this path so the dispatcher's URL doesn't need to change.

export { POST } from "../../../.well-known/workflow/v1/flow/route";
