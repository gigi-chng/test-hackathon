"use client"

import { useState, useEffect, useRef } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { generateClipBriefs, generateIntroClip, reviewCaptions, verifyEditorPassword, type ClipBriefDoc, type IntroClip } from "@/lib/actions/podcast"
import { FileText, Copy, Check, Lock, Clapperboard, Upload, Subtitles } from "lucide-react"

export default function PodcastToolsPage() {
  const [unlocked, setUnlocked] = useState(false)
  const [password, setPassword] = useState("")
  const [passwordError, setPasswordError] = useState(false)
  const [transcript, setTranscript] = useState("")
  const [loading, setLoading] = useState(false)
  const [introLoading, setIntroLoading] = useState(false)
  const [briefDoc, setBriefDoc] = useState<ClipBriefDoc | null>(null)
  const [introClip, setIntroClip] = useState<IntroClip | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)

  const [captionFile, setCaptionFile] = useState<{ name: string; content: string } | null>(null)
  const [captionLoading, setCaptionLoading] = useState(false)
  const [captionResult, setCaptionResult] = useState<string | null>(null)
  const [captionError, setCaptionError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (localStorage.getItem("editor_unlocked") === "true") setUnlocked(true)
  }, [])

  async function handleUnlock() {
    const ok = await verifyEditorPassword(password)
    if (ok) {
      localStorage.setItem("editor_unlocked", "true")
      setUnlocked(true)
    } else {
      setPasswordError(true)
      setPassword("")
    }
  }

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

  async function handleGenerateIntro() {
    if (!transcript.trim()) return
    setIntroLoading(true)
    setError(null)
    setIntroClip(null)
    try {
      const data = await generateIntroClip({ transcript })
      setIntroClip(data)
    } catch (e) {
      setError(`Something went wrong: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setIntroLoading(false)
    }
  }

  function copyText(text: string, id: string) {
    navigator.clipboard.writeText(text)
    setCopied(id)
    setTimeout(() => setCopied(null), 2000)
  }

  function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = (ev) => {
      setCaptionFile({ name: file.name, content: ev.target?.result as string })
      setCaptionResult(null)
      setCaptionError(null)
    }
    reader.readAsText(file)
  }

  async function handleReviewCaptions() {
    if (!captionFile) return
    setCaptionLoading(true)
    setCaptionResult(null)
    setCaptionError(null)
    try {
      const result = await reviewCaptions({ content: captionFile.content, filename: captionFile.name })
      setCaptionResult(result)
    } catch (e) {
      setCaptionError(`Something went wrong: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setCaptionLoading(false)
    }
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
      lines.push(`HOOK (0–3s):\n"${clip.hook}"\n`)
      lines.push(`CORE CLIP (${clip.duration}):\n${clip.coreClip}\n`)
      lines.push(`CATATAN EDITING:\n${clip.editingNotes.map(n => `- ${n}`).join("\n")}\n`)
      lines.push(`CTA: ${clip.ctaLine}\n`)
      lines.push(`CLIFFHANGER: ${clip.cliffhanger}\n`)
      lines.push(`Timestamp: ${clip.timestamp}\n`)
    })
    return lines.join("\n")
  }

  if (!unlocked) {
    return (
      <div className="min-h-screen flex items-center justify-center p-6">
        <Card className="w-full max-w-sm">
          <CardContent className="pt-8 pb-8 flex flex-col items-center gap-4">
            <Lock className="h-8 w-8 text-muted-foreground" />
            <div className="text-center">
              <h2 className="font-semibold text-lg">Clip Brief Generator</h2>
              <p className="text-sm text-muted-foreground mt-1">Enter the password to continue</p>
            </div>
            <div className="w-full flex flex-col gap-2">
              <input
                type="password"
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                placeholder="Password"
                value={password}
                onChange={(e) => { setPassword(e.target.value); setPasswordError(false) }}
                onKeyDown={(e) => e.key === "Enter" && handleUnlock()}
                autoFocus
              />
              {passwordError && <p className="text-xs text-destructive">Incorrect password</p>}
              <Button onClick={handleUnlock} className="w-full">Enter</Button>
            </div>
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    <div className="min-h-screen p-6 flex flex-col items-center gap-6">
      <div className="w-full max-w-3xl">
        <h1 className="text-3xl font-bold mb-1">Clip Brief Generator</h1>
        <p className="text-muted-foreground mb-6">Paste a transcript and get the top 5 Shorts briefs or a single episode intro clip.</p>

        <Card className="mb-6">
          <CardContent className="pt-6 flex flex-col gap-4">
            <textarea
              className="min-h-[220px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring resize-y"
              placeholder="Paste your full episode transcript here..."
              value={transcript}
              onChange={(e) => setTranscript(e.target.value)}
            />
            <div className="grid grid-cols-2 gap-3">
              <Button onClick={handleGenerate} disabled={loading || !transcript.trim()}>
                <FileText className={`mr-2 h-4 w-4 ${loading ? "animate-spin" : ""}`} />
                {loading ? "Analysing..." : "Top 5 Shorts Clips"}
              </Button>
              <Button onClick={handleGenerateIntro} disabled={introLoading || !transcript.trim()} variant="outline">
                <Clapperboard className={`mr-2 h-4 w-4 ${introLoading ? "animate-spin" : ""}`} />
                {introLoading ? "Finding best moment..." : "Episode Intro Clip"}
              </Button>
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
          </CardContent>
        </Card>

        {/* Intro clip result */}
        {introClip && (
          <div className="flex flex-col gap-4 mb-6">
            <div className="flex items-center justify-between">
              <p className="text-sm font-semibold">Episode Intro Clip</p>
              <Button variant="outline" size="sm" onClick={() => copyText(
                `INTRO CLIP: "${introClip.title}"\n\nHOOK (0–3s):\n"${introClip.hook}"\n\nCORE CLIP (${introClip.duration}):\n${introClip.coreClip}\n\nCATATAN EDITING:\n${introClip.editingNotes.map(n => `- ${n}`).join("\n")}\n\nCTA: ${introClip.ctaLine}\n\nKenapa ini: ${introClip.whyThisOne}\n\nTimestamp: ${introClip.timestamp}`,
                "intro-copy"
              )}>
                {copied === "intro-copy" ? <><Check className="h-3 w-3 mr-1" />Copied</> : <><Copy className="h-3 w-3 mr-1" />Copy</>}
              </Button>
            </div>

            <Card className="border-primary">
              <CardContent className="pt-5 pb-5 flex flex-col gap-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-xs text-muted-foreground mb-1">INTRO CLIP</p>
                    <p className="font-bold text-base">"{introClip.title}"</p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <Badge variant="outline">{introClip.timestamp}</Badge>
                    <Badge variant="secondary">{introClip.duration}</Badge>
                  </div>
                </div>

                <div className="bg-muted rounded-md px-4 py-3">
                  <p className="text-xs font-semibold text-muted-foreground mb-1">HOOK (0–3s)</p>
                  <p className="text-sm italic">"{introClip.hook}"</p>
                </div>

                <div>
                  <p className="text-xs font-semibold text-muted-foreground mb-2">CORE CLIP</p>
                  <pre className="whitespace-pre-wrap text-sm leading-relaxed font-sans border rounded-md px-4 py-3 bg-background">{introClip.coreClip}</pre>
                </div>

                <div>
                  <p className="text-xs font-semibold text-muted-foreground mb-2">CATATAN EDITING</p>
                  <ul className="flex flex-col gap-1.5">
                    {introClip.editingNotes.map((note, j) => (
                      <li key={j} className="text-sm flex gap-2">
                        <span className="text-muted-foreground shrink-0">–</span>
                        <span>{note}</span>
                      </li>
                    ))}
                  </ul>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div className="border rounded-md px-4 py-3">
                    <p className="text-xs font-semibold text-muted-foreground mb-1">CTA</p>
                    <p className="text-sm">{introClip.ctaLine}</p>
                  </div>
                  <div className="border rounded-md px-4 py-3 bg-blue-50 dark:bg-blue-950/20 border-blue-200 dark:border-blue-800">
                    <p className="text-xs font-semibold text-blue-700 dark:text-blue-400 mb-1">KENAPA INI?</p>
                    <p className="text-sm">{introClip.whyThisOne}</p>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>
        )}

        {/* Caption proofreader */}
        <Card className="mb-6">
          <CardContent className="pt-6 flex flex-col gap-4">
            <div>
              <h2 className="font-semibold text-base mb-1">Caption Proofreader</h2>
              <p className="text-sm text-muted-foreground">Upload a caption export (.srt, .vtt, or .txt) and get a first-pass spell check and transcription error fix.</p>
            </div>

            <input
              ref={fileInputRef}
              type="file"
              accept=".srt,.vtt,.txt"
              className="hidden"
              onChange={handleFileUpload}
            />

            <div className="flex items-center gap-3">
              <Button variant="outline" onClick={() => fileInputRef.current?.click()}>
                <Upload className="h-4 w-4 mr-2" />
                {captionFile ? captionFile.name : "Upload caption file"}
              </Button>
              {captionFile && (
                <Button onClick={handleReviewCaptions} disabled={captionLoading}>
                  <Subtitles className={`h-4 w-4 mr-2 ${captionLoading ? "animate-spin" : ""}`} />
                  {captionLoading ? "Reviewing..." : "Review captions"}
                </Button>
              )}
            </div>

            {captionError && <p className="text-sm text-destructive">{captionError}</p>}

            {captionResult && (
              <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between">
                  <p className="text-xs font-semibold text-muted-foreground">CORRECTED OUTPUT</p>
                  <Button variant="ghost" size="sm" onClick={() => copyText(captionResult, "caption-result")}>
                    {copied === "caption-result" ? <><Check className="h-3 w-3 mr-1" />Copied</> : <><Copy className="h-3 w-3 mr-1" />Copy</>}
                  </Button>
                </div>
                <pre className="whitespace-pre-wrap text-sm leading-relaxed font-mono border rounded-md px-4 py-3 bg-muted max-h-[400px] overflow-y-auto">{captionResult}</pre>
                <Button
                  variant="outline"
                  size="sm"
                  className="self-start"
                  onClick={() => {
                    const blob = new Blob([captionResult], { type: "text/plain" })
                    const url = URL.createObjectURL(blob)
                    const a = document.createElement("a")
                    a.href = url
                    a.download = captionFile ? `reviewed_${captionFile.name}` : "reviewed_captions.srt"
                    a.click()
                    URL.revokeObjectURL(url)
                  }}
                >
                  Download corrected file
                </Button>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Shorts clips */}
        {briefDoc && (
          <div className="flex flex-col gap-4">
            <div className="flex items-center justify-between">
              <p className="text-sm font-semibold">Top {briefDoc.clips.length} Shorts Clips</p>
              <Button variant="outline" size="sm" onClick={() => copyText(formatFullDoc(briefDoc), "full-doc")}>
                {copied === "full-doc" ? <><Check className="h-3 w-3 mr-1" />Copied</> : <><Copy className="h-3 w-3 mr-1" />Copy full doc</>}
              </Button>
            </div>

            {briefDoc.clips.map((clip, i) => (
              <Card key={i}>
                <CardContent className="pt-5 pb-5 flex flex-col gap-4">
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

                  <div className="bg-muted rounded-md px-4 py-3">
                    <p className="text-xs font-semibold text-muted-foreground mb-1">HOOK (0–3s)</p>
                    <p className="text-sm italic">"{clip.hook}"</p>
                  </div>

                  <div>
                    <p className="text-xs font-semibold text-muted-foreground mb-2">CORE CLIP</p>
                    <pre className="whitespace-pre-wrap text-sm leading-relaxed font-sans border rounded-md px-4 py-3 bg-background">{clip.coreClip}</pre>
                  </div>

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
