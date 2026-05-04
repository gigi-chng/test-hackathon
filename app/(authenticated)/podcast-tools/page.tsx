"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { generateClipBriefs, type ClipBriefDoc } from "@/lib/actions/podcast"
import { FileText, Copy, Check } from "lucide-react"

export default function PodcastToolsPage() {
  const [transcript, setTranscript] = useState("")
  const [loading, setLoading] = useState(false)
  const [briefDoc, setBriefDoc] = useState<ClipBriefDoc | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)

  async function handleGenerate() {
    if (!transcript.trim()) return
    setLoading(true)
    setError(null)
    setBriefDoc(null)
    try {
      const data = await generateClipBriefs({ transcript, episodeName: "Podcast", speakers: "" })
      setBriefDoc(data)
    } catch (e) {
      setError(`Something went wrong: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setLoading(false)
    }
  }

  function copyText(text: string, id: string) {
    navigator.clipboard.writeText(text)
    setCopied(id)
    setTimeout(() => setCopied(null), 2000)
  }

  function formatFullDoc(doc: ClipBriefDoc): string {
    const lines: string[] = []
    lines.push(`CLIP RECOMMENDATIONS`)
    lines.push(`Generated: ${doc.generatedDate}`)
    lines.push("")

    doc.clips.forEach((clip, i) => {
      const border = "═".repeat(51)
      lines.push(border)
      lines.push(`CLIP ${i + 1}: "${clip.title}"`)
      lines.push(border)
      lines.push("")
      lines.push(`HOOK (0–3s):`)
      lines.push(`"${clip.hook}"`)
      lines.push("")
      lines.push(`CORE CLIP (${clip.duration}):`)
      lines.push(clip.coreClip)
      lines.push("")
      lines.push(`CATATAN EDITING:`)
      clip.editingNotes.forEach((note) => lines.push(`- ${note}`))
      lines.push("")
      lines.push(`CTA (3 detik terakhir):`)
      lines.push(clip.ctaLine)
      lines.push("")
      lines.push(`CLIFFHANGER:`)
      lines.push(clip.cliffhanger)
      lines.push("")
      lines.push(`Timestamp: ${clip.timestamp}`)
      lines.push("")
    })

    return lines.join("\n")
  }

  return (
    <div className="min-h-screen p-6 flex flex-col items-center gap-6">
      <div className="w-full max-w-3xl">
        <h1 className="text-3xl font-bold mb-1">Clip Brief Generator</h1>
        <p className="text-muted-foreground mb-6">Paste a transcript and get the top 5 YouTube Shorts-optimized clip briefs for your editor.</p>

        <Card className="mb-6">
          <CardContent className="pt-6 flex flex-col gap-4">
            <textarea
              className="min-h-[220px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring resize-y"
              placeholder="Paste your full episode transcript here..."
              value={transcript}
              onChange={(e) => setTranscript(e.target.value)}
            />
            <Button onClick={handleGenerate} disabled={loading || !transcript.trim()}>
              <FileText className={`mr-2 h-4 w-4 ${loading ? "animate-spin" : ""}`} />
              {loading ? "Analysing transcript..." : "Generate Clip Briefs"}
            </Button>
            {error && <p className="text-sm text-destructive">{error}</p>}
          </CardContent>
        </Card>

        {briefDoc && (
          <div className="flex flex-col gap-4">
            <div className="flex items-center justify-between">
              <p className="text-sm text-muted-foreground">Top {briefDoc.clips.length} clips — ranked by Shorts performance</p>
              <Button variant="outline" size="sm" onClick={() => copyText(formatFullDoc(briefDoc), "full-doc")}>
                {copied === "full-doc" ? <><Check className="h-3 w-3 mr-1" />Copied</> : <><Copy className="h-3 w-3 mr-1" />Copy full doc</>}
              </Button>
            </div>

            {briefDoc.clips.map((clip, i) => (
              <Card key={i}>
                <CardContent className="pt-5 pb-5 flex flex-col gap-4">

                  {/* Header */}
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-xs text-muted-foreground mb-1">CLIP {i + 1}</p>
                      <p className="font-bold text-base">"{clip.title}"</p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <Badge variant="outline">{clip.timestamp}</Badge>
                      <Badge variant="secondary">{clip.duration}</Badge>
                    </div>
                  </div>

                  {/* Hook */}
                  <div className="bg-muted rounded-md px-4 py-3">
                    <p className="text-xs font-semibold text-muted-foreground mb-1">HOOK (0–3s)</p>
                    <p className="text-sm italic">"{clip.hook}"</p>
                  </div>

                  {/* Core clip */}
                  <div>
                    <p className="text-xs font-semibold text-muted-foreground mb-2">CORE CLIP</p>
                    <pre className="whitespace-pre-wrap text-sm leading-relaxed font-sans border rounded-md px-4 py-3 bg-background">{clip.coreClip}</pre>
                  </div>

                  {/* Editing notes */}
                  <div>
                    <p className="text-xs font-semibold text-muted-foreground mb-2">CATATAN EDITING</p>
                    <ul className="flex flex-col gap-1.5">
                      {clip.editingNotes.map((note, j) => (
                        <li key={j} className="text-sm flex gap-2">
                          <span className="text-muted-foreground shrink-0">–</span>
                          <span>{note}</span>
                        </li>
                      ))}
                    </ul>
                  </div>

                  {/* CTA + Cliffhanger */}
                  <div className="grid grid-cols-2 gap-3">
                    <div className="border rounded-md px-4 py-3">
                      <p className="text-xs font-semibold text-muted-foreground mb-1">CTA (3 DETIK TERAKHIR)</p>
                      <p className="text-sm">{clip.ctaLine}</p>
                    </div>
                    <div className="border rounded-md px-4 py-3 bg-amber-50 dark:bg-amber-950/20 border-amber-200 dark:border-amber-800">
                      <p className="text-xs font-semibold text-amber-700 dark:text-amber-400 mb-1">CLIFFHANGER</p>
                      <p className="text-sm">{clip.cliffhanger}</p>
                    </div>
                  </div>

                  {/* Copy button */}
                  <Button
                    variant="ghost"
                    size="sm"
                    className="self-end"
                    onClick={() => {
                      const text = `CLIP ${i + 1}: "${clip.title}"\n\nHOOK (0–3s):\n"${clip.hook}"\n\nCORE CLIP (${clip.duration}):\n${clip.coreClip}\n\nCATATAN EDITING:\n${clip.editingNotes.map(n => `- ${n}`).join("\n")}\n\nCTA: ${clip.ctaLine}\n\nCLIFFHANGER: ${clip.cliffhanger}\n\nTimestamp: ${clip.timestamp}`
                      copyText(text, `brief-${i}`)
                    }}
                  >
                    {copied === `brief-${i}` ? <><Check className="h-3 w-3 mr-1" />Copied</> : <><Copy className="h-3 w-3 mr-1" />Copy clip</>}
                  </Button>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
