# WhaleChat

English | [简体中文](README.zh-CN.md)

An Android and static Web chat client powered by the DeepSeek API, built with React, TypeScript, and Capacitor 8 (evolved from the upstream [`deepseek-ai/chat-demo`](https://github.com/deepseek-ai/chat-demo)). No application backend is required: the client connects directly to the configured API service using your personal API key.

See the [docs index](docs/README.md) for architecture and verification records:
- [Phase A](docs/android-phase-a-verification.md): Capacitor 8 Android shell, Keystore credential encryption, draft persistence, and real API / emulator checks across networking, speech, data, and files.
- [Phase B](docs/android-phase-b-verification.md): Flash / V4 Pro model and thinking effort selection, account balance and usage panel, full app backups (archive v4), in-app fullscreen image viewer, and double-back exit.
- [Phase C](docs/android-phase-c-verification.md): Viewport-gated on-demand rich rendering, keyboard and focus accessibility, title and full-branch body search with branch jump, and attachment context and billing safeguards.

>Physical device testing, TalkBack screen-reader walkthroughs, real-device audio routing, and live C4 paid document re-parsing flows remain pending; automated regressions and emulator records do not replace full physical-device acceptance.

## Getting started

Install Node.js 22.12+ and pnpm, then run:

```sh
git clone https://github.com/g64-cmd/deepseek_app.git
cd deepseek_app
pnpm install
pnpm dev
```

Open http://localhost:8090 and enter your DeepSeek API key in Settings before your first chat.

To build the static Web bundle:

```sh
pnpm build
```

The output is written to `dist/`. Deploy it to a static web server or open `dist/index.html` directly (opening via `file://` requires browser storage support on local files and an API service that permits their cross-origin requests).

## Features

- **Conversations & branches**: Multiple conversations with automatic titles, renaming, and deletion; edit prompts, regenerate replies, and switch between message branches.
- **Title & full-branch body search**: Filter conversation titles or run cancellable batch scans across user and assistant text in all branches, jumping directly to matching messages even on unselected branches.
- **Models & reasoning**: Switch between `DeepSeek Flash` (`deepseek-flash`) and `DeepSeek V4 Pro` (`deepseek-v4-pro`), configure thinking effort (`low` / `high` / `max`), stream replies with deep thinking, smart web search, link reading, and source citations, and stop or continue eligible replies.
- **Attachments & billing safeguards**: Upload, paste, or drag and drop files; choose document parsing mode (text-only vs. rich layout), confirm per-page parsing billing upfront, guard against the 20-document request limit, and retry or explicitly omit unavailable historical attachments. View and zoom raster images in an in-app fullscreen viewer.
- **Voice input & read-aloud**: Record voice prompts with a live mobile audio spectrum (`POST /v1/tools/asr`) and read replies aloud via streaming PCM TTS (`POST /v1/tools/tts`).
- **Rich content**: Markdown, syntax highlighting (Prism), KaTeX math, and Mermaid diagrams with viewport-gated on-demand rendering for long conversations.
- **Account & backup**: Real-time account balance (`GET /user/balance`), local token/search usage aggregation with off-peak/peak cost estimates, official-compatible history ZIP import/export (v3), and full application backup/restore (v4).
- **Customization & accessibility**: Simplified Chinese and English, light/dark/system themes, responsive mobile drawer and keyboard-aware layouts, unified modal focus layers, and reduced-motion adaptation.

## Data and storage

On Web, your API key and settings are stored in `localStorage`. On Android, an AES-256-GCM key protected by Android Keystore encrypts the API key (`SecureStoragePlugin`), storing ciphertext and IV in private `SharedPreferences`; other settings and unsent draft text (`chat-demo:draft-texts`) use WebView `localStorage`. Conversations and original attachments are stored in IndexedDB (`chat-demo`). Local data is isolated by app or browser profile and site origin. Sending messages, uploading attachments, and using speech features sends the relevant content to the configured API service.

Settings → Data provides two ZIP archive formats (see the [history import/export documentation](src/services/chat/history/README.md)):
- **Export all chats (v3, `deepseek_data-YYYY-MM-DD.zip`)**: Compatible with the official DeepSeek format; includes all conversation trees and locally available original images, excluding non-image originals, app settings, and API keys.
- **Full backup (v4, `whalechat-backup-YYYY-MM-DD.zip`)**: Restores into WhaleChat; additionally preserves locally available non-image attachment originals, app settings, draft text, document parsing modes, and per-reply model/effort/usage snapshots. Unsent draft attachments and missing local originals are outside the backup scope. **API keys are never exported.**

After confirmation and successful validation, importing replaces all local conversations and attachments (v4 also restores settings and draft text). Settings → Data → Delete all chats clears all local conversations, original attachments, and unsent drafts while preserving your API key and settings; files already uploaded to the API service are not deleted.

## Development

| Command               | Description                                                  |
| --------------------- | ------------------------------------------------------------ |
| `pnpm dev`            | Start the development server on `http://localhost:8090`      |
| `pnpm build`          | Build the static Web bundle into `dist/`                     |
| `pnpm build:android`  | Build Web assets and sync to the Capacitor Android project   |
| `pnpm apk:debug`      | Build Web assets and package the Android debug APK           |
| `pnpm apk:install`    | `adb install -r` the debug APK onto a connected device       |
| `pnpm type`           | Run TypeScript type checks                                   |
| `pnpm lint`           | Lint with oxlint                                             |
| `pnpm test`           | Run Node functional and data-safety regression tests         |
| `pnpm test:c2`        | Run real-browser accessibility and layout regression tests   |
| `pnpm test:c3`        | Run real-browser history search and branch jump regressions  |
| `pnpm perf:c0`        | Run the Android C0 performance and memory measurement driver |
| `pnpm format`         | Format with oxfmt                                            |

[rspack.config.ts](rspack.config.ts) connects to `https://api.deepseek.com` by default. Use `createConfig({ apiOrigin, devServer })` to customize the API origin and development server proxy. See [tests/README.md](tests/README.md) for test coverage and [scripts/perf/README.md](scripts/perf/README.md) for Android performance tooling.

### Android debug build

Built on Capacitor 8 (Gradle 8.14.3 / AGP 8.13.0 / compileSdk 36 / minSdk 24). Requires the Android SDK and **JDK 21** for the Gradle daemon (pinned via `org.gradle.java.home` in the user-level `~/.gradle/gradle.properties`; see the [Phase A verification record](docs/android-phase-a-verification.md)):

```sh
pnpm apk:debug    # build web → cap sync → gradlew assembleDebug
pnpm apk:install  # install onto a connected device or emulator
```

Platform differences are isolated in [src/platform/](src/platform/) (Android Keystore credential storage, external link delegation, cache-backed file sharing and startup cleanup, and double-back / modal-stack back button handling); Web behavior remains unchanged. The application ID is `com.g64_cmd.whalechat`, and the WebView origin is `https://localhost` (must not change after release).

Chat uses `deepseek-flash` by default (with `deepseek-v4-pro` selectable) through Anthropic-compatible Messages / Files APIs. Speech features use `/v1/tools/asr` and `/v1/tools/tts`. Requests include extensions for search, link reading, titles, and `latest_reminder`, so the configured service must support the corresponding capabilities.

```text
android/               Capacitor Android project and SecureStoragePlugin (Keystore AES-GCM)
docs/                  Architecture design, DeepSeek API snapshot, and Phase A/B/C verification records
scripts/perf/          Android C0/C3 performance, scale, and trace measurement scripts
src/
  app/                 Application layout, themes, viewport handling, and global styles
  components/          Chat input, message list, history search, settings, and Markdown components
  i18n/                Simplified Chinese and English translations
  platform/            Web and Android platform adapters (Keystore, file export/share, back button, links)
  services/
    api/               API client, SSE decoder, error classification, and protocol types
    chat/              Conversations, branch trees, IndexedDB storage, search, and ZIP import/export
    markdown/          Markdown AST parsing, syntax highlighting, KaTeX, and Mermaid queue
    speech/            Audio recording (WAV) and streaming PCM read-aloud playback
  utils/               Shared utilities (image resizing, clipboard, formatting, IDs)
tests/                 Node and real-browser regression suites
```

## License

[MIT](LICENSE). The build copies the license to `dist/LICENSE`; include it when distributing the app. Third-party dependencies are subject to their own licenses.
