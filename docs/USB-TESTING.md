# USB testing runbook (first real user, no demo)

Phone: USB debugging ON, cable connected, RSA prompt accepted.
PC: Android Platform-Tools (`adb`) installed.

## 1. Verify connection

```sh
adb devices
# must show:  <serial>   device
```

If `unauthorized`: unplug, revoke USB authorizations on the phone, replug, accept.

## 2. Install the 3 APKs

```sh
./scripts/install-apks.sh
```

APKs come from `v1.0.9` (`releases/latest/download/hudumika-{consumer,provider,rider}.apk`).
Merchant APK: build locally (`cd merchant/app && eas build --local --profile preview`), then
`adb install -r hudumika-merchant.apk`.

## 3. First-run test flow (uses LIVE Railway backend)

1. Open **consumer** app → enter a real Tanzanian phone → Send code.
2. You will NOT get an SMS yet (TextBee device not linked) — for now reply with
   what you see (stuck on splash? error text?) and we fix from there.
3. Same for **provider** and **rider** apps.

## 4. If the consumer app crashes on launch

```sh
./scripts/install-apks.sh --logs
```

Reproduce the crash on the phone, copy the `FATAL` / `AndroidRuntime` stack
and paste it back — it tells us exactly which native module failed
(suspects from code review: `app.json:10 newArchEnabled`, worklets/reanimated,
`google-services.json` stub).
