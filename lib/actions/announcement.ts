"use server"

import Anthropic from "@anthropic-ai/sdk"
import { prisma } from "@/lib/db/prisma"

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

export async function generateAnnouncementPosts(pressRelease: string): Promise<{ twitter: string; linkedin: string }> {
  const response = await anthropic.messages.create({
    model: "claude-sonnet-5",
    max_tokens: 8000,
    messages: [
      {
        role: "user",
        content: `You are writing investment announcement posts for Slow Ventures. Based on the data from their best-performing posts, follow this exact structure.

PRESS RELEASE:
${pressRelease}

---

Write TWO posts announcing this investment.

TWITTER (under 260 characters):
- Open with a sharp contrarian belief or market observation — not "we're excited to announce"
- Name the company and a specific traction number or data point
- Declarative, confident ending — no questions
- No em dashes, no hashtags, no emojis

LINKEDIN (600-900 characters):
Follow this structure exactly — it's what performs best for Slow Ventures:

Line 1: One sharp hook — a contrarian belief or market observation that sets up why this company exists. Name the company.

Lines 2-3: The problem in concrete terms. What's broken, who's affected, why now.

Lines 4-5: Founder story — specific origin detail, what they built before raising, why they're the right person.

Line 6: Traction numbers — be precise. Specific revenue, user counts, growth rates from the press release.

Final line: Why this company wins from here. A declarative prediction, not a question.

Hard rules for both:
- No "we're excited/proud/thrilled to announce"
- No em dashes
- No questions
- No bullet points on LinkedIn
- Use specific numbers from the press release — never round them

Return ONLY valid JSON:
{ "twitter": "...", "linkedin": "..." }`,
      },
    ],
  })

  const text = response.content[0]
  if (text.type !== "text") throw new Error("No text response")
  const raw = text.text.trim().replace(/^```json\n?/, "").replace(/\n?```$/, "")
  return JSON.parse(raw)
}

export async function postAnnouncementNow(
  twitter: string,
  linkedin: string,
  platform: "both" | "twitter" | "linkedin"
): Promise<void> {
  await prisma.postDraft.create({
    data: {
      partner: "slow",
      partnerCitation: "",
      hook: twitter,
      body: linkedin,
      platform,
      source: "announcement",
      status: "approved",
    },
  })
}

export async function scheduleAnnouncement(
  twitter: string,
  linkedin: string,
  platform: "both" | "twitter" | "linkedin",
  scheduledAt: Date
): Promise<void> {
  await prisma.postDraft.create({
    data: {
      partner: "slow",
      partnerCitation: "",
      hook: twitter,
      body: linkedin,
      platform,
      source: "announcement",
      status: "scheduled",
      scheduledAt,
    },
  })

}
