// Slack AI Autopilot — Ask Slack AI questions directly via Playwright
// Runs headless in the background. Only shows browser if login is needed.
// Sends messages to Slack AI bot and waits for full streamed response.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { chromium, type BrowserContext, type Page } from "playwright";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

// ── Config ───────────────────────────────────────────────────────────────────

const BASE_DIR = path.join(os.homedir(), ".pi", "slack-playwright-reader");
const PROFILE_DIR = path.join(BASE_DIR, "browser-profile");
const CONFIG_FILE = path.join(BASE_DIR, "config.json");

// ── Persisted Config ─────────────────────────────────────────────────────────

interface Config {
  teamId?: string;       // e.g. ELWSLBREU
  slackAiDmId?: string;  // e.g. D08S60Q238D
}

function loadConfig(): Config {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
    }
  } catch {}
  return {};
}

function saveConfig(config: Config): void {
  fs.mkdirSync(BASE_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

function getTeamId(): string | undefined {
  return loadConfig().teamId;
}

function setTeamId(id: string): void {
  const config = loadConfig();
  config.teamId = id;
  saveConfig(config);
}

function getSlackAiDmId(): string | undefined {
  return loadConfig().slackAiDmId;
}

function setSlackAiDmId(id: string): void {
  const config = loadConfig();
  config.slackAiDmId = id;
  saveConfig(config);
}

// Parse a team/workspace ID from a Slack URL or raw ID
// Accepts: https://app.slack.com/client/ELWSLBREU/... or just ELWSLBREU
function parseTeamId(input: string): string | null {
  const match = input.trim().match(/\/client\/([A-Z0-9]+)/) || input.trim().match(/^([A-Z0-9]{5,})$/);
  return match ? match[1] : null;
}

// Parse a DM ID from a Slack URL or raw ID
// Accepts: https://...slack.com/archives/D08S60Q238D or just D08S60Q238D
function parseDmId(input: string): string | null {
  const match = input.trim().match(/\/archives\/(D[A-Z0-9]+)/) || input.trim().match(/^(D[A-Z0-9]+)$/);
  return match ? match[1] : null;
}

// Timing
const MAX_WAIT_MS = 300000; // 5 minutes max wait for response
const POLL_INTERVAL = 1000; // check every 1 second
const STABLE_POLLS = 8; // response must be unchanged for 8 consecutive polls (8s) to be considered complete

// ── Concurrency Lock ─────────────────────────────────────────────────────────

let activeLock: Promise<void> = Promise.resolve();

function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const prev = activeLock;
  let resolve: () => void;
  activeLock = new Promise<void>((r) => { resolve = r; });
  return prev.then(fn).finally(() => resolve!());
}

// ── Persistent Browser ───────────────────────────────────────────────────────

let browserContext: BrowserContext | null = null;
let activePage: Page | null = null;
let isHeadless = true;

async function getPage(): Promise<Page> {
  if (browserContext && activePage && !activePage.isClosed()) {
    return activePage;
  }

  if (browserContext) {
    await browserContext.close().catch(() => {});
    browserContext = null;
    activePage = null;
  }

  browserContext = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: isHeadless,
    viewport: { width: 1400, height: 900 },
  });

  const pages = browserContext.pages();
  activePage = pages.length > 0 ? pages[0] : await browserContext.newPage();
  return activePage;
}

async function relaunchVisible(): Promise<Page> {
  if (browserContext) {
    await browserContext.close().catch(() => {});
    browserContext = null;
    activePage = null;
  }

  isHeadless = false;
  return getPage();
}

