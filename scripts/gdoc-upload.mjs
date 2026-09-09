#!/usr/bin/env node
/**
 * Convert a Markdown file to HTML and upload it to Google Drive as a real
 * Google Doc, printing the link.
 *
 * Reuses the OAuth client in .gmail-credentials.json but needs a different
 * scope (drive.file), so it keeps its own token file — the Gmail token is
 * read-only mail access and cannot create anything.
 *
 * Setup, once:
 *   Google Cloud Console -> APIs & Services -> Library -> enable "Google Drive API"
 *
 * Then:
 *   node scripts/gdoc-upload.mjs --file .gmail-export/handoff.md --title "Handoff"
 *
 * The doc is created private and owned by you. Sharing is deliberately left
 * alone: this contains internal names, vendors and metrics, and a script
 * should not be the thing that decides to make that link public.
 */

import { createServer } from "node:http"
import { createHash, randomBytes } from "node:crypto"
import { readFile, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { spawn } from "node:child_process"
import path from "node:path"
import { mdToHtml } from "./md-to-html.mjs"

const SCOPE = "https://www.googleapis.com/auth/drive.file"
const PORT = 53683
const REDIRECT = "http://localhost:" + PORT
const CRED_FILE = ".gmail-credentials.json"
const TOKEN_FILE = ".gdrive-token.json"

const arg = (n, d) => {
  const i = process.argv.indexOf("--" + n)
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : d
}

const FILE = arg("file", ".gmail-export/handoff.md")
const TITLE = arg("title", path.basename(FILE).replace(/\.md$/, ""))

async function loadClient() {
  if (!existsSync(CRED_FILE)) {
    console.error("Missing " + CRED_FILE)
    process.exit(1)
  }
  const raw = JSON.parse(await readFile(CRED_FILE, "utf8"))
  const c = raw.installed || raw.web || raw
  return { clientId: c.client_id, clientSecret: c.client_secret }
}

function openBrowser(url) {
  const cmd =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open"
  spawn(cmd, [url], { stdio: "ignore", detached: true }).unref()
}

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
        '<body style="font-family:system-ui;padding:40px"><h2>' +
          (c ? "Authorised" : "Failed") +
          "</h2><p>" +
          (c ? "Close this tab and return to the terminal." : err) +
          "</p></body>"
      )
      server.close()
      if (c) resolve(c)
      else reject(new Error(err || "no code returned"))
    })
    server.listen(PORT, () => {
      console.log("\nOpening your browser to authorise Drive access (create files only)...")
      console.log("If it does not open, visit:\n" + authUrl + "\n")
      openBrowser(authUrl)
    })
    setTimeout(() => {
      server.close()
      reject(new Error("timed out waiting for authorisation"))
    }, 300000)
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
  if (!res.ok) throw new Error("Token exchange failed: " + (await res.text()))
  const token = await res.json()
  token.obtained_at = Date.now()
  await writeFile(TOKEN_FILE, JSON.stringify(token, null, 2))
  return token
}

async function getAccessToken(client) {
  if (existsSync(TOKEN_FILE)) {
    const t = JSON.parse(await readFile(TOKEN_FILE, "utf8"))
    const age = (Date.now() - (t.obtained_at || 0)) / 1000
    if (age < (t.expires_in || 3600) - 120) return t.access_token
    if (t.refresh_token) {
      const res = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          refresh_token: t.refresh_token,
          client_id: client.clientId,
          ...(client.clientSecret ? { client_secret: client.clientSecret } : {}),
          grant_type: "refresh_token",
        }),
      })
      if (res.ok) {
        const fresh = { ...t, ...(await res.json()), obtained_at: Date.now() }
        await writeFile(TOKEN_FILE, JSON.stringify(fresh, null, 2))
        return fresh.access_token
      }
    }
  }
  return (await authorize(client)).access_token
}

async function main() {
  const md = await readFile(FILE, "utf8")
  const html = mdToHtml(md, TITLE)

  const htmlPath = FILE.replace(/\.md$/, ".html")
  await writeFile(htmlPath, html)
  console.log("Paste-ready HTML written to: " + htmlPath)

  const client = await loadClient()
  const accessToken = await getAccessToken(client)

  const boundary = "gdocboundary" + randomBytes(8).toString("hex")
  const CRLF = String.fromCharCode(13, 10)
  const body =
    "--" + boundary + CRLF +
    "Content-Type: application/json; charset=UTF-8" + CRLF + CRLF +
    JSON.stringify({ name: TITLE, mimeType: "application/vnd.google-apps.document" }) + CRLF +
    "--" + boundary + CRLF +
    "Content-Type: text/html; charset=UTF-8" + CRLF + CRLF +
    html + CRLF +
    "--" + boundary + "--"

  const res = await fetch(
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink",
    {
      method: "POST",
      headers: {
        Authorization: "Bearer " + accessToken,
        "Content-Type": "multipart/related; boundary=" + boundary,
      },
      body,
    }
  )

  if (!res.ok) {
    const text = await res.text()
    if (/accessNotConfigured|has not been used|is disabled/i.test(text)) {
      console.error("\nThe Google Drive API is not enabled on this project yet.")
      console.error("Enable it here, then re-run:")
      console.error("  Google Cloud Console -> APIs & Services -> Library -> Google Drive API -> Enable\n")
      process.exit(2)
    }
    throw new Error("Drive upload failed: " + text.slice(0, 500))
  }

  const file = await res.json()
  console.log("\nCreated Google Doc: " + file.name)
  console.log("  " + file.webViewLink)
  console.log("\nIt is private to your account. Share it from the Doc when you are ready.")
}

main().catch(err => {
  console.error("\nFailed: " + err.message)
  process.exit(1)
})
