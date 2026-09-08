#!/usr/bin/env node
/**
 * Export matching Gmail messages to a local file.
 *
 * No dependencies on purpose: this is a one-off-ish utility and adding
 * googleapis to a Next.js app's package.json to read a mailbox is a bad trade.
 * Plain Node covers the loopback OAuth flow and two REST calls.
 *
 * Nothing is uploaded anywhere. The OAuth token and the exported mail stay in
 * this directory, both gitignored.
 *
 * Setup, once:
 *   1. console.cloud.google.com -> new or existing project
 *   2. APIs & Services -> Library -> enable "Gmail API"
 *   3. APIs & Services -> OAuth consent screen -> External, add yourself
 *      under "Test users"
 *   4. Credentials -> Create credentials -> OAuth client ID -> Desktop app
 *   5. Download the JSON, save it here as .gmail-credentials.json
 *
 * Then, for the weekly HPM updates (the default):
 *   node scripts/gmail-export.mjs
 *
 * Or any other Gmail search:
 *   node scripts/gmail-export.mjs --query "to:someone@x.com" --max 500 --out other
 *
 * Addressing the alias is the precise filter — a keyword search for "HPM"
 * would also drag in every thread that merely mentions it.
 */

import { createServer } from "node:http"
import { createHash, randomBytes } from "node:crypto"
import { readFile, writeFile, mkdir } from "node:fs/promises"
import { existsSync } from "node:fs"
import { spawn } from "node:child_process"
import path from "node:path"

const SCOPE = "https://www.googleapis.com/auth/gmail.readonly"
const PORT = 53682
const REDIRECT = `http://localhost:${PORT}`
const CRED_FILE = ".gmail-credentials.json"
const TOKEN_FILE = ".gmail-token.json"
const OUT_DIR = ".gmail-export"

// ─── args ────────────────────────────────────────────────────────────────────

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

const QUERY = arg("query", "from:me to:hpm@slow.co")
const MAX = Number(arg("max", "300"))
const OUT = arg("out", "hpm")

// ─── oauth ───────────────────────────────────────────────────────────────────

async function loadClient() {
  if (!existsSync(CRED_FILE)) {
    console.error(`\nMissing ${CRED_FILE}.\n`)
    console.error("Create an OAuth client (Desktop app) in Google Cloud Console,")
    console.error(`download the JSON, and save it as ${CRED_FILE} in this directory.`)
    console.error("Full steps are in the comment at the top of this script.\n")
    process.exit(1)
  }
  const raw = JSON.parse(await readFile(CRED_FILE, "utf8"))
  const c = raw.installed ?? raw.web ?? raw
  if (!c.client_id) {
    console.error(`${CRED_FILE} doesn't look like an OAuth client file.`)
    process.exit(1)
  }
  return { clientId: c.client_id, clientSecret: c.client_secret }
}

function openBrowser(url) {
  const cmd = process.platform === "darwin" ? "open"
    : process.platform === "win32" ? "start" : "xdg-open"
  spawn(cmd, [url], { stdio: "ignore", detached: true }).unref()
}

/** Loopback + PKCE. Google allows http://localhost for Desktop clients. */
async function authorize({ clientId, clientSecret }) {
  const verifier = randomBytes(32).toString("base64url")
  const challenge = createHash("sha256").update(verifier).digest("base64url")

  const authUrl =
    "https://accounts.google.com/o/oauth2/v2/auth?" +
    new URLSearchParams({
      client_id: clientId,
      redirect_uri: REDIRECT,
      response_type: "code",
      scope: SCOPE,
      access_type: "offline",
      prompt: "consent",
      code_challenge: challenge,
      code_challenge_method: "S256",
    })

  const code = await new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url, REDIRECT)
      const c = url.searchParams.get("code")
      const err = url.searchParams.get("error")
      res.writeHead(200, { "Content-Type": "text/html" })
      res.end(
        `<body style="font-family:system-ui;padding:40px">
         <h2>${c ? "Authorised" : "Failed"}</h2>
         <p>${c ? "You can close this tab and go back to the terminal." : err}</p>
         </body>`
      )
      server.close()
      c ? resolve(c) : reject(new Error(err ?? "no code returned"))
    })
    server.listen(PORT, () => {
      console.log("\nOpening your browser to authorise read-only Gmail access…")
      console.log(`If it doesn't open, visit:\n${authUrl}\n`)
      openBrowser(authUrl)
    })
    setTimeout(() => { server.close(); reject(new Error("timed out waiting for authorisation")) }, 300000)
  })

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      ...(clientSecret ? { client_secret: clientSecret } : {}),
      redirect_uri: REDIRECT,
      grant_type: "authorization_code",
      code_verifier: verifier,
    }),
  })
  if (!res.ok) throw new Error(`Token exchange failed: ${await res.text()}`)
  const token = await res.json()
  token.obtained_at = Date.now()
  await writeFile(TOKEN_FILE, JSON.stringify(token, null, 2))
  console.log(`Saved a token to ${TOKEN_FILE} (gitignored). Future runs won't ask again.\n`)
  return token
}

