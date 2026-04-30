"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { generatePodcastAssets, type PodcastResults } from "@/lib/actions/podcast"
import { Sparkles, Copy, Check } from "lucide-react"

export default function PodcastToolsPage() {
  const [transcript, setTranscript] = useState("")
  const [episodeNumber, setEpisodeNumber] = useState("")
  const [loading, setLoading] = useState(false)
  const [results, setResults] = useState<PodcastResults | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<"titles" | "thumbnails" | "description" | "clips">("titles")

  async function handleGenerate() {
    if (!transcript.trim()) return
    setLoading(true)
    setError(null)
    setResults(null)
    try {
      const data = await generatePodcastAssets({ transcript, episodeNumber })
      setResults(data)
      setActiveTab("titles")
    } catch (e) {
      setError("Something went wrong. Check your API key and try again.")
      console.error(e)
    } finally {
      setLoading(false)
    }
  }

  function copyText(text: string, id: string) {
    navigator.clipboard.writeText(text)
    setCopied(id)
    setTimeout(() => setCopied(null), 2000)
  }

  const tabs = [
    { id: "titles", label: "Titles" },
    { id: "thumbnails", label: "Thumbnails" },
    { id: "description", label: "Description" },
    { id: "clips", label: "Viral Clips" },
  ] as const

  return (
    <div className="min-h-screen p-6 flex flex-col items-center gap-6">
      <div className="w-full max-w-3xl">
        <h1 className="text-3xl font-bold mb-1">Podcast Publishing Toolkit</h1>
        <p className="text-muted-foreground mb-6">Paste your transcript and get titles, thumbnails, descriptions, and viral clips — instantly.</p>

        {/* Input form */}
        <Card className="mb-6">
          <CardContent className="pt-6 flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="ep">Episode #</Label>
              <Input id="ep" placeholder="e.g. 47" value={episodeNumber} onChange={(e) => setEpisodeNumber(e.target.value)} className="max-w-[160px]" />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="transcript">Transcript</Label>
              <textarea
                id="transcript"
                className="min-h-[180px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring resize-y"
                placeholder="Paste your full episode transcript here..."
                value={transcript}
                onChange={(e) => setTranscript(e.target.value)}
              />
            </div>
            <Button onClick={handleGenerate} disabled={loading || !transcript.trim()} className="w-full">
              <Sparkles className={`mr-2 h-4 w-4 ${loading ? "animate-spin" : ""}`} />
              {loading ? "Generating assets..." : "Generate All Assets"}
            </Button>
            {error && <p className="text-sm text-destructive">{error}</p>}
          </CardContent>
        </Card>

        {/* Results */}
        {results && (
          <div className="flex flex-col gap-4">
            {/* Tabs */}
            <div className="flex gap-2 border-b pb-2">
              {tabs.map((tab) => (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={`px-4 py-1.5 rounded-md text-sm font-medium transition-colors ${
                    activeTab === tab.id
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>

            {/* Titles tab */}
            {activeTab === "titles" && (
              <div className="flex flex-col gap-3">
                <p className="text-sm text-muted-foreground">8 title formats modelled on Freakonomics, Planet Money & More or Less. Click to copy.</p>
                {results.titles.map((t, i) => (
                  <Card key={i} className="cursor-pointer hover:border-primary transition-colors" onClick={() => copyText(t.title, `title-${i}`)}>
                    <CardContent className="py-3 px-4 flex items-center justify-between gap-3">
                      <div className="flex flex-col gap-1">
                        <p className="font-medium">{t.title}</p>
                        <Badge variant="secondary" className="w-fit text-xs">{t.format}</Badge>
                      </div>
                      {copied === `title-${i}` ? <Check className="h-4 w-4 text-green-500 shrink-0" /> : <Copy className="h-4 w-4 text-muted-foreground shrink-0" />}
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}

            {/* Thumbnails tab */}
            {activeTab === "thumbnails" && (
              <div className="flex flex-col gap-4">
                <p className="text-sm text-muted-foreground">3 thumbnail text options per title — stat, question, bold claim. Click to copy.</p>
                {results.thumbnails.map((group, i) => (
                  <Card key={i}>
                    <CardHeader className="pb-2 pt-4">
                      <CardTitle className="text-sm font-normal text-muted-foreground">{group.title}</CardTitle>
                    </CardHeader>
                    <CardContent className="flex flex-wrap gap-2 pb-4">
                      {group.options.map((opt, j) => (
                        <button
                          key={j}
                          onClick={() => copyText(opt, `thumb-${i}-${j}`)}
                          className="flex items-center gap-1.5 px-3 py-1.5 rounded-md border text-sm font-bold hover:border-primary transition-colors"
                        >
                          {opt}
                          {copied === `thumb-${i}-${j}` ? <Check className="h-3 w-3 text-green-500" /> : <Copy className="h-3 w-3 text-muted-foreground" />}
                        </button>
                      ))}
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}

            {/* Description tab */}
            {activeTab === "description" && (
              <Card>
                <CardContent className="pt-4 flex flex-col gap-3">
                  <div className="flex justify-between items-center">
                    <p className="text-sm text-muted-foreground">YouTube / Spotify description with chapters</p>
                    <Button variant="outline" size="sm" onClick={() => copyText(results.description, "desc")}>
                      {copied === "desc" ? <><Check className="h-3 w-3 mr-1" /> Copied</> : <><Copy className="h-3 w-3 mr-1" /> Copy all</>}
                    </Button>
                  </div>
                  <pre className="whitespace-pre-wrap text-sm bg-muted rounded-md p-4 font-mono leading-relaxed">{results.description}</pre>
                </CardContent>
              </Card>
            )}

            {/* Clips tab */}
            {activeTab === "clips" && (
              <div className="flex flex-col gap-3">
                <p className="text-sm text-muted-foreground">Top 5 moments with the highest viral potential.</p>
                {results.clips.map((clip, i) => (
                  <Card key={i}>
                    <CardContent className="pt-4 pb-4 flex flex-col gap-2">
                      <div className="flex items-center justify-between">
                        <Badge variant="outline">{clip.timestamp}</Badge>
                        <button onClick={() => copyText(clip.suggestedTitle, `clip-${i}`)} className="text-muted-foreground hover:text-foreground">
                          {copied === `clip-${i}` ? <Check className="h-4 w-4 text-green-500" /> : <Copy className="h-4 w-4" />}
                        </button>
                      </div>
                      <p className="font-semibold text-sm">{clip.suggestedTitle}</p>
                      <p className="text-sm text-muted-foreground italic">"{clip.quote}"</p>
                      <p className="text-xs text-muted-foreground border-t pt-2">{clip.reason}</p>
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
