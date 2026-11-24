# WhaleChat

English | [简体中文](README.zh-CN.md)

An unofficial **Android chat client** built on top of [`deepseek-ai/chat-demo`](https://github.com/deepseek-ai/chat-demo) with Capacitor 8 (while retaining the upstream static Web build). No application backend is required: the client connects directly to the configured DeepSeek-compatible API using your personal API key.

> **Disclaimer & Non-Affiliation**: This repository is an independent Android adaptation and extension based on upstream [`deepseek-ai/chat-demo`](https://github.com/deepseek-ai/chat-demo). It is **not** affiliated with, endorsed by, or officially provided by DeepSeek, and makes **no ownership claim** over `deepseek-ai/chat-demo`, the DeepSeek name/API, or upstream code. The upstream copyright notice (`Copyright (c) 2026 DeepSeek`) and [MIT License](LICENSE) are preserved intact.

> **Status note**: Automated Node/browser regressions and emulator checks have been run, while physical-device performance, TalkBack screen-reader walkthroughs, real-device audio routing, and live paid document re-parsing flows remain to be verified on target hardware.

## Features

### Android adaptation (built on `deepseek-ai/chat-demo`)

- **Capacitor 8 Android shell**: Targets Android 7.0+ (`minSdk 24`, `compileSdk 36`, `targetSdk 36`, application ID `com.g64_cmd.whalechat`, WebView origin `https://localhost`).
- **Keystore-backed API key encryption**: Encrypts the API key with an Android Keystore AES-256-GCM key (`SecureStoragePlugin`) and stores ciphertext + IV in private `SharedPreferences`.
- **Native mobile behaviors**: System back-button priority stack (modals → sidebar/search → double-back exit), external link delegation to the system browser, cache-backed file export/share (`@capacitor/filesystem` + `@capacitor/share`) with startup cleanup, and keyboard/drawer viewport adaptation.

### Extensions added on top of `deepseek-ai/chat-demo`

- **Model & thinking effort controls**: Switch between `DeepSeek Flash` (`deepseek-flash`) and `DeepSeek V4 Pro` (`deepseek-v4-pro`), and configure thinking effort (`low` / `high` / `max`).
- **Title & full-branch body search**: Filter conversation titles or run cancellable batch scans across user and assistant messages in all branches, jumping directly to matching messages even on unselected branches.
- **Attachments & billing safeguards**: Choose document parsing mode (text-only vs. rich layout), confirm per-page parsing billing upfront, guard against the 20-document request limit, retry or explicitly omit unavailable historical attachments, and inspect raster images in an in-app fullscreen zoomable viewer.
- **On-demand rich rendering**: Viewport-gated rendering for Prism code highlighting, KaTeX math, and Mermaid diagrams to keep long conversations responsive.
- **Account & full backup**: Real-time balance lookup (`GET /user/balance`), local token/search usage aggregation with off-peak/peak cost estimates, and full app backup/restore (`v4`) alongside upstream-compatible history export (`v3`).
- **Drafts & accessibility**: Unsent draft text persistence (`chat-demo:draft-texts`), unified modal focus stack, and `prefers-reduced-motion` adaptation.

### Inherited core from `deepseek-ai/chat-demo`

- Multi-conversation message trees & branch switching; SSE streaming replies, deep thinking, smart web search, link reading, source citations, and stop/continue generation.
- Attachment upload/paste/drag-and-drop, voice input with live mobile audio spectrum (`POST /v1/tools/asr`), and streaming PCM read-aloud (`POST /v1/tools/tts`).
- Markdown, syntax highlighting (Prism), KaTeX math, Mermaid diagrams, Simplified Chinese / English UI, light/dark/system themes, location settings, and static Web bundle output (`dist/`).

## Getting started

### Prerequisites

- **Node.js 22.12+** and **pnpm**
- For Android builds: **Android SDK** and **JDK 21** (Capacitor 8 / Gradle 8.14.3 / AGP 8.13.0; if your system default JDK is newer than 21, pin JDK 21 via `org.gradle.java.home` in `~/.gradle/gradle.properties`)

```sh
git clone https://github.com/g64-cmd/deepseek_app.git
cd deepseek_app
pnpm install
```

### Build & install Android APK

**Debug APK**:

```sh
# Windows
pnpm apk:debug
pnpm apk:install

# macOS / Linux
pnpm build:android && cd android && ./gradlew assembleDebug
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
```

**Release APK** (set `NODE_ENV=production` so Rspack emits a minified production Web bundle without source maps):

```powershell
# Windows (PowerShell)
$env:NODE_ENV = 'production'
pnpm apk:release
```

```sh
# macOS / Linux
NODE_ENV=production pnpm build:android && cd android && ./gradlew assembleRelease
```

To produce a signed, installable `android/app/build/outputs/apk/release/app-release.apk` without committing secrets, either create a local gitignored `android/keystore.properties`:

```properties
storeFile=your-release.jks
storePassword=...
keyAlias=...
keyPassword=...
```

or set `RELEASE_STORE_FILE`, `RELEASE_STORE_PASSWORD`, `RELEASE_KEY_ALIAS`, and `RELEASE_KEY_PASSWORD` in your environment. Without signing credentials, Gradle outputs an unsigned `app-release-unsigned.apk`. Install a signed release APK with:

```sh
adb install -r android/app/build/outputs/apk/release/app-release.apk
```

Enter your DeepSeek API key in **Settings** before your first chat.

### Run or build the Web version

```sh
pnpm dev
```

Open http://localhost:8090. To build the static Web bundle into `dist/`:

```sh
# macOS / Linux (on PowerShell: $env:NODE_ENV = 'production'; pnpm build)
NODE_ENV=production pnpm build
```

Deploy `dist/` to a static web server or open `dist/index.html` directly (opening via `file://` requires browser storage support on local files and an API service that permits their cross-origin requests).

## Data, permissions, and storage

- **Android permissions**: `INTERNET` (API requests), plus `RECORD_AUDIO` and `MODIFY_AUDIO_SETTINGS` (runtime microphone permission requested only when using voice input).
- **Local storage**: On Android, your API key is encrypted via Android Keystore (`SecureStoragePlugin`); other settings and unsent draft text (`chat-demo:draft-texts`) are stored in WebView `localStorage`. On Web, the API key and settings are stored in browser `localStorage`. Conversations and original attachments are stored in IndexedDB (`chat-demo`), isolated by app/browser profile and origin (`https://localhost` on Android, which must not change across releases).
- **External requests**: Sending messages, uploading attachments, checking balance, and using ASR/TTS send the corresponding data directly to the configured API service.

**Settings → Data** provides two ZIP archive formats (see [history import/export documentation](src/services/chat/history/README.md)):

- **Export all chats (`v3`, `deepseek_data-YYYY-MM-DD.zip`)**: Compatible with the upstream `deepseek-ai/chat-demo` / DeepSeek export format; includes all conversation trees and locally available original images, excluding non-image originals, app settings, and API keys.
- **Full backup (`v4`, `whalechat-backup-YYYY-MM-DD.zip`)**: Restores into WhaleChat; additionally preserves locally available non-image attachment originals, app settings, draft text, document parsing modes, and per-reply model/effort/usage snapshots. Unsent draft attachments and missing local originals are not included. **API keys are never exported.**

Importing replaces all local conversations and attachments after confirmation and validation (`v4` also restores settings and draft text). **Settings → Data → Delete all chats** clears all local conversations, original attachments, and unsent drafts while keeping your API key and settings; files already uploaded to the API service are unaffected.

## Development

| Command              | Description                                                                   |
| -------------------- | ----------------------------------------------------------------------------- |
| `pnpm dev`           | Start the Web development server on `http://localhost:8090`                   |
| `pnpm build`         | Build the static Web bundle into `dist/` (set `NODE_ENV=production` for prod) |
| `pnpm build:android` | Build Web assets and sync them to `android/` via Capacitor                    |
| `pnpm apk:debug`     | Build Web assets and assemble the Android debug APK (Windows `gradlew.bat`)   |
| `pnpm apk:release`   | Build Web assets and assemble the Android release APK (Windows `gradlew.bat`) |
| `pnpm apk:install`   | Install `app-debug.apk` via `adb install -r`                                  |
| `pnpm type`          | Run TypeScript type checks                                                    |
| `pnpm lint`          | Lint with oxlint                                                              |
| `pnpm test`          | Run Node functional and data-safety regression tests                          |
| `pnpm test:c2`       | Run real-browser accessibility and layout regression tests                    |
| `pnpm test:c3`       | Run real-browser history search and branch jump regression tests              |
| `pnpm format`        | Format with oxfmt                                                             |

- [rspack.config.ts](rspack.config.ts) connects to `https://api.deepseek.com` by default; use `createConfig({ apiOrigin, devServer })` to customize the API origin or dev proxy.
- Platform differences are isolated in [src/platform/](src/platform/) so Web behavior stays compatible with upstream `chat-demo`.
- Chat defaults to `deepseek-flash` (with `deepseek-v4-pro` selectable) through Anthropic-compatible Messages / Files APIs, alongside `/user/balance`, `/v1/tools/asr`, and `/v1/tools/tts`. Requests use extensions for search, link reading, titles, and `latest_reminder`, so custom endpoints must support the corresponding capabilities.
- See [tests/README.md](tests/README.md) for test suite details.

```text
android/               Capacitor 8 Android project and SecureStoragePlugin (Keystore AES-GCM)
src/
  app/                 Application layout, themes, viewport handling, and global styles
  components/          Chat input, message list, history search, settings, and Markdown UI
  i18n/                Simplified Chinese and English translations
  platform/            Web and Android platform adapters (Keystore, share/export, back button, links)
  services/
    api/               API client, SSE decoder, error classification, and protocol types
    chat/              Conversations, branch trees, IndexedDB storage, search, and ZIP import/export
    markdown/          Markdown AST parsing, syntax highlighting, KaTeX, and Mermaid queue
    speech/            Audio recording (WAV) and streaming PCM read-aloud playback
  utils/               Shared utilities (image resizing, clipboard, formatting, IDs)
tests/                 Node and real-browser regression suites
```

## Upstream attribution & license

This project is derived from [`deepseek-ai/chat-demo`](https://github.com/deepseek-ai/chat-demo) and is released under the same [MIT License](LICENSE) (`Copyright (c) 2026 DeepSeek`). No ownership or official endorsement by DeepSeek is claimed. The build copies `LICENSE` to `dist/LICENSE`; retain it when redistributing. Third-party dependencies remain subject to their respective licenses.