async function refresh({ clientId, clientSecret }, token) {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: token.refresh_token,
      client_id: clientId,
      ...(clientSecret ? { client_secret: clientSecret } : {}),
      grant_type: "refresh_token",
    }),
  })
  if (!res.ok) return null
  const fresh = await res.json()
  const merged = { ...token, ...fresh, obtained_at: Date.now() }
  await writeFile(TOKEN_FILE, JSON.stringify(merged, null, 2))
  return merged
}

async function getAccessToken(client) {
  if (existsSync(TOKEN_FILE)) {
    const token = JSON.parse(await readFile(TOKEN_FILE, "utf8"))
    const age = (Date.now() - (token.obtained_at ?? 0)) / 1000
    if (age < (token.expires_in ?? 3600) - 120) return token.access_token
    if (token.refresh_token) {
      const fresh = await refresh(client, token)
      if (fresh) return fresh.access_token
    }
  }
  return (await authorize(client)).access_token
}

// ─── gmail ───────────────────────────────────────────────────────────────────

async function api(url, accessToken) {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } })
  if (res.status === 429 || res.status === 403) {
    await new Promise(r => setTimeout(r, 2000))
    return api(url, accessToken)
  }
  if (!res.ok) throw new Error(`Gmail API ${res.status}: ${(await res.text()).slice(0, 300)}`)
  return res.json()
}

const decode = b64 =>
  b64 ? Buffer.from(b64.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8") : ""

/** Prefer text/plain; fall back to stripping the HTML part. */
function extractBody(payload) {
  let plain = "", html = ""
  const walk = part => {
    if (!part) return
    if (part.mimeType === "text/plain" && part.body?.data) plain += decode(part.body.data)
    else if (part.mimeType === "text/html" && part.body?.data) html += decode(part.body.data)
    for (const p of part.parts ?? []) walk(p)
  }
  walk(payload)
  if (plain.trim()) return plain
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
}

/**
 * Cut the quoted thread below a reply. Without this, one long thread's text
 * repeats in every message in it and swamps whatever was actually new.
 */
function stripQuoted(text) {
  const markers = [
    /^On .+ wrote:$/m,
    /^-{2,}\s*Original Message\s*-{2,}$/im,
    /^-{2,}\s*Forwarded message\s*-{2,}$/im,
    /^From:\s.+$/m,
    /^_{10,}$/m,
    /^Sent from my /m,
  ]
  let cut = text.length
  for (const m of markers) {
    const hit = text.match(m)
    if (hit?.index !== undefined && hit.index < cut) cut = hit.index
  }
  return text
    .slice(0, cut)
    .split("\n")
    .filter(l => !l.trimStart().startsWith(">"))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

const header = (msg, name) =>
  msg.payload?.headers?.find(h => h.name.toLowerCase() === name.toLowerCase())?.value ?? ""

async function main() {
  const client = await loadClient()
  const accessToken = await getAccessToken(client)

  console.log(`Searching: ${QUERY}`)
  const ids = []
  let pageToken

  do {
    const params = new URLSearchParams({ q: QUERY, maxResults: "100" })
    if (pageToken) params.set("pageToken", pageToken)
    const page = await api(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages?${params}`,
      accessToken
    )
    for (const m of page.messages ?? []) ids.push(m.id)
    pageToken = page.nextPageToken
  } while (pageToken && ids.length < MAX)

  const targets = ids.slice(0, MAX)
  console.log(`${ids.length} matched, fetching ${targets.length}…`)

  const messages = []
  for (const [i, id] of targets.entries()) {
    const msg = await api(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=full`,
      accessToken
    )
    messages.push({
      id,
      threadId: msg.threadId,
      date: header(msg, "Date"),
      from: header(msg, "From"),
      to: header(msg, "To"),
      cc: header(msg, "Cc"),
      subject: header(msg, "Subject"),
      body: stripQuoted(extractBody(msg.payload)).slice(0, 12000),
    })
    if ((i + 1) % 25 === 0) console.log(`  …${i + 1}/${targets.length}`)
  }

  messages.sort((a, b) => new Date(a.date) - new Date(b.date))

  await mkdir(OUT_DIR, { recursive: true })
  const jsonPath = path.join(OUT_DIR, `${OUT}.json`)
  const mdPath = path.join(OUT_DIR, `${OUT}.md`)
  await writeFile(jsonPath, JSON.stringify(messages, null, 2))
  await writeFile(
    mdPath,
    messages
      .map(
        m => `## ${m.subject || "(no subject)"}\n\n` +
             `**Date:** ${m.date}  \n**To:** ${m.to}${m.cc ? `  \n**Cc:** ${m.cc}` : ""}\n\n${m.body}\n`
      )
      .join("\n---\n\n")
  )

  const words = messages.reduce((n, m) => n + m.body.split(/\s+/).filter(Boolean).length, 0)
  console.log(`\nWrote ${messages.length} messages (${words.toLocaleString()} words)`)
  console.log(`  ${jsonPath}`)
  console.log(`  ${mdPath}`)
  if (messages.length) {
    console.log(`\nRange: ${messages[0].date} -> ${messages[messages.length - 1].date}`)
  }
}

main().catch(err => {
  console.error("\nFailed:", err.message)
  process.exit(1)
})
