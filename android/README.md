# DSB Mobile

Android companion for [deepseek-bridge](https://github.com/sarimmohib/deepseek-bridge).
It reaches the bridge over LAN or Tailscale, shows the account pool, and adds fresh
DeepSeek logins by loading the **official** `chat.deepseek.com` sign-in page in a
WebView. Captchas and verification codes stay on DeepSeek's own page, and the app
only reads the resulting `userToken` + `ds_session_id` when you tap REGISTER.

The APK is attached to every [GitHub release](https://github.com/sarimmohib/deepseek-bridge/releases)
as `app-debug.apk`. Sideload it with `adb install -r app-debug.apk`.

## Screens

| Screen | What it does |
| --- | --- |
| Connect | Endpoint + API key (or `/bridge` proxy), reachability plate, recent servers, manual token paste |
| Console | Warning strip, account signal spine, version/mode/queue/context, add account, health check, latest events |
| Pool | Every login with READY / COOLING / EXPIRED, test, relogin/replace, remove |
| Official login | WebView on `chat.deepseek.com/sign_in`; floating REGISTER button arms when a session token appears |
| Vault | Saved logins, export/import JSON, share sheet, push all to the bridge |
| Setup | Server details, API-key copy, dashboard link, terminal login command, local data controls |

## Server modes

Both shapes work, and the app detects them from the URL path:

- **Direct** — `http://host:8787` (or `http://100.x.y.z:8787`). The app sends
  `Authorization: Bearer <key>`. The bridge must be reachable on that address
  (`config.host` set to `0.0.0.0` or a Tailscale IP).
- **Proxy** — `http://host/bridge` (the remote dashboard proxy on port 80 / 49900).
  No key is stored on the phone; the proxy injects it. Tailnet-only unless the
  proxy allowlist is widened.

Cleartext HTTP is allowed because self-hosted bridges are usually plain HTTP on a
private network. The API is still authenticated and every token is stored
encrypted on the device.

## Build

The project includes a Gradle wrapper. From this directory:

```cmd
set JAVA_HOME=C:\Program Files\Eclipse Adoptium\jdk-21.0.12.101-hotspot
gradlew.bat :app:assembleDebug
```

Output: `app\build\outputs\apk\debug\app-debug.apk`.

Linux/macOS:

```bash
JAVA_HOME=/path/to/jdk ./gradlew :app:assembleDebug
```

GitHub Actions builds the same APK on every published release and uploads it to
the release assets.

## Test on WSA

```cmd
adb connect 127.0.0.1:58526
adb reverse tcp:8787 tcp:8787          # WSA reaches the host bridge on 127.0.0.1:8787
adb install -r app\build\outputs\apk\debug\app-debug.apk
adb shell am start -n dev.sarim.dsbmobile/.MainActivity ^
  --es dsb_server http://127.0.0.1:8787 ^
  --es dsb_key sk-ds-...
```

The `dsb_server` / `dsb_key` extras are honoured by **debug builds only** so a test
run can skip typing. In release, configure the server on the Connect screen.

## Security

- Server API keys, DeepSeek user tokens and cookies live in one AES-256-GCM blob
  whose key is generated in the Android Keystore and never leaves it.
- Backups are plaintext JSON by design (so another DSB can import them); delete
  them after use.
- Removal from a pool never deletes the vault copy.
- The app never types into DeepSeek's login form — it only reads
  `localStorage.userToken` after the official page has authenticated.
