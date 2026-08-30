# UI refactor review

This refactor moves the administration console to a shared Next.js + ShadCN-style component system.

## Review checklist

- Every protected page uses the shared application shell.
- Navigation, runtime status, authentication checks, spacing, typography, cards, tables, dialogs, inputs, alerts, badges, and empty states are shared components.
- Browser API calls use one explicit base-path-aware helper; global `fetch` and `EventSource` mutation is removed.
- Provider credentials remain masked and provider diagnostics never render upstream HTML.
- VPN profile editing keeps validation errors inside the editor dialog and preserves the one-tunnel rule.
- Cache actions preserve safe background replacement semantics while presenting one manual repull action.
- Logs preserve live SSE streaming, filtering, export, details, auto-scroll, and destructive confirmation.
- Settings contains operational settings and runtime/storage state only; implementation notes are not embedded in the product UI.
- Mobile navigation, light/dark theme, loading, empty, success, warning, and error states are covered by the shared design system.
- Source-contract tests verify the production UI architecture and key safety behavior.
