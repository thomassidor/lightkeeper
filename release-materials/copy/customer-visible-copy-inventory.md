# Customer-visible copy inventory

| Surface | Source | English | Danish | Status |
|---|---|---:|---:|---|
| Manifest name, tagline, tags | `.homeycompose/app.json` | yes | yes | complete |
| App Store long description | `README.txt`, `README.da.txt` | yes | yes | complete |
| Release notes | `.homeychangelog.json` | yes | yes | complete |
| Driver name | `drivers/controller/driver.compose.json` | yes | yes | complete |
| Pairing credential, source, targets, mapping | `locales/*.json`, driver pair HTML | yes | yes | copy keys complete; long-string visual QA required |
| Device state messages | `locales/*.json` | yes | yes | complete |
| App settings and diagnostics | `locales/*.json`, settings HTML | yes | yes | complete; raw runtime detail remains diagnostic-only |
| Flow card title, formatted title, hints and arguments | `.homeycompose/flow/actions/*.json` | yes | yes | complete |
| Widgets | none | n/a | n/a | not applicable |
| Public support content | release draft | English | fallback | Publish English at launch; Danish falls back clearly to English |

[OWNER ACTION] Perform the final English and Danish native-language review on real Homey surfaces. Run a long-string/truncation pass. Arabic RTL is not in launch scope.
