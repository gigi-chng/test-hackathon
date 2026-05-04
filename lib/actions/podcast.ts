"use server"

import Anthropic from "@anthropic-ai/sdk"

export async function verifyEditorPassword(password: string): Promise<boolean> {
  return password === process.env.EDITOR_PASSWORD
}

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

export type ClipBrief = {
  title: string
  hook: string
  coreClip: string
  editingNotes: string[]
  ctaLine: string
  cliffhanger: string
  timestamp: string
  duration: string
}

export type ClipBriefDoc = {
  episodeName: string
  generatedDate: string
  speakers: string[]
  clips: ClipBrief[]
}

async function fetchTrendingHeadlines(): Promise<string[]> {
  const apiKey = process.env.NEWS_API_KEY
  if (!apiKey) return []

  const queries = ["venture capital", "AI startup", "tech founder", "artificial intelligence"]
  const headlines: string[] = []
  const seen = new Set<string>()

  for (const q of queries) {
    const url = `https://newsapi.org/v2/everything?q=${encodeURIComponent(q)}&sortBy=publishedAt&pageSize=5&language=en&apiKey=${apiKey}`
    const res = await fetch(url, { next: { revalidate: 0 } })
    const data = await res.json()
    if (data.articles) {
      for (const a of data.articles) {
        if (!a.title || a.title === "[Removed]" || seen.has(a.title)) continue
        seen.add(a.title)
        headlines.push(a.title)
      }
    }
  }

  return headlines.slice(0, 15)
}

export async function generateClipBriefs(input: {
  transcript: string
  episodeName: string
  speakers: string
}): Promise<ClipBriefDoc> {
  const { transcript, episodeName, speakers } = input

  const today = new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })
  const headlines = await fetchTrendingHeadlines()
  const headlinesSection = headlines.length > 0
    ? `\nTODAY'S TRENDING NEWS (use this to prioritize clips that connect to what's happening right now):\n${headlines.map((h, i) => `${i + 1}. ${h}`).join("\n")}\n`
    : ""

  const prompt = `You are a YouTube Shorts producer for a podcast. Your job is to find the TOP 5 moments from this transcript that will perform best as Shorts — and write a production brief for each that a video editor can execute directly.

Your two goals for every clip:
1. STOP THE SCROLL — the hook must work within 2 seconds with zero context
2. DRIVE TO THE FULL EPISODE — the clip should leave the viewer wanting more, not satisfied

YOUTUBE SHORTS PERFORMANCE RULES:
- Hook works in 1–2 seconds or the viewer is gone
- Ideal length: 30–59 seconds. Never over 60s.
- Every clip needs a clear arc: setup → tension → payoff OR setup → tension → cliffhanger (cut before the answer)
- Cliffhanger endings outperform resolved endings for driving full-episode clicks
- Controversy, counterintuitive takes, and strong opinions drive comments = more distribution
- Re-watch value: a stat, a reversal, or a line people want to send to someone
- Vertical format: note when to cut to close-up reactions or faces
- SELF-CONTAINED: the clip must make complete sense to someone who has never heard of this podcast, these speakers, or this topic. No assumed context. If a clip references something discussed earlier in the episode, either exclude it or note in editing notes what on-screen text is needed to give viewers the context they need.

Speakers: ${speakers}
${headlinesSection}
TRANSCRIPT:
${transcript}

---

For each clip produce:

1. TITLE — ALL CAPS, max 8 words. The sharpest possible description of the moment.

2. HOOK — Exact quote from transcript (0–3s). Must work as a standalone sentence with no context. This is what appears on screen as the first thing viewers read/hear.

3. CORE CLIP — Verbatim transcript excerpt, 30–59 seconds. Include speaker names. This is what the editor cuts to.

4. EDITING NOTES — 5–6 production instructions written in Indonesian. Cover: on-screen text, words to highlight, pacing, close-up moments, where to cut, and how to end the clip. Always note which trending news story this connects to if relevant.

5. CTA LINE — Written in Indonesian. A single instruction for the editor describing what text to show on screen in the final 3 seconds to drive viewers to the full episode. Should create urgency or curiosity. Example: "Tampilkan teks: 'Argumen ini makin dalam di episode penuh. Link di bio.'"

6. CLIFFHANGER — Written in Indonesian. If the clip can be cut 5–10 seconds early to leave something unresolved, describe exactly where to cut and what question it leaves the viewer with. Example: "Potong setelah Sam bilang '...dan itulah masalahnya' — penonton penasaran apa solusinya."

7. TIMESTAMP — Estimated position in episode (e.g. "~7:30–9:00").

8. DURATION — Estimated clip length (e.g. "~45s").

SELECTION CRITERIA — rank exactly 5 clips by Shorts potential. Prioritize:
1. SELF-CONTAINED — the clip makes complete sense with zero prior context. Disqualify any moment that requires knowing what was said earlier in the episode unless the editing notes can fix it with on-screen text.
2. TIMELY — connects to today's trending news. Algorithm boosts timely content.
3. HOOK STRENGTH — opening line needs zero setup
4. CLIFFHANGER POTENTIAL — moments where cutting early creates irresistible curiosity
5. TENSION/SURPRISE — stat, reversal, or disagreement that stops scrolling
6. SHAREABILITY — the clip someone sends to a friend

Only include clips under 60 seconds. If a great moment runs long, note exactly where to cut it.

Return ONLY valid JSON:
{
  "clips": [
    {
      "title": "CLIP TITLE IN ALL CAPS",
      "hook": "Exact opening line from transcript",
      "coreClip": "Full verbatim transcript excerpt...",
      "editingNotes": ["catatan 1", "catatan 2", "catatan 3", "catatan 4", "catatan 5"],
      "ctaLine": "Single line driving to full episode",
      "cliffhanger": "Cut at [exact moment] — leaves viewer wondering [what question]",
      "timestamp": "~7:30–9:00",
      "duration": "~45s"
    }
  ]
}`

  const response = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 6000,
    messages: [{ role: "user", content: prompt }],
  })

  const textBlock = response.content.find((b) => b.type === "text")
  if (!textBlock || textBlock.type !== "text") throw new Error("No text response")

  const raw = textBlock.text.trim().replace(/^```json\n?/, "").replace(/\n?```$/, "")
  const parsed = JSON.parse(raw)

  const speakerList = speakers.split(",").map((s: string) => s.trim()).filter(Boolean)

  return {
    episodeName,
    generatedDate: today,
    speakers: speakerList,
    clips: parsed.clips,
  }
}

