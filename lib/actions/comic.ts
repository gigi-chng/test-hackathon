"use server"

import Anthropic from "@anthropic-ai/sdk"
import OpenAI from "openai"

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

export type Panel = {
  scene: string
  dialogue: string
}

export type ComicConcept = {
  caption: string
  panels: Panel[]
  imageUrl?: string
}

export async function generateComicConcepts(newsletterText: string): Promise<ComicConcept[]> {
  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 3000,
    messages: [
      {
        role: "user",
        content: `You are a sharp, satirical VC operator with a contrarian tone.
Your job is to turn startup / tech / venture insights into 3–5 panel comics.

Style:
- Dry, slightly ruthless, but not cringe
- Punchlines should feel inevitable, not try-hard
- Avoid generic "AI replaced jobs" jokes
- Write like someone who understands venture dynamics deeply

Output format:
- Create 3 distinct comic concepts
- Each concept = 3 panels exactly
- Each panel includes:
  - Scene description
  - Dialogue (short, realistic)
- End with a strong caption

Constraints:
- Keep each panel tight (1–2 lines max)
- No fluff, no explanations
- Each comic should highlight a specific insight or tension
- Make it feel like an inside joke for founders/investors
- Scene descriptions must be purely visual actions and expressions — no references to screens with text, whiteboards, signs, or anything with writing on it (DALL-E cannot render text)

Context:
${newsletterText}

Return ONLY valid JSON, no markdown:
[
  {
    "caption": "Strong final caption",
    "panels": [
      { "scene": "Scene description", "dialogue": "Line of dialogue" },
      { "scene": "Scene description", "dialogue": "Line of dialogue" },
      { "scene": "Scene description", "dialogue": "Line of dialogue" }
    ]
  }
]`,
      },
    ],
  })

  const text = response.content[0]
  if (text.type !== "text") throw new Error("No text response")

  const raw = text.text.trim().replace(/^```json\n?/, "").replace(/\n?```$/, "")
  return JSON.parse(raw) as ComicConcept[]
}

export async function generateStripImage(concept: ComicConcept): Promise<string> {
  const panelDescriptions = concept.panels
    .map((p, i) => `Panel ${i + 1}: ${p.scene}`)
    .join(" | ")

  const prompt = `A single cohesive 3-panel horizontal comic strip with clear dividing borders between panels. Left to right: ${panelDescriptions}. Comic style: bold black ink outlines, flat colors, consistent character design across all 3 panels, editorial cartoon aesthetic. The panels tell a sequential visual story building to a punchline. IMPORTANT: absolutely zero text, zero letters, zero words, zero numbers, zero speech bubbles, zero dialogue boxes, zero signs with writing, zero captions anywhere in the image. Pure illustration only.`

  const response = await openai.images.generate({
    model: "dall-e-3",
    prompt,
    n: 1,
    size: "1792x1024",
    quality: "standard",
    style: "vivid",
  })

  const url = response.data[0]?.url
  if (!url) throw new Error("No image URL returned")
  return url
}
