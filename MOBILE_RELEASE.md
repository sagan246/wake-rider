# Wake Rider Lab mobile release

The iPhone and Android editions use Capacitor 8 and bundle the 2D game locally. They do not load `boat.saganweb.com` inside the app, so gameplay is offline and the store build does not depend on the tunnel or a server.

## Identity to confirm before the first store record

- App name: `Wake Rider Lab`
- Bundle/Application ID: `com.saganweb.wakeriderlab`
- Version: `1.0.0` / build 1

The ID is based on `saganweb.com`. Change it in `capacitor.config.json` before creating either store listing if that domain or identifier should not be used. Changing it after release creates a different app.

## Shared workflow

Capacitor 8 requires Node.js 22 or newer.

```powershell
pnpm install --frozen-lockfile
pnpm run check
pnpm run native:sync
pnpm run native:assets
```

Run `pnpm run native:sync` after every web-game change. Run `pnpm run native:assets` again only when `resources/icon.png` changes.

The `www` directory is generated and ignored. The `ios` and `android` projects are source code and should be committed.

## Android on Windows or macOS

Install Android Studio 2025.2.1 or newer and an Android SDK. Capacitor 8's generated project targets Android API 36. Then:

```powershell
pnpm run android:sync
pnpm run android:open
```

Use Android Studio to test a debug build on at least one phone and one tablet. For Google Play, create an upload key, keep it outside the repository, configure release signing, and produce a signed Android App Bundle (`.aab`). New Play apps use Play App Signing.

If the Play Console account is a personal account created after November 13, 2023, plan for Google's [production-access test](https://support.google.com/googleplay/android-developer/answer/14151465): at least 12 opted-in testers for 14 continuous days before applying for production access.

The command `pnpm run android:debug` builds a debug APK once the JDK and Android SDK are installed. `pnpm run android:bundle` invokes the release-bundle task but cannot produce a publishable signed bundle until signing is configured.

## iPhone on a Mac

The web game and most shared app work can be done on Windows. Final iOS compilation, signing, simulator/device testing, archiving, and App Store upload require macOS with Xcode. It can be any compatible Mac, not specifically a MacBook.

On that Mac, install Xcode 26 or newer and its command-line tools, then run:

```bash
pnpm install --frozen-lockfile
pnpm run ios:sync
pnpm run native:assets
pnpm run ios:open
```

In Xcode, select the App target, choose the Apple Developer team, confirm the bundle ID and version, test on real iPhones, then use Product > Archive and distribute to App Store Connect/TestFlight. Apple Developer Program membership is required for public distribution. The project targets iPhone only; enable iPad deliberately after tablet layout QA if a universal release is wanted.

## Store checklist

- Confirm the generated icon on light/dark home screens and the launch screen on real devices.
- Take current phone and tablet screenshots from the native build.
- Publish `privacy.html` and `support.html` at stable HTTPS URLs and use those URLs in both store records.
- Declare no data collected only while the shipped code remains free of analytics, ads, accounts, and network data collection.
- Complete age-rating/content questionnaires and store descriptions.
- Test touch controls, dialogs, rotation, app background/resume, thermal behavior, and battery use for at least 15–30 minutes on older hardware.
- Keep signing keys, certificates, profiles, and store credentials out of Git.
- Keep the included `Wake Boat 22` profile fictional and generic; review any future branded boats before adding them to a store release.
- Keep the existing simulation/safety disclaimer. If the experimental Three.js renderer is restored to a store build, include its bundled MIT notice in the release acknowledgements.
