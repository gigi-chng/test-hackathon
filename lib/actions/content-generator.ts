"use server"

import { prisma } from "@/lib/db/prisma"
import Anthropic from "@anthropic-ai/sdk"

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

const PARTNER_NAMES: Record<string, string> = {
  sam: "Sam Lessin",
  will: "Will Quist",
  yoni: "Yoni Rechtman",
  megan: "Megan Lightcap",
}

const PARTNER_HANDLES: Record<string, string> = {
  sam: "@lessin",
  will: "@wquist",
  yoni: "@yrechtman",
  megan: "@mmlightcap",
}

type TweetResult = {
  id: string
  text: string
  url: string
  author: string
  likes: number
  retweets: number
}

export async function generateFromVideo(
  input: string,
  partner: string
): Promise<{
  tweets: TweetResult[]
  xDraft: string
  linkedinDraft: string
  citation: string
  videoTitle: string
}> {
  // ── 1. Parse input ───────────────────────────────────────────────────────────
  let content = input
  let videoTitle = ""

  if (input.includes("drive.google.com")) {
    // Extract file ID from Drive URL
    const fileIdMatch =
      input.match(/\/d\/([a-zA-Z0-9_-]{25,})/) ||
      input.match(/[?&]id=([a-zA-Z0-9_-]{25,})/)
    const fileId = fileIdMatch?.[1] ?? null

    if (!fileId) throw new Error("Could not extract a file ID from that Drive link. Try pasting the transcript directly.")

    // Check if we already have a transcript in the DB
    const video = await prisma.videoLibrary.findFirst({
      where: { storageUrl: { contains: fileId } },
      select: { id: true, title: true, transcript: true },
    })

    if (video?.transcript) {
      content = video.transcript
      videoTitle = video.title
    } else {
      // Auto-transcribe via OpenAI Whisper
      const downloadUrl = `https://drive.usercontent.google.com/download?id=${fileId}&export=download&confirm=t`
      const fileRes = await fetch(downloadUrl)

      if (!fileRes.ok) {
        throw new Error("Could not download this Drive file. Make sure it is shared publicly (Anyone with the link). Alternatively, paste the transcript directly.")
      }

      const contentType = fileRes.headers.get("content-type") ?? ""
      const isVideo = contentType.startsWith("video/") || contentType.startsWith("audio/") ||
        /\.(mp4|mov|avi|mkv|webm|m4v|mp3|m4a|wav)$/i.test(fileRes.url)

      if (!isVideo && contentType.includes("text/html")) {
        throw new Error("Drive returned an HTML page instead of the video — the file is likely not shared publicly. Set sharing to 'Anyone with the link', or paste the transcript directly.")
      }

      // Check file size from Content-Length header (Whisper limit is 25MB)
      const contentLength = fileRes.headers.get("content-length")
      const sizeBytes = contentLength ? parseInt(contentLength) : null
      const MAX_BYTES = 24 * 1024 * 1024 // 24MB

      if (sizeBytes && sizeBytes > MAX_BYTES) {
        throw new Error(`This video is ${Math.round(sizeBytes / 1024 / 1024)}MB — too large for auto-transcription (limit is 24MB). Please paste the transcript text directly instead.`)
      }

      const arrayBuffer = await fileRes.arrayBuffer()
      const buffer = Buffer.from(arrayBuffer)

      if (buffer.byteLength > MAX_BYTES) {
        throw new Error(`This video is ${Math.round(buffer.byteLength / 1024 / 1024)}MB — too large for auto-transcription (limit is 24MB). Please paste the transcript text directly instead.`)
      }

      // Transcribe with Whisper
      const OpenAI = (await import("openai")).default
      const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

      const ext = contentType.includes("mp4") ? "mp4" : contentType.includes("webm") ? "webm" : contentType.includes("mov") ? "mov" : "mp4"
      const file = new File([buffer], `video.${ext}`, { type: contentType || "video/mp4" })

      const transcription = await openai.audio.transcriptions.create({
        model: "whisper-1",
        file,
      })

      content = transcription.text
      videoTitle = video?.title ?? "Video"

      // Save transcript back to DB if the video exists in the library
      if (video?.id) {
        await prisma.videoLibrary.update({
          where: { id: video.id },
          data: { transcript: content },
        })
      }
    }
  }

  // ── 2. Extract search keywords via Claude Haiku ───────────────────────────────
  let keywords: string[] = []
  try {
    const kwResponse = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 150,
      messages: [
        {
          role: "user",
          content: `Extract 3 short search phrases (2-4 words each) for finding relevant Twitter discussions about this content. Focus on specific topics, companies, or trends mentioned.
Content: ${content.slice(0, 800)}
Return ONLY a JSON array of strings: ["phrase1", "phrase2", "phrase3"]`,
        },
      ],
    })

    const kwText = kwResponse.content[0]
    if (kwText.type === "text") {
      const raw = kwText.text.trim().replace(/^```json\n?/, "").replace(/\n?```$/, "")
      keywords = JSON.parse(raw)
    }
  } catch {
    // Fall back to first 6 significant words
    keywords = content
      .split(/\s+/)
      .filter((w) => w.length > 3)
      .slice(0, 6)
      .reduce<string[]>((acc, w, i) => {
        if (i % 2 === 0) acc.push(w + " " + (content.split(/\s+/).filter((x) => x.length > 3)[i + 1] ?? ""))
        return acc
      }, [])
      .slice(0, 3)
  }

  // ── 3. Search Twitter for relevant tweets ────────────────────────────────────
  let tweets: TweetResult[] = []
  try {
    const bearerToken = process.env.TWITTER_BEARER_TOKEN
    if (bearerToken) {
      const allTweets: TweetResult[] = []
      const seenIds = new Set<string>()

      for (const keyword of keywords.slice(0, 3)) {
        const query = encodeURIComponent(`(${keyword}) -is:retweet lang:en min_faves:50`)
        const url = `https://api.twitter.com/2/tweets/search/recent?query=${query}&max_results=10&tweet.fields=public_metrics,text,author_id&expansions=author_id&user.fields=username,name`

        const res = await fetch(url, {
          headers: { Authorization: `Bearer ${bearerToken}` },
        })

        if (res.ok) {
          const data = await res.json()
          const users: Record<string, string> = {}

          if (data.includes?.users) {
            for (const u of data.includes.users) {
              users[u.id] = u.username
            }
          }

          if (data.data) {
            for (const tweet of data.data) {
              if (!seenIds.has(tweet.id)) {
                seenIds.add(tweet.id)
                const username = users[tweet.author_id] ?? tweet.author_id
                allTweets.push({
                  id: tweet.id,
                  text: tweet.text,
                  url: `https://twitter.com/${username}/status/${tweet.id}`,
                  author: username,
                  likes: tweet.public_metrics?.like_count ?? 0,
                  retweets: tweet.public_metrics?.retweet_count ?? 0,
                })
              }
            }
          }
        }
      }

      // Sort by engagement, take top 6
      tweets = allTweets
        .sort((a, b) => b.likes + b.retweets - (a.likes + a.retweets))
        .slice(0, 6)
    }
  } catch {
    tweets = []
  }

  // ── 4. Get partner voice samples (tweets) ────────────────────────────────────
  const voiceSamples = await prisma.partnerContent.findMany({
    where: { partner, sourceType: "tweet" },
    orderBy: { createdAt: "desc" },
    take: 8,
    select: { content: true },
  })
  const voiceExamples = voiceSamples.map((s, i) => `${i + 1}. "${s.content}"`).join("\n")

  // ── 5. Get partner long-form POV (blog, newsletter, podcast) ─────────────────
  const povContent = await prisma.partnerContent.findMany({
    where: { partner, sourceType: { in: ["blog", "newsletter", "podcast"] } },
    orderBy: { createdAt: "desc" },
    take: 5,
    select: { content: true, sourceType: true, title: true },
  })
  const povSection = povContent.length > 0
    ? povContent.map((p) => `[${p.sourceType}${p.title ? ` — ${p.title}` : ""}]\n${p.content.slice(0, 600)}`).join("\n\n")
    : ""

  // ── 6. Get past feedback ─────────────────────────────────────────────────────
  const pastFeedback = await prisma.postDraft.findMany({
    where: { feedback: { not: null } },
    orderBy: { createdAt: "desc" },
    take: 5,
    select: { feedback: true },
  })

  // ── 7. Generate X + LinkedIn drafts via Claude Sonnet ────────────────────────
  const partnerName = PARTNER_NAMES[partner] || partner
  const firstName = partnerName.split(" ")[0]
  const handle = PARTNER_HANDLES[partner] || ""

  const feedbackSection =
    pastFeedback.length > 0
      ? `Past feedback to apply:\n${pastFeedback.map((f) => `- ${f.feedback}`).join("\n")}\n`
      : ""

  const povBlock = povSection
    ? `${firstName.toUpperCase()}'S ACTUAL VIEWS AND THINKING (from their writing/podcasts — use this to understand their intellectual position, what they believe, and how they frame the world):
${povSection}

`
    : ""

  const prompt = `You are ghostwriting social posts for ${partnerName} at Slow Ventures. You must write from their specific intellectual perspective — not just their voice, but their actual worldview, opinions, and stances as reflected in their past writing. The video content is the raw material; their POV is the lens.

VIDEO CONTENT:
${content.slice(0, 4000)}

${povBlock}THEIR VOICE — match sentence structure, length, and word choice (tweets):
${voiceExamples || "(no voice samples available)"}

${feedbackSection}
YOUR JOB:
1. Read the video content and identify the single most specific, counterintuitive, or quotable claim
2. Filter it through ${firstName}'s actual intellectual position — how would THEY specifically frame this given what they believe? What angle would only they take?
3. Write both posts as ${firstName} expressing their genuine view on this, not just summarizing the video

X POST rules (under 220 characters, not counting the @handle appended separately):
- Lead with ${firstName}'s specific take — the hot opinion only they would hold
- Must name a specific company, number, or mechanism — no vague claims
- Declarative ending. No questions, no em dashes, no hashtags, no emojis
- Optimize for the X algorithm: DWELL (takes >2s to process, real density), PROFILE CLICK (first-person stakes, contrarian, makes reader want to know who said this), REPLY (contestable position — lean counterintuitive), BOOKMARK (specific number or named company prediction worth saving)
- Must feel like insider access — something the sharer looks smart for spreading, not a generic VC take
- If there's a trending tweet to quote-reply, angle the draft as a direct response to that conversation

LINKEDIN POST rules (600-900 characters):
- Line 1: One-line hook — ${firstName}'s sharpest claim, named company or number if present
- Lines 2-4: Educational expansion — explain the mechanism, not just summarize. Show the reasoning step by step in ${firstName}'s voice.
- Final line: Confident declarative conclusion — what ${firstName} actually concludes from this
- No em dashes, no hashtags, no bullet points, no questions, no partner handle (doesn't resolve on LinkedIn)
- Post stands alone — no attribution, no "watch the video" calls to action
- Audience expects substance: hook + real insight + conclusion, not a tweet padded out

Return ONLY valid JSON:
{ "twitter": "...", "linkedin": "...", "citation": "verbatim quote or key claim from content that both posts are built around" }`

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 2000,
    messages: [{ role: "user", content: prompt }],
  })

  const responseText = response.content[0]
  if (responseText.type !== "text") throw new Error("No text response from Claude")

  const raw = responseText.text.trim().replace(/^```json\n?/, "").replace(/\n?```$/, "")
  let parsed: { twitter: string; linkedin: string; citation?: string }
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error("Draft generation failed — the AI returned an unexpected format. Try again or paste the transcript as plain text.")
  }

  const strip = (t: string) => t.replace(/—/g, "-").replace(/–/g, "-")

  return {
    tweets,
    xDraft: strip(`${parsed.twitter}\n\n${handle}`),
    linkedinDraft: strip(parsed.linkedin),
    citation: parsed.citation ?? "",
    videoTitle,
  }
}

export async function saveDraft(data: {
  hook: string
  body: string
  partner: string
  citation: string
  quoteTweetUrl?: string
  quoteTweetId?: string
}) {
  return prisma.postDraft.create({
    data: {
      partner: data.partner,
      partnerCitation: data.citation,
      hook: data.hook,
      body: data.body,
      platform: "both",
      videoId: null,
      status: "pending",
      source: "video",
      quoteTweetId: data.quoteTweetId ?? null,
      quoteTweetUrl: data.quoteTweetUrl ?? null,
    },
  })
}
