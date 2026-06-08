# pi-slack-ai

A [pi](https://pi.dev) extension that lets the LLM ask Slack AI questions directly. It searches across all your Slack channels, DMs, threads, Jira, Confluence, Google Drive, and more — returning AI-synthesized answers without you ever leaving your terminal.

## How it works

Uses Playwright to control a headless Chromium browser that sends messages to Slack AI and reads back the responses. Your browser session is persisted so you only need to log in once.

## Install

```bash
pi install git:github.com/jackwrichards/pi-slack-ai
```

Then install the Chromium browser for Playwright:

```bash
cd ~/.pi/agent/git/github.com/jackwrichards/pi-slack-ai
npx playwright install chromium
```

## Setup (one-time)

The first time the tool runs, it will ask you two things:

### 1. Workspace/Team ID

1. Open Slack **in your browser** (not the desktop app)
2. Look at the URL — it looks like: `https://app.slack.com/client/ELWSLBREU/...`
3. The team ID is the part after `/client/` (e.g. `ELWSLBREU`)

### 2. Slack AI DM ID

1. Open Slack → find **"Slack AI"** in your DMs sidebar
2. Right-click "Slack AI" → **Copy link**
3. You'll get something like: `https://your-org.slack.com/archives/D08S60Q238D`
4. The DM ID is the part after `/archives/` (starts with `D`)

Both values are saved permanently in `~/.pi/slack-playwright-reader/config.json`.

## Commands

| Command | Description |
|---------|-------------|
| `/slack-team-id` | Update your workspace/team ID |
| `/slack-ai-dm` | Update your Slack AI DM channel ID |

## Authentication

- On first use (or if your session expires), a **visible** Chromium window will open so you can log in (SSO, 2FA, etc.)
- After login, the browser switches back to headless mode — you'll never see it again
- Session cookies are stored in `~/.pi/slack-playwright-reader/browser-profile/`

## Requirements

- [pi](https://pi.dev) coding agent
- A Slack workspace with [Slack AI](https://slack.com/features/ai) enabled
- Node.js 18+

## License

MIT
