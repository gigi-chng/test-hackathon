"use client"

import { useState, useEffect, useTransition } from "react"
import Link from "next/link"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Card } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import {
  ArrowLeft, Users, Loader2, Trash2, AlertTriangle, CheckCircle2, FileText,
} from "lucide-react"
import {
  detectSpeakers, ingestTranscript, listTranscripts, deleteTranscript,
  type DetectedSpeaker,
} from "@/lib/actions/transcripts"

const PARTNER_KEYS = ["sam", "will", "yoni", "megan"] as const
const PARTNER_NAMES: Record<string, string> = {
  sam: "Sam Lessin", will: "Will Quist", yoni: "Yoni Rechtman", megan: "Megan Lightcap",
}
const SOURCES = [
  { value: "more-or-less", label: "More or Less episode" },
  { value: "partner-meeting", label: "Partner meeting" },
  { value: "internal", label: "Internal call" },
  { value: "other", label: "Other" },
]

type Row = Awaited<ReturnType<typeof listTranscripts>>[number]

export default function TranscriptsPage() {
  const [title, setTitle] = useState("")
  const [source, setSource] = useState("more-or-less")
  const [recordedAt, setRecordedAt] = useState("")
  const [rawText, setRawText] = useState("")

  const [speakers, setSpeakers] = useState<DetectedSpeaker[] | null>(null)
  const [unlabeled, setUnlabeled] = useState(false)
  const [map, setMap] = useState<Record<string, string>>({})
  const [result, setResult] = useState<{ stored: Record<string, number>; skipped: string[] } | null>(null)
  const [rows, setRows] = useState<Row[]>([])
  const [pending, start] = useTransition()
  const [analyzing, setAnalyzing] = useState(false)

  useEffect(() => { listTranscripts().then(setRows) }, [])

  async function analyze() {
    if (!rawText.trim()) return
    setAnalyzing(true)
    setResult(null)
    const res = await detectSpeakers(rawText)
    setSpeakers(res.speakers)
    setUnlabeled(res.unlabeled)
    // Pre-fill only the confident matches; a human still confirms each one.
    const seeded: Record<string, string> = {}
    for (const s of res.speakers) {
      if (s.suggested && !Object.values(seeded).includes(s.label)) seeded[s.suggested] = s.label
    }
    setMap(seeded)
    setAnalyzing(false)
  }

  function save() {
    start(async () => {
      const res = await ingestTranscript({ title, source, recordedAt: recordedAt || undefined, rawText, speakerMap: map })
      setResult({ stored: res.stored, skipped: res.skipped })
      setRows(await listTranscripts())
      setTitle(""); setRawText(""); setRecordedAt(""); setSpeakers(null); setMap({})
    })
  }

  const mapped = Object.entries(map).filter(([, v]) => v)

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-4xl mx-auto px-6 py-10">
        <Link href="/" className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground mb-6">
          <ArrowLeft className="h-4 w-4" /> Back
        </Link>

        <div className="mb-8">
          <h1 className="text-2xl font-semibold tracking-tight">Transcripts</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Drop in a team recording. Each partner&apos;s spoken segments are split out and added to
            their own library, so their quotes and points of view feed the voice profiles.
          </p>
        </div>

        <Card className="p-6 space-y-5">
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="sm:col-span-2 space-y-2">
              <Label htmlFor="title">Title</Label>
              <Input id="title" value={title} onChange={e => setTitle(e.target.value)}
                placeholder="More or Less Ep 162 — Sam and Friends" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="date">Recorded</Label>
              <Input id="date" type="date" value={recordedAt} onChange={e => setRecordedAt(e.target.value)} />
            </div>
          </div>

          <div className="space-y-2">
            <Label>Source</Label>
            <div className="flex flex-wrap gap-2">
              {SOURCES.map(s => (
                <Button key={s.value} type="button" size="sm"
                  variant={source === s.value ? "default" : "outline"}
                  onClick={() => setSource(s.value)}>{s.label}</Button>
              ))}
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="raw">Transcript</Label>
            <Textarea id="raw" value={rawText} onChange={e => { setRawText(e.target.value); setSpeakers(null) }}
              placeholder={"Paste the transcript. Speaker labels in either shape work:\n\nSam Lessin (00:04.21)\nThe thing about this is...\n\nor\n\nSam Lessin: The thing about this is..."}
              className="min-h-56 font-mono text-xs" />
            <p className="text-xs text-muted-foreground">
              {rawText ? `${rawText.split(/\s+/).filter(Boolean).length.toLocaleString()} words` : " "}
            </p>
          </div>

          <Button onClick={analyze} disabled={!rawText.trim() || analyzing} variant="secondary">
            {analyzing ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Reading</> : <><Users className="h-4 w-4 mr-2" />Find speakers</>}
          </Button>

          {unlabeled && (
            <div className="flex gap-3 rounded-md border border-amber-500/40 bg-amber-500/5 p-4 text-sm">
              <AlertTriangle className="h-4 w-4 text-amber-600 shrink-0 mt-0.5" />
              <div>
                <p className="font-medium">No speaker labels found</p>
                <p className="text-muted-foreground mt-1">
                  This looks like a plain transcript — a Whisper SRT, for example. Whisper doesn&apos;t
                  identify speakers, so there&apos;s no way to tell who said what. Use an export that
                  includes names, or add them before pasting.
                </p>
              </div>
            </div>
          )}

          {speakers && speakers.length > 0 && (
            <div className="space-y-3 border-t pt-5">
              <div>
                <p className="text-sm font-medium">Who is who</p>
                <p className="text-xs text-muted-foreground mt-1">
                  Only mapped speakers are stored. Leave a partner blank if they aren&apos;t in this
                  recording — a wrong mapping puts someone else&apos;s words in their library.
                </p>
              </div>

              {PARTNER_KEYS.map(p => (
                <div key={p} className="grid grid-cols-3 gap-3 items-center">
                  <Label className="text-sm">{PARTNER_NAMES[p]}</Label>
                  <select
                    className="col-span-2 h-9 rounded-md border border-input bg-background px-3 text-sm"
                    value={map[p] ?? ""}
                    onChange={e => setMap({ ...map, [p]: e.target.value })}
                  >
                    <option value="">Not in this recording</option>
                    {speakers.map(s => (
                      <option key={s.label} value={s.label}>
                        {s.label} — {s.words.toLocaleString()} words
                      </option>
                    ))}
                  </select>
                </div>
              ))}

              <details className="text-xs text-muted-foreground">
                <summary className="cursor-pointer">Detected {speakers.length} speakers</summary>
                <ul className="mt-2 space-y-1.5">
                  {speakers.map(s => (
                    <li key={s.label}>
                      <span className="font-medium text-foreground">{s.label}</span>
                      {" · "}{s.words.toLocaleString()} words
                      <div className="italic opacity-75">&ldquo;{s.sample}&hellip;&rdquo;</div>
                    </li>
                  ))}
                </ul>
              </details>

              <Button onClick={save} disabled={!title.trim() || mapped.length === 0 || pending}>
                {pending
                  ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Extracting</>
                  : `Add to ${mapped.length} partner ${mapped.length === 1 ? "library" : "libraries"}`}
              </Button>
            </div>
          )}

          {result && (
            <div className="flex gap-3 rounded-md border border-emerald-500/40 bg-emerald-500/5 p-4 text-sm">
              <CheckCircle2 className="h-4 w-4 text-emerald-600 shrink-0 mt-0.5" />
              <div>
                <p className="font-medium">Saved</p>
                <ul className="text-muted-foreground mt-1 space-y-0.5">
                  {Object.entries(result.stored).map(([p, n]) => (
                    <li key={p}>{PARTNER_NAMES[p]}: {n} passage{n === 1 ? "" : "s"} added</li>
                  ))}
                  {result.skipped.map(s => <li key={s} className="text-amber-600">{s}</li>)}
                </ul>
              </div>
            </div>
          )}
        </Card>

        <div className="mt-10">
          <h2 className="text-sm font-medium mb-3">Saved transcripts</h2>
          {rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nothing yet.</p>
          ) : (
            <div className="space-y-2">
              {rows.map(r => (
                <Card key={r.id} className="p-4 flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
                      <span className="font-medium text-sm truncate">{r.title}</span>
                      <Badge variant="secondary" className="text-xs">{r.source}</Badge>
                    </div>
                    <p className="text-xs text-muted-foreground mt-1.5">
                      {r.recordedAt ? new Date(r.recordedAt).toLocaleDateString() : "no date"}
                      {" · "}{r.participants.length} speakers
                      {" · "}{r.segmentCount} passage{r.segmentCount === 1 ? "" : "s"} extracted
                    </p>
                    {r.speakerMap && (
                      <p className="text-xs text-muted-foreground mt-1">
                        {Object.entries(r.speakerMap as Record<string, string>)
                          .filter(([, v]) => v)
                          .map(([p, v]) => `${PARTNER_NAMES[p] ?? p} = ${v}`)
                          .join(" · ")}
                      </p>
                    )}
                  </div>
                  <Button variant="ghost" size="sm"
                    onClick={() => start(async () => { await deleteTranscript(r.id); setRows(await listTranscripts()) })}
                    title="Delete transcript and everything it added to the partner libraries">
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </Card>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
