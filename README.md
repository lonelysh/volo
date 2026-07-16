# Volo for Obsidian

[![Obsidian Plugin](https://img.shields.io/badge/Obsidian-Plugin-blueviolet)](https://obsidian.md/plugins)
[![Mobile](https://img.shields.io/badge/mobile-supported-green)](#ios-compatibility)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![Min App Version](https://img.shields.io/badge/min--app--version-1.5.0-purple)](#)

**Volo** is a sidebar chat with LLMs inside Obsidian, powered by the MiniMax / MiniMax / MiniMax Chinese LLM family (MiniMax-M3 and M2.x via OpenAI-compatible endpoints). Other compatible providers can be configured via the Base URL setting. Sidebar chat, selection AI actions, and full-note processing. **iOS compatible** (works on iPhone and iPad via Obsidian Mobile).

## Features

| Module | Entry Point | What It Does |
|---|---|---|
| Sidebar chat | Ribbon "message bubble" icon, or command `Volo: Open Sidebar Chat` | Streaming SSE output, optionally injects the active note as context |
| Selection AI actions | Editor menu / command palette | Translate (EN ↔ ZH), explain, summarize, polish, casualize, custom prompt |
| Full-note commands | Command palette | Summarize active note, generate outline, continue writing, fix typos |
| API connectivity test | Settings tab or command `Volo: Test API Connection` | Sends a 1-token request with the current configuration |

## Installation

### Option A — Manual install
1. Download `main.js`, `styles.css`, and `manifest.json` from the latest [release](../../releases/latest).
2. Place them under `<your-vault>/.obsidian/plugins/volo/`.
3. In Obsidian → Settings → Community plugins → enable **Volo**.

### Option B — From source
```bash
git clone https://github.com/lonelysh/volo.git
cd volo
npm install
npm run dev        # watch mode
npm run build      # type-check + production build
```

### Option C — BRAT (recommended for iOS testing)
1. Install the [BRAT](https://github.com/TfTHacker/obsidian42-brat) plugin in Obsidian Mobile.
2. BRAT → **Add Beta plugin** → enter `lonelysh/volo`.
3. Enable **Volo** in Community plugins.

## Quick Start

1. Open Settings → Community plugins → **Volo**.
2. Paste your API key (create one at [platform.minimaxi.com](https://platform.minimaxi.com)).
3. Leave **Base URL** at `https://api.minimaxi.com/v1`, or change it:
   - International: `https://api.minimax.io/v1`
   - Self-hosted / proxy: your own endpoint
4. Pick a model (default `MiniMax-M3`).
5. Click **Test API** — a `Notice` with `OK` confirms the setup.
6. Open the chat from the ribbon, or select some text and try **Translate to English**.

## Settings Reference

| Field | Default | Notes |
|---|---|---|
| Base URL | `https://api.minimaxi.com/v1` | Must match the region of your API key |
| Model | `MiniMax-M3` | Long context + tool use + multimodal |
| Temperature | 0.7 | 0 = deterministic, 2 = creative |
| Max Tokens | 4096 | M3 supports up to 65536 |
| System Prompt | Built-in bilingual prompt | Sent on every request |
| Inject note context | On | Automatically prepends the active note to the chat history |
| Custom selection prompt | Empty | Used by **Volo: Selection → Custom Prompt** |

## iOS Compatibility

The plugin ships with mobile-friendly defaults:

- `manifest.json` declares `isDesktopOnly: false` — visible on iOS / Android
- Touch targets ≥ 44×44 px (WCAG / iOS HIG)
- `padding` uses `env(safe-area-inset-*)` to respect notch and home-indicator
- No `position: fixed` for the main layout; no hover-only interactions
- No `backdrop-filter` on layout containers (would trap `fixed` children)
- Network layer prefers `fetch()` + AbortController (streaming); on failure it falls back to Obsidian's `requestUrl()` (no CORS issues, non-streaming)
- All requests are HTTPS only
- The settings tab shows an extra hint when running on iOS

To debug iOS specifically, connect the device to a Mac over USB, enable iOS Settings → Safari → Advanced → **Web Inspector**, and attach from Safari's **Develop** menu.

## Error Code Reference

| HTTP / Code | Meaning | Suggested Action |
|---|---|---|
| 401 / 1004 / 2049 | Authentication failed | Check API key; verify Base URL matches key region |
| 1008 | Insufficient balance | Top up your account |
| 429 / 1002 / 1039 / 2045 / 2056 | Rate limited | Wait and retry; reduce call frequency or lower `max_tokens` |
| 1026 | Input flagged as sensitive | Rephrase the input |
| 1027 | Output flagged as sensitive | Adjust the prompt or reformulate the question |
| 5xx / 1013 / 1033 | Server-side error | Retry after a short delay |
| iOS streaming failed | CORS / network | Plugin auto-falls back to non-streaming |

## Project Structure

```
volo/
├── manifest.json              # isDesktopOnly: false
├── package.json               # esbuild + typescript
├── tsconfig.json
├── esbuild.config.mjs         # build script (watch + production)
├── version-bump.mjs
├── versions.json
├── styles.css                 # mobile-first, 44px touch targets, safe-area
└── src/
    ├── main.ts                # entry: register view + commands
    ├── constants.ts           # model list, default URL, presets
    ├── settings/
    │   ├── defaults.ts        # default configuration
    │   └── SettingsTab.ts     # settings UI
    ├── api/
    │   ├── types.ts           # ChatMessage / Request / Response types
    │   ├── errors.ts          # error normalization (1004 / 1008 / 1026 / 1027 / ...)
    │   ├── streaming.ts       # SSE parser
    │   └── client.ts          # Volo client: streaming + requestUrl fallback
    ├── views/
    │   └── ChatView.ts        # sidebar chat view
    ├── commands/
    │   ├── selection.ts       # selection AI actions
    │   └── note.ts            # full-note commands
    └── utils/
        ├── mobile.ts          # Platform.isIosApp helper
        └── prompt.ts          # template placeholders, truncation
```

## Development Scripts

```bash
npm run dev      # esbuild watch mode
npm run build    # tsc --noEmit + esbuild production bundle
npm run version  # bump version in manifest.json and versions.json
```

## License

[MIT](LICENSE)