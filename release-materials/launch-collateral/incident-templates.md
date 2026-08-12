# Incident communication templates

## API-key authentication failure

Light Link cannot currently maintain generated Flows because the saved Personal API Key is invalid or lacks Flow permissions. Existing configured controllers should continue controlling lights. Create a new key with Flow permissions and save it in Light Link settings. Do not send the key to support.

## Homey API / firmware compatibility issue

We are investigating a Homey API change affecting [DISCOVERY / FLOW MAINTENANCE / TARGET WRITES] in Light Link version [VERSION] on firmware [VERSION]. Until resolved, [IMPACT]. Existing mappings [DO / DO NOT] continue to operate. We will update this notice after verification.

## Temporary device-integration compatibility issue

The [SOURCE MODEL] event surface exposed by [OWNING APP / PAIRING PATH] changed in version [VERSION]. Light Link may request repair or no longer discover [EVENTS]. Avoid rebuilding mappings until [GUIDANCE]. Other source types are not known to be affected.

## Recovery notice

The issue affecting [SCOPE] is resolved in Light Link [VERSION] / after [EXTERNAL CHANGE]. Update or restart the app, then test one mapping. If it still fails, copy redacted diagnostics from Light Link settings and attach them to a support report.
