# Post-launch dashboard specification

Light Link intentionally has no telemetry, so there is no central product dashboard. Monitor only privacy-preserving public/operational signals available without adding in-app tracking:

| Signal | Source | Cadence | Owner action threshold |
|---|---|---|---|
| Installs and uninstalls | Homey publisher dashboard | weekly | investigate sustained abnormal uninstall spike |
| Crash / certification feedback | Homey publisher dashboard | daily during launch | triage every new crash or reviewer blocker |
| Support volume by topic | GitHub issue labels | weekly | document any repeated setup issue after 3 independent reports |
| Compatibility reports | GitHub issue template | weekly | add verified pairing paths to public matrix |
| Review sentiment | App Store reviews | weekly | respond with actionable guidance; never request secrets |
| CI health | GitHub Actions | each change | block releases while required checks fail |

Authentication failures, pairing success and API errors remain local diagnostics only unless a user explicitly shares a redacted report.
