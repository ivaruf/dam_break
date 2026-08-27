# Dam Break — Android wrapper (Trusted Web Activity)

A thin Play Store shell around https://ivaruf.github.io/dam_break/. The game
itself stays on GitHub Pages: pushing to Pages ships game updates through the
service worker's UPDATE READY flow with **no Play release**. A Play release is
only needed when this wrapper changes (icon, colors, versionCode, the yearly
Android targetSdk bump).

`twa-manifest.json` is the only source file here — the whole Gradle project is
generated from it (and is gitignored). Package id: `io.github.ivaruf.dambreak`
(must match the Play Console entry exactly; it is permanent).

## Rebuild

```
bubblewrap update --skipVersionUpgrade   # regenerate the project from twa-manifest.json
bubblewrap build --skipSigning           # unsigned trial build
```

Toolchain lives in `~/.bubblewrap` (its own JDK 17 + Android SDK); check with
`bubblewrap doctor`.

## Signing (owner does this, not the agent)

1. Create the upload keystore ONCE, with your own passwords, at
   `android/android.keystore` (already gitignored — never commit it, and back
   it up outside the repo):

   ```
   ~/.bubblewrap/jdk/jdk-17.0.11+9/Contents/Home/bin/keytool \
     -genkeypair -v -keystore android.keystore -alias android \
     -keyalg RSA -keysize 2048 -validity 20000
   ```

2. Signed build (env vars keep the prompts out of the way):

   ```
   BUBBLEWRAP_KEYSTORE_PASSWORD=... BUBBLEWRAP_KEY_PASSWORD=... bubblewrap build
   ```

   Outputs: `app-release-signed.apk` (local install/testing) and
   `app-release-bundle.aab` (what Play wants).

## Digital Asset Links (fullscreen verification)

Without this the app opens with a browser URL bar. The file must live at the
ORIGIN ROOT — for a GitHub project page that means the `ivaruf.github.io`
user-site repo, not this repo:

    https://ivaruf.github.io/.well-known/assetlinks.json

```json
[{
  "relation": ["delegate_permission/common.handle_all_urls"],
  "target": {
    "namespace": "android_app",
    "package_name": "io.github.ivaruf.dambreak",
    "sha256_cert_fingerprints": [
      "UPLOAD_KEY_SHA256_HERE",
      "PLAY_APP_SIGNING_SHA256_HERE"
    ]
  }
}]
```

- Upload key fingerprint: `bubblewrap fingerprint` (or keytool -list).
- Play App Signing fingerprint: Play Console → Test and release → Setup →
  App integrity → App signing key certificate (exists only after the first
  AAB upload). BOTH belong in the file: Play re-signs what users download,
  the upload key covers local installs.

## Version bumps

Play needs a strictly increasing `appVersionCode`. Convention: keep
`appVersion` equal to the game's sw.js VERSION at wrap time and bump
`appVersionCode` by 1 per Play release, in twa-manifest.json. (The JSON key
really is `appVersion`, not `appVersionName` — the latter is silently ignored
and yields versionName "".)
