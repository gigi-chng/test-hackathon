"use server"

import OpenAI from "openai"
import { Resend } from "resend"
import { prisma } from "@/lib/db/prisma"
import { revalidatePath } from "next/cache"
import { PARTNERS } from "@/lib/partners"

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
const getResend = () => new Resend(process.env.RESEND_API_KEY)

const PROFILE_PROMPT = `You are analyzing a person's published content to build a detailed tone of voice and POV profile for use in AI content generation.

Given the content below, return a JSON object with these exact fields:
{
  "toneOfVoice": "2-3 sentences describing their tone — e.g. analytical, direct, contrarian, warm, etc.",
  "pointOfView": "3-5 sentences on their core beliefs and perspective — what they stand for, what they push back on, their intellectual framework",
  "themes": ["array", "of", "5-8", "recurring", "topics", "they", "care about"],
  "styleNotes": "2-3 sentences on their writing/speaking patterns — sentence length, vocabulary level, how they open arguments, how they close, any signature phrases or habits"
}

Be specific and concrete. Avoid generic descriptions. Ground everything in patterns you actually see in the content.`

export async function generatePartnerProfiles(): Promise<{
  updated: string[]
  skipped: string[]
  errors: string[]
}> {
  const updated: string[] = []
  const skipped: string[] = []
  const errors: string[] = []

  for (const [partnerKey, config] of Object.entries(PARTNERS)) {
    try {
      const items = await prisma.partnerContent.findMany({
        where: { partner: partnerKey },
        select: { content: true, title: true, sourceType: true, publishedAt: true },
        orderBy: [{ publishedAt: "desc" }],
        take: 200, // cap at 200 most recent items
      })

      if (items.length === 0) {
        skipped.push(partnerKey)
        continue
      }

      // Build a condensed corpus — label each piece with type + title
      const corpus = items
        .map(item => {
          const label = item.title
            ? `[${item.sourceType.toUpperCase()}] ${item.title}`
            : `[${item.sourceType.toUpperCase()}]`
          return `${label}\n${item.content.slice(0, 1500)}`
        })
        .join("\n\n---\n\n")
        .slice(0, 80000) // GPT-4o context limit guard

      const res = await openai.chat.completions.create({
        model: "gpt-4o",
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: PROFILE_PROMPT },
          {
            role: "user",
            content: `Here is all of ${config.displayName}'s published content (${items.length} items):\n\n${corpus}`,
          },
        ],
      })

      const raw = res.choices[0].message.content ?? "{}"
      const parsed = JSON.parse(raw)

      await prisma.partnerProfile.upsert({
        where: { partner: partnerKey },
        update: {
          toneOfVoice: parsed.toneOfVoice ?? "",
          pointOfView: parsed.pointOfView ?? "",
          themes: Array.isArray(parsed.themes) ? parsed.themes : [],
          styleNotes: parsed.styleNotes ?? "",
          rawProfile: raw,
          generatedAt: new Date(),
        },
        create: {
          partner: partnerKey,
          toneOfVoice: parsed.toneOfVoice ?? "",
          pointOfView: parsed.pointOfView ?? "",
          themes: Array.isArray(parsed.themes) ? parsed.themes : [],
          styleNotes: parsed.styleNotes ?? "",
          rawProfile: raw,
          generatedAt: new Date(),
        },
      })

      updated.push(partnerKey)
    } catch (err) {
      console.error(`Error generating profile for ${partnerKey}:`, err)
      errors.push(partnerKey)
    }
  }

  // Send email report
  const to = process.env.REPORT_EMAIL
  if (to && process.env.RESEND_API_KEY && updated.length > 0) {
    await getResend().emails.send({
      from: "Content Library <onboarding@resend.dev>",
      to,
      subject: `Partner profiles updated — ${updated.length} profiles regenerated`,
      html: `<p>Weekly profile generation complete.</p>
<ul>
<li><strong>Updated:</strong> ${updated.map(p => PARTNERS[p as keyof typeof PARTNERS]?.displayName ?? p).join(", ")}</li>
${skipped.length > 0 ? `<li><strong>Skipped (no content):</strong> ${skipped.join(", ")}</li>` : ""}
${errors.length > 0 ? `<li><strong>Errors:</strong> ${errors.join(", ")}</li>` : ""}
</ul>`,
    }).catch(() => {})
  }

  revalidatePath("/partner-profiles")
  return { updated, skipped, errors }
}

export async function getPartnerProfiles() {
  return prisma.partnerProfile.findMany({
    orderBy: { partner: "asc" },
  })
}
