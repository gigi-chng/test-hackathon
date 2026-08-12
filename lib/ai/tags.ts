import OpenAI from "openai"

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

// Shared by every ingest path so tweets and long-form get tagged the same way.
// Lives outside lib/actions on purpose: files marked "use server" turn each
// export into a callable action, and this is an internal helper.
export async function generateTags(text: string): Promise<string[]> {
  try {
    const res = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `Extract 3-6 concise topic tags from the content. Tags should be lowercase, 1-3 words, representing key themes (e.g. "venture capital", "creator economy", "SMB", "fundraising", "product growth"). Return JSON: { "tags": ["tag1", "tag2"] }`,
        },
        { role: "user", content: text.slice(0, 3000) },
      ],
    })
    const parsed = JSON.parse(res.choices[0].message.content ?? "{}")
    return Array.isArray(parsed.tags) ? parsed.tags.map((t: string) => t.toLowerCase().trim()) : []
  } catch {
    return []
  }
}