async function ensureSlackLoaded(page: Page, teamId: string): Promise<{ needsLogin: boolean }> {
  const url = page.url();
  if (url.includes("app.slack.com/client/")) return { needsLogin: false };

  await page.goto(`https://app.slack.com/client/${teamId}`, {
    waitUntil: "load",
    timeout: 60000,
  });

  await page.waitForTimeout(3000);

  // Handle desktop app redirect
  const bodyText = await page.locator("body").innerText().catch(() => "");
  if (bodyText.includes("redirected you to the desktop app")) {
    const browserLink = page.locator('a:has-text("open this link in your browser")');
    if ((await browserLink.count()) > 0) {
      const href = await browserLink.getAttribute("href");
      if (href) {
        const baseUrl = new URL(page.url()).origin;
        await page.goto(baseUrl + href, { waitUntil: "load", timeout: 60000 });
        await page.waitForTimeout(5000);
      }
    }
  }

  // Check if login is needed
  const currentUrl = page.url();
  const needsLogin =
    currentUrl.includes("/login") ||
    currentUrl.includes("/oauth") ||
    currentUrl.includes("/sso") ||
    currentUrl.includes("/auth") ||
    !currentUrl.includes("app.slack.com/client/");

  return { needsLogin };
}

async function navigateToAIDM(page: Page, teamId: string, dmId: string): Promise<void> {
  const targetUrl = `https://app.slack.com/client/${teamId}/${dmId}`;
  // Always navigate fresh to ensure we're on the home view, not inside a history item
  await page.goto(targetUrl, { waitUntil: "load", timeout: 30000 });
  await page.waitForTimeout(3000);

  // If we're inside a conversation, click "New conversation" to get back to fresh input
  const newConvoBtn = page.locator('button:has-text("New conversation"), [aria-label="New conversation"]').first();
  if ((await newConvoBtn.count()) > 0) {
    await newConvoBtn.click();
    await page.waitForTimeout(2000);
  }
}

