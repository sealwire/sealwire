# Native iOS notifications

The app requests notification permission during pairing or when a session is opened.
It registers its APNs token with the paired relay. The relay sends the same
needs-input, completed and error events as Web Push, applying the same device
and workspace access checks. Tokens survive relay restarts and are removed when
the device is revoked on the relay or APNs reports an invalid token.

APNs alerts contain fixed status text and opaque relay, device and session IDs.
Apple can see this routing metadata, but receives no session names, message text,
workspace paths or provider error details. Repeated alerts for the same relay,
session and event kind share a collapse identifier.

## After joining the Apple Developer Program

The default app build intentionally has no Push Notifications entitlement, so
free Personal Team signing continues to work. Permission requests work now;
APNs registration logs a failure until the capability is enabled.

1. In Xcode, select the App target and the paid team, then add **Push Notifications**
   under Signing & Capabilities. Let Xcode create the entitlement and provisioning
   profile. Debug needs `aps-environment = development`; distribution needs
   `production`. Do not enable this with a free Personal Team.
2. Create an APNs authentication key for `dev.sealwire.mobile` in the Apple
   developer account. Keep the `.p8` file on the relay computer, outside this repo.
3. Set these variables in the relay's launch environment, then restart it:

   ```sh
   export RELAY_APNS_KEY_PATH=/absolute/path/to/AuthKey_KEYID.p8
   export RELAY_APNS_KEY_ID=YOUR_KEY_ID
   export RELAY_APNS_TEAM_ID=YOUR_TEAM_ID
   ```

   The `.p8` is read at startup; missing or invalid credentials disable APNs with
   one log line. No key is sent to the app or broker. The sender uses HTTP/2 with
   rustls and caches an ES256 provider JWT for 45 minutes.

4. Build and reinstall the app with the paid team. Pair it or open a session and
   allow notifications. Verify a needs-input event and a completed turn while the
   app is backgrounded, then while it is closed. Tap each alert to verify that the
   owning relay and session open.

The app reads `aps-environment` from its embedded provisioning profile, so Release
builds installed with development signing still report `development`. App Store
installations without an embedded profile use `production`; simulators use
`development`. An embedded profile without the entitlement refuses registration.
The relay selects Apple's sandbox or production endpoint per token; there is no
separate environment variable.

## Language and duplicate alerts

Notification titles and bodies currently use fixed English status text. Native
localization can use APNs `title-loc-key`, `loc-key` and localization arguments,
with matching `Localizable.strings` in the app's `zh-Hans.lproj` (and other
supported languages). The web UI's `t()` catalog cannot translate a notification
shown while the app is closed.

Registering APNs replaces Web Push for the same paired device identity. A
separately paired Home Screen web app has its own identity and can still receive
another alert; use iOS notification settings to keep only the desired install enabled.

The existing local Forget action clears this app's saved pairing. Revoke the
paired device on the relay to stop server-side notifications for that identity.

## Checks without Apple credentials

`npm test` in `mobile/` checks registration listeners, errors and cold-start tap
retention. Frontend tests cover the native permission/token path without VAPID.
Rust tests verify JWT signatures, HTTP/2 request headers, both Apple endpoints,
payloads, invalid-token pruning and token persistence/revocation.

A simulator push payload needs the app's stored `relay_id`, the relay's paired
`device_id` and the target `thread_id`:

```json
{
  "aps": {"alert": {"title": "Agent finished", "body": "A session completed its turn."}, "sound": "default"},
  "relay_id": "STORED_RELAY_ID",
  "device_id": "PAIRED_DEVICE_ID",
  "thread_id": "SESSION_ID"
}
```

Deliver it with `xcrun simctl push booted dev.sealwire.mobile payload.apns`.
This exercises notification presentation and tapping, not real APNs delivery.