export type PodcastResults = {
  titles: { title: string; format: string }[]
  thumbnails: { title: string; options: string[] }[]
  description: string
  clips: { timestamp: string; quote: string; reason: string; suggestedTitle: string }[]
}

export async function generatePodcastAssets(input: {
  transcript: string
  episodeNumber: string
}): Promise<PodcastResults> {
  const { transcript, episodeNumber } = input

  const prompt = `You are an expert YouTube and podcast growth strategist who specialises in the smart/educational podcast genre — shows like More or Less (BBC), Freakonomics, Planet Money, Hidden Brain, and Cautionary Tales. You deeply understand what drives clicks and shares in this genre.

Analyse this podcast transcript and generate publish-ready assets modelled on the title and thumbnail strategies of those top-performing shows.

Episode: #${episodeNumber}

IMPORTANT: Extract the guest name(s), host name, and episode topic directly from the transcript — do not ask for them. They will be mentioned in the conversation.

TRANSCRIPT:
${transcript}

---

TITLE STRATEGY (mirror top educational podcasts):
These 8 formats consistently outperform in the smart/educational genre. Generate one title per format:

1. "question" — "Why does X actually happen?" style. Poses a clear question the episode answers. (e.g. "Why Does the Richest Country in the World Have So Many Poor Kids?")
2. "contrarian take" — Challenges conventional wisdom. Makes the listener feel the host knows something they don't. (e.g. "Are Personal Finance Gurus Giving You Bad Advice?")
3. "hidden story" — "The untold/hidden/real story of X." Signals insider knowledge. (e.g. "The Hidden Side of Everything", "Flight 901: The Untold Story")
4. "specific number" — Lead with a precise stat or data point from the transcript. Precision beats round numbers. (e.g. "How a 170% Price Spike Changed Everything", "The $10,847 Problem Nobody Talks About")
5. "curiosity gap" — An unexpected juxtaposition that creates an information void. (e.g. "The Purpose of Depression", "The Ethics of Honesty")
6. "person + economic angle" — Specific person/group + surprising behavioural or economic insight. (e.g. "Subaru's Brilliant Strategy to Embrace the Lesbian Stereotype", "What Stadium Vendors Reveal About the Economy")
7. "power word hook" — Uses words like: Shocking, Secret, Proven, Exposed, Revealed, Myth. Keep it credible — this genre rewards specificity not clickbait. (e.g. "The Shocking Truth About Irish Pub Architecture")
8. "compression" — Big concept, small time. Signals efficiency to professional audiences. (e.g. "30 Years of Housing Policy in 30 Minutes", "Everything Wrong With GDP in One Episode")

TITLE RULES:
- 50-60 characters ideal (70 max — mobile truncates beyond this)
- First 3-5 words carry most weight — put the hook early
- Use real, specific details from the transcript — never generic
- Precision beats vagueness: "$10,847" beats "$10,000"; "3 in 5 economists" beats "most economists"
- Do NOT use the guest's name in every title — use it only when it adds credibility or is recognisable

---

THUMBNAIL TEXT STRATEGY (mirror More or Less / Freakonomics / Hidden Brain style):
- Max 3-5 words, ideally under 12 characters total
- Works as a standalone provocation — someone reading just the thumbnail text should feel curious
- Best performing patterns in this genre:
  * Large statistics: "170% MORE", "3 IN 5", "$47 BILLION"
  * Contrarian one-liners: "THEY LIED", "IT'S FAKE", "YOU'RE WRONG"
  * Short interrogatives: "WHY?", "REALLY?", "WHO DECIDES?"
  * Action/reveal words: "EXPOSED", "REVEALED", "THE TRUTH"
  * Surprising adjectives: "HIDDEN", "BROKEN", "RIGGED"
- All caps works well in this genre
- Each title should get 3 different thumbnail text options (different angles: stat, question, claim)

---

Generate the following in valid JSON format with exactly this structure:

{
  "titles": [
    { "title": "...", "format": "question" },
    { "title": "...", "format": "contrarian take" },
    { "title": "...", "format": "hidden story" },
    { "title": "...", "format": "specific number" },
    { "title": "...", "format": "curiosity gap" },
    { "title": "...", "format": "person + economic angle" },
    { "title": "...", "format": "power word hook" },
    { "title": "...", "format": "compression" }
  ],
  "thumbnails": [
    {
      "title": "<copy exact title here>",
      "options": ["STAT OR NUMBER", "SHORT QUESTION?", "BOLD CLAIM"]
    }
  ],
  "description": "Full YouTube/Spotify description: 3-5 sentence intro that hooks (mention guest name, the surprising claim or stat, and why it matters), then chapters as:\\n00:00 Intro\\n02:30 ...\\netc, then a subscribe/follow call to action",
  "clips": [
    {
      "timestamp": "12:34",
      "quote": "Exact quote or close paraphrase — the most punchy version",
      "reason": "Specific reason this would go viral on TikTok/Reels/Shorts — reference the emotion, surprise, or insight",
      "suggestedTitle": "Hook caption written like a social post (not a YouTube title)"
    }
  ]
}

CLIP SELECTION RULES — pick the 5 moments that have:
- A surprising stat or counterintuitive fact stated plainly
- A moment of genuine disagreement or strong opinion
- An analogy or story that makes something complex click instantly
- A confession, admission, or "I was wrong about this" moment
- The single best quotable line in the whole episode

Return ONLY the JSON. No markdown fences, no explanation.`

  const response = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 4000,
    messages: [{ role: "user", content: prompt }],
  })

  // Extract text from response
  const textBlock = response.content.find((b) => b.type === "text")
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("No text response from Claude")
  }

  // Parse JSON - strip markdown fences if present
  const raw = textBlock.text.trim().replace(/^```json\n?/, "").replace(/\n?```$/, "")
  return JSON.parse(raw) as PodcastResults
}