// ── Extension ────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI): void {
  // ── /slack-team-id command ─────────────────────────────────────────────────
  pi.registerCommand("slack-team-id", {
    description: "Set your Slack workspace/team ID",
    handler: async (_args, ctx) => {
      const current = getTeamId();
      const hint = current ? `Current: ${current}\n\n` : "";
      const input = await ctx.ui.input(
        hint + "Paste your Slack workspace URL or team ID.\n\nHow to find it:\n  1. Open Slack in your browser\n  2. Copy the URL — it looks like: https://app.slack.com/client/ELWSLBREU/...\n  3. The team ID is the part after /client/ (e.g. ELWSLBREU)",
        "https://app.slack.com/client/XXXXX/... or just XXXXX",
      );
      if (!input) { ctx.ui.notify("Cancelled", "warning"); return; }
      const id = parseTeamId(input);
      if (!id) { ctx.ui.notify(`Couldn't parse a team ID from: "${input}"`, "error"); return; }
      setTeamId(id);
      ctx.ui.notify(`✅ Team ID saved: ${id}`, "success");
    },
  });

  // ── /slack-ai-dm command ───────────────────────────────────────────────────
  pi.registerCommand("slack-ai-dm", {
    description: "Set your Slack AI DM channel ID",
    handler: async (_args, ctx) => {
      const current = getSlackAiDmId();
      const hint = current ? `Current: ${current}\n\n` : "";
      const input = await ctx.ui.input(
        hint + "Paste your Slack AI DM link or ID.\n\nHow to find it:\n  1. Open Slack → find \"Slack AI\" in your DMs\n  2. Right-click it → Copy link\n  3. Paste the URL or just the ID (starts with D)",
        "https://...slack.com/archives/D... or just D...",
      );
      if (!input) { ctx.ui.notify("Cancelled", "warning"); return; }
      const id = parseDmId(input);
      if (!id) { ctx.ui.notify(`Couldn't parse a DM ID from: "${input}"`, "error"); return; }
      setSlackAiDmId(id);
      ctx.ui.notify(`✅ Slack AI DM ID saved: ${id}`, "success");
    },
  });

  pi.on("session_shutdown", async () => {
    if (browserContext) {
      await browserContext.close().catch(() => {});
      browserContext = null;
      activePage = null;
    }
  });

  pi.registerTool({
    name: "ask_slack_ai",
    label: "Ask Slack AI",
    description:
      "Ask Slack AI a question. It searches across ALL Slack channels, DMs, threads, Jira, Confluence, Google Drive, and more — returning a comprehensive AI-synthesized answer. Use for: finding conversations about a topic, summarizing channel activity, looking up decisions and their reasoning, identifying stakeholders/owners, searching documentation, getting project status, tracing discussions across channels, finding historical precedent, and any internal context that isn't in code. Questions should be detailed and multi-part for best results. Each call is a fresh conversation — Slack AI does NOT remember previous questions, so include all necessary context in every question. Note: Slack AI cannot see code/files directly — include relevant snippets in your question.",
    promptSnippet:
      "Ask Slack AI questions about internal context: conversations, decisions, Jira, Confluence, docs, people, project status",
    promptGuidelines: [
      "Use ask_slack_ai when you need internal context that isn't in the codebase — team discussions, decisions, Jira tickets, Confluence docs, project status, or stakeholder info.",
      "ask_slack_ai questions should be detailed and multi-part to trigger thorough research. Include technical context from code you've already read. Vague questions get vague answers.",
      "Each ask_slack_ai call starts a fresh conversation — Slack AI does NOT remember previous questions. Always include full context in every question rather than referencing prior answers.",
      "When using ask_slack_ai, structure questions with: (1) context about what you're working on, (2) specific multi-dimensional questions across team discussions, docs, and history, (3) what you plan to do with the info. Example: 'I'm working on X feature and found Y in the code. Can you search for: team discussions about this approach, who owns this area, any related Jira tickets, and recent decisions about the architecture?'",
      "ask_slack_ai excels at: searching across all Slack channels/DMs/threads, finding decisions and their reasoning, identifying stakeholders and owners, locating Jira tickets and Confluence docs, summarizing channel activity over time periods, tracing topics across multiple channels, and finding historical precedent for how issues were resolved.",
      "ask_slack_ai CANNOT see code, files, PRs, or repos directly — you must include relevant code snippets, error messages, or PR details in your question for context. Cross-reference what you can see in code with what Slack AI can find in conversations.",
      "IMPORTANT: The user CANNOT see Slack AI's response — only you can. You must fully convey the complete answer to the user in your own reply. Do not summarize or omit details. Present all findings, names, links, and context returned by Slack AI.",
      "When interpreting ask_slack_ai responses: focus on specific facts, discussions, and people mentioned rather than the AI's own conclusions. Verify important claims. The AI synthesizes from potentially incomplete data.",
      "Avoid vague ask_slack_ai questions like 'tell me about X'. Instead: 'I'm looking at the X API in /path/to/file — what are the team discussions about its response format, who owns schema decisions, and are there related Jira tickets?'",
    ],
    parameters: Type.Object({
      question: Type.String({
        description:
          "The question to ask Slack AI. Be detailed — include context, ask multi-part questions, specify what sources to search. Each call is independent (no memory of previous questions).",
      }),
    }),
    renderResult(result, { isPartial }, theme, _context) {
      if (isPartial) {
        const text = result?.content?.[0]?.text || "Working...";
        return new Text(theme.fg("muted", text), 0, 0);
      }
      const details = result?.details || {};
      const chars = details.chars || 0;
      const elapsed = details.elapsed ? `${details.elapsed}s` : "";
      const question = details.question || "";
      return new Text(
        theme.fg("success", "✅ Slack AI responded") +
        theme.fg("dim", " (") + theme.fg("success", `${chars} chars`) + theme.fg("dim", ", ") + theme.fg("text", elapsed) + theme.fg("dim", ")") +
        "\n" + theme.fg("muted", "Q: ") + theme.fg("dim", `${question.substring(0, 100)}${question.length > 100 ? "..." : ""}`),
        0, 0
      );
    },
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      return withLock(async () => {
      const checkAbort = () => { if (signal?.aborted) throw new Error("Cancelled"); };
      const sleep = (ms: number) => new Promise<void>((resolve, reject) => {
        if (signal?.aborted) { reject(new Error("Cancelled")); return; }
        const timer = setTimeout(resolve, ms);
        signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("Cancelled")); }, { once: true });
      });

      // ── Ensure team ID is configured ────────────────────────────────────
      let teamId = getTeamId();
      if (!teamId) {
        const input = await ctx.ui.input(
          "What is your Slack workspace/team ID? (only needed once)\n\n1. Open Slack in your browser\n2. Copy the URL — looks like: https://app.slack.com/client/XXXXX/...\n3. Paste the URL or just the ID after /client/",
          "https://app.slack.com/client/XXXXX/... or just XXXXX",
        );
        if (!input) {
          return { content: [{ type: "text", text: "Slack team ID not configured — use /slack-team-id to set it." }] };
        }
        const id = parseTeamId(input);
        if (!id) {
          return { content: [{ type: "text", text: `Couldn't parse a team ID from: "${input}". Use /slack-team-id to try again.` }] };
        }
        setTeamId(id);
        ctx.ui.notify(`✅ Team ID saved: ${id}`, "success");
        teamId = id;
      }

      // ── Ensure DM ID is configured ──────────────────────────────────────
      let dmId = getSlackAiDmId();
      if (!dmId) {
        const input = await ctx.ui.input(
          "What is your Slack AI DM ID? (only needed once)\n\n1. Open Slack → find \"Slack AI\" in your DMs\n2. Right-click it → Copy link\n3. Paste the URL or just the ID (starts with D)",
          "https://...slack.com/archives/D... or just D...",
        );
        if (!input) {
          return { content: [{ type: "text", text: "Slack AI DM ID not configured — use /slack-ai-dm to set it." }] };
        }
        const id = parseDmId(input);
        if (!id) {
          return { content: [{ type: "text", text: `Couldn't parse a DM ID from: "${input}". Use /slack-ai-dm to try again.` }] };
        }
        setSlackAiDmId(id);
        ctx.ui.notify(`✅ Slack AI DM ID saved: ${id}`, "success");
        dmId = id;
      }

      let page = await getPage();
      onUpdate?.({ content: [{ type: "text", text: "Connecting to Slack..." }] });
      const { needsLogin } = await ensureSlackLoaded(page, teamId);

      // If login is needed, relaunch with visible browser
      if (needsLogin) {
        page = await relaunchVisible();
        await ensureSlackLoaded(page, teamId);

        // Wait for user to log in (up to 5 min)
        for (let i = 0; i < 60; i++) {
          const url = page.url();
          if (url.includes("app.slack.com/client/") && !url.includes("/login")) break;
          await new Promise((r) => setTimeout(r, 5000));
        }

        // Switch back to headless for future calls
        isHeadless = true;
      }

      onUpdate?.({ content: [{ type: "text", text: "Opening Slack AI conversation..." }] });
      await navigateToAIDM(page, teamId, dmId);

      // Check if Slack AI is still responding to a previous message
      // Wait for any ongoing response to finish before sending a new one
      let lastMsgText = "";
      let prevStable = 0;
      const preCheckStart = Date.now();

      while (Date.now() - preCheckStart < 30000) {
        checkAbort();
        const lastMsg = page.locator('[data-qa="message_container"]').last();
        if ((await lastMsg.count()) === 0) break;

        const text = await lastMsg.evaluate((el) => {
          const textEl = el.querySelector('[data-qa="message-text"], .c-message_kit__text');
          return textEl ? textEl.textContent?.trim() || "" : el.textContent?.trim() || "";
        }).catch(() => "");

        if (text === lastMsgText) {
          prevStable++;
          if (prevStable >= 3) break; // stable for 9s, safe to send
        } else {
          lastMsgText = text;
          prevStable = 0;
        }
        await sleep(POLL_INTERVAL);
      }

      // Count messages before sending
      const beforeCount = await page.locator('[data-qa="message_container"]').count();

      // Find message input and send
      const messageInput = page.locator(
        '[data-qa="message_input"] [contenteditable="true"], ' +
        '.ql-editor[contenteditable="true"]'
      ).first();

      if ((await messageInput.count()) === 0) {
        return {
          content: [{ type: "text", text: "Could not find message input. Slack may need re-login — will show browser on next attempt." }],
        };
      }

      await messageInput.click();
      await sleep(300);
      await messageInput.fill(params.question);
      await sleep(500);
      await page.keyboard.press("Enter");

      onUpdate?.({ content: [{ type: "text", text: "✉️ Sent to Slack AI, waiting for response..." }] });

      // Wait for response — poll until it stabilizes (stops streaming)
      let response = "";
      let lastResponseText = "";
      let stableCount = 0;
      const startTime = Date.now();

      while (Date.now() - startTime < MAX_WAIT_MS) {
        checkAbort();
        await sleep(POLL_INTERVAL);

        const afterCount = await page.locator('[data-qa="message_container"]').count();

        // No new messages yet — AI hasn't started responding
        if (afterCount <= beforeCount) {
          const waitElapsed = Math.round((Date.now() - startTime) / 1000);
          onUpdate?.({ content: [{ type: "text", text: `⏳ Waiting for Slack AI to respond... (${waitElapsed}s)` }] });
          continue;
        }

        // Get the last message — extract just the AI's response text, not metadata
        const lastMsg = page.locator('[data-qa="message_container"]').last();
        const text = await lastMsg.evaluate((el) => {
          // Try to get just the message body text, skipping sender/time/action labels
          const textEl = el.querySelector('[data-qa="message-text"], .c-message_kit__text');
          if (textEl) return textEl.textContent?.trim() || "";
          // Fallback: get full container but skip known metadata elements
          const clone = el.cloneNode(true) as HTMLElement;
          clone.querySelectorAll('[data-qa="message_sender_name"], .c-message__sender, .c-timestamp, time').forEach(e => e.remove());
          return clone.textContent?.trim() || "";
        }).catch(() => "");

        // Skip our own echoed message
        if (!text || text === params.question) continue;

        // Check if response has stabilized (AI done streaming)
        if (text === lastResponseText && text.length > 0) {
          stableCount++;
          const elapsed = Math.round((Date.now() - startTime) / 1000);
          const remaining = (STABLE_POLLS - stableCount) * Math.round(POLL_INTERVAL / 1000);
          onUpdate?.({ content: [{ type: "text", text: `⏸️ Response paused (${text.length} chars, ${elapsed}s) — confirming done in ${remaining}s...` }] });
          if (stableCount >= STABLE_POLLS) {
            response = text;
            break;
          }
        } else {
          // Response is still growing — report progress
          lastResponseText = text;
          stableCount = 0;
          const elapsed = Math.round((Date.now() - startTime) / 1000);
          onUpdate?.({
            content: [{ type: "text", text: `✍️ Slack AI responding... (${elapsed}s, ${text.length} chars)` }],
          });
        }
      }

      if (!response) {
        // Grab whatever we have
        const lastMsg = page.locator('[data-qa="message_container"]').last();
        const text = await lastMsg.evaluate((el) => {
          const textEl = el.querySelector('[data-qa="message-text"], .c-message_kit__text');
          return textEl ? textEl.textContent?.trim() || "" : el.textContent?.trim() || "";
        }).catch(() => "");

        if (text && text !== params.question && text.length > 20) {
          response = text + "\n\n[Note: Response may be incomplete — timed out after 5 minutes]";
        } else {
          return {
            content: [{ type: "text", text: "Timed out waiting for Slack AI response (5 min). Try again — the AI may be slow or the DM needs attention." }],
          };
        }
      }

      // Clean up response — strip metadata cruft
      response = response
        .replace(/^Slackbot\s+.*?\n/i, "") // Remove "Slackbot  Just now" line
        .replace(/^.*?(Searched|Looked up|Retrieved|Browsing|Searching|Reading|Found|Checking|Reviewed|Summariz|Looked at|Pulled up|Queried|Fetched|Scanned).*?\n/i, "") // Remove action labels
        .replace(/\s+\d+$/gm, "") // Remove trailing reference numbers like " 1"
        .trim();

      return {
        content: [{ type: "text", text: response }],
        details: {
          question: params.question,
          chars: response.length,
          elapsed: Math.round((Date.now() - startTime) / 1000),
        },
      };
      }); // end withLock
    },
  });
}
