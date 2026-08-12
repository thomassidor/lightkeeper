# Permission rationale

## `homey:manager:api`

Light Link must enumerate source devices, target lights, zones and source-device Flow trigger cards owned by other apps; subscribe to target capability changes; set target-light capabilities; and inspect generated Flows. Homey's broad Web API permission is the only permission that exposes these cross-app resources.

The app's own Web API session cannot create or update Flows. A user-supplied Personal API Key with Flow permissions is therefore used only for Flow writes. It is stored locally in app settings on the user's Homey, never logged, never included in diagnostics and never transmitted off the Homey. If it expires, existing controllers keep controlling lights and only Flow maintenance pauses.

This app declares only the `local` platform because `homey:manager:api` is incompatible with Homey Cloud and the design depends on local cross-app Web API access.
