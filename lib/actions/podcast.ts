"use server"

import Anthropic from "@anthropic-ai/sdk"

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

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
