// Static re-exports so a bundler keeps tree-shaking @sentry/node while sentry.ts requires this file lazily.
export {
  captureException,
  captureMessage,
  dedupeIntegration,
  eventFiltersIntegration,
  functionToStringIntegration,
  init,
  linkedErrorsIntegration,
  onUncaughtExceptionIntegration,
  onUnhandledRejectionIntegration,
} from "@sentry/node";
