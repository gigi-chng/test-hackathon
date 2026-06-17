"use client"

import { useState, useMemo } from "react"
import { addContent, scrapeUrl, deleteContent, detectSpeakers, extractSpeakerContent, backfillTags } from "@/lib/actions/content-library"
import type { SpeakerDetectionResult } from "@/lib/actions/content-library"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { cn } from "@/lib/utils"
import { Plus, Trash2, ExternalLink, Loader2, Search, Twitter, Mic, BookOpen, Users, CheckCircle2 } from "lucide-react"

type ContentItem = {
  id: string
  partner: string
  sourceType: string
  sourceUrl: string | null
  title: string | null
  content: string
  tags: string[]
  publishedAt: Date | null
  createdAt: Date
}

const PARTNERS = [
  { key: "sam",   label: "Sam Lessin",      color: "bg-violet-500/15 text-violet-400 border-violet-500/25" },
  { key: "will",  label: "Will Quist",       color: "bg-sky-500/15 text-sky-400 border-sky-500/25" },
  { key: "yoni",  label: "Yoni Rechtman",    color: "bg-emerald-500/15 text-emerald-400 border-emerald-500/25" },
  { key: "megan", label: "Megan Lightcap",   color: "bg-rose-500/15 text-rose-400 border-rose-500/25" },
]

const SOURCE_TYPES = [
  { key: "tweet",   label: "X Post",   icon: Twitter,  color: "bg-sky-500/10 text-sky-400 border-sky-500/20" },
  { key: "blog",    label: "Blog",     icon: BookOpen, color: "bg-amber-500/10 text-amber-400 border-amber-500/20" },
  { key: "podcast", label: "Podcast",  icon: Mic,      color: "bg-purple-500/10 text-purple-400 border-purple-500/20" },
]

const PARTNER_MAP = Object.fromEntries(PARTNERS.map(p => [p.key, p]))
const SOURCE_MAP  = Object.fromEntries(SOURCE_TYPES.map(s => [s.key, s]))

function formatDate(d: Date | null): string {
  if (!d) return ""
  return new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
}

export default function ContentLibrary({
  initialContent,
  initialTags,
}: {
  initialContent: ContentItem[]
  initialTags: string[]
}) {
  const [filterPartner,    setFilterPartner]    = useState("all")
  const [filterSourceType, setFilterSourceType] = useState("all")
  const [filterTag,        setFilterTag]        = useState("all")
  const [search,           setSearch]           = useState("")
  const [open,             setOpen]             = useState(false)

  // Add form state
  const [url,          setUrl]          = useState("")
  const [isScraping,   setIsScraping]   = useState(false)
  const [scrapeResult, setScrapeResult] = useState<{ title: string; text: string } | null>(null)
  const [scrapeFailed, setScrapeFailed] = useState(false)
  const [manualTitle,  setManualTitle]  = useState("")
  const [manualText,   setManualText]   = useState("")
  const [partner,      setPartner]      = useState("")
  const [sourceType,   setSourceType]   = useState("")
  const [isSaving,     setIsSaving]     = useState(false)
  const [isBackfilling, setIsBackfilling] = useState(false)
  const [backfillResult, setBackfillResult] = useState<{ updated: number; skipped: number } | null>(null)

  // Speaker detection state
  const [isDetecting,      setIsDetecting]      = useState(false)
  const [speakerResult,    setSpeakerResult]     = useState<SpeakerDetectionResult | null>(null)
  const [isExtracting,     setIsExtracting]      = useState(false)
  const [extractedContent, setExtractedContent]  = useState<string | null>(null)
  const [confirmedSpeaker, setConfirmedSpeaker]  = useState<string | null>(null)

  const filtered = useMemo(() => {
    return initialContent
      .filter(c => filterPartner    === "all" || c.partner    === filterPartner)
      .filter(c => filterSourceType === "all" || c.sourceType === filterSourceType)
      .filter(c => filterTag        === "all" || c.tags.includes(filterTag))
      .filter(c => {
        if (!search) return true
        const q = search.toLowerCase()
        return (
          c.content.toLowerCase().includes(q) ||
          (c.title ?? "").toLowerCase().includes(q) ||
          c.tags.some(t => t.includes(q))
        )
      })
  }, [initialContent, filterPartner, filterSourceType, filterTag, search])

  async function handleScrape() {
    if (!url.trim()) return
    setIsScraping(true)
    setScrapeResult(null)
    setScrapeFailed(false)
    resetSpeakerState()
    const result = await scrapeUrl(url.trim())
    setIsScraping(false)
    if (result.success && result.text) {
      setScrapeResult({ title: result.title ?? "", text: result.text })
    } else {
      setScrapeFailed(true)
    }
  }

  function resetSpeakerState() {
    setSpeakerResult(null)
    setExtractedContent(null)
    setConfirmedSpeaker(null)
  }

  async function handleDetectSpeakers() {
    const rawText = scrapeResult?.text ?? manualText
    if (!rawText || !partner) return
    const partnerLabel = PARTNERS.find(p => p.key === partner)?.label ?? partner
    setIsDetecting(true)
    resetSpeakerState()
    const result = await detectSpeakers(rawText, partnerLabel)
    setIsDetecting(false)
    setSpeakerResult(result)

    // Auto-handle simple cases
    if (result.status === "labeled") {
      setExtractedContent(result.extractedContent)
      setConfirmedSpeaker(result.speakerLabel)
    } else if (result.status === "single_speaker") {
      setExtractedContent(result.content)
      setConfirmedSpeaker("only speaker")
    }
  }

  async function handleConfirmSpeaker(speakerId: string) {
    const rawText = scrapeResult?.text ?? manualText
    const partnerLabel = PARTNERS.find(p => p.key === partner)?.label ?? partner
    setIsExtracting(true)
    setConfirmedSpeaker(speakerId)
    const extracted = await extractSpeakerContent(rawText, speakerId, partnerLabel)
    setExtractedContent(extracted)
    setIsExtracting(false)
  }

  // The content to save: extracted (filtered) if podcast + speaker detected, otherwise raw
  const contentToSave = (() => {
    if (sourceType === "podcast" && extractedContent) return extractedContent
    return scrapeResult?.text ?? manualText
  })()

  async function handleSave() {
    if (!contentToSave.trim() || !partner || !sourceType) return
    setIsSaving(true)
    await addContent({
      partner,
      sourceType,
      sourceUrl: url.trim() || undefined,
      title: scrapeResult?.title || manualTitle || undefined,
      content: contentToSave,
    })
    setIsSaving(false)
    setOpen(false)
    resetForm()
  }

  function resetForm() {
    setUrl(""); setScrapeResult(null); setScrapeFailed(false)
    setManualTitle(""); setManualText(""); setPartner(""); setSourceType("")
    resetSpeakerState()
  }

  const rawTextAvailable = !!(scrapeResult?.text || manualText.trim())
  const showSpeakerDetect = sourceType === "podcast" && partner && rawTextAvailable && !extractedContent

  const pillBase = "px-3 py-1.5 rounded-lg text-xs font-medium transition-all cursor-pointer border"
  const pillActive = "bg-background shadow-sm text-foreground border-border/60"
  const pillInactive = "bg-transparent border-transparent text-muted-foreground hover:text-foreground hover:bg-muted/40"

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-6xl mx-auto px-5 py-8">

        {/* Header */}
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-xl font-bold tracking-tight">Content Library</h1>
            <p className="text-xs text-muted-foreground mt-1">
              {initialContent.length} items · auto-syncs X posts every Monday
            </p>
          </div>
          <div className="flex items-center gap-2">
            {backfillResult && (
              <span className="text-[11px] text-emerald-500">✓ Tagged {backfillResult.updated} items</span>
            )}
            <Button
              size="sm"
              variant="outline"
              disabled={isBackfilling}
              onClick={async () => {
                setIsBackfilling(true)
                setBackfillResult(null)
                const result = await backfillTags()
                setBackfillResult(result)
                setIsBackfilling(false)
              }}
            >
              {isBackfilling ? <><Loader2 size={13} className="animate-spin mr-1.5" />Tagging...</> : "Tag untagged"}
            </Button>
          <Dialog open={open} onOpenChange={o => { setOpen(o); if (!o) resetForm() }}>
            <DialogTrigger asChild>
              <Button size="sm" className="gap-1.5">
                <Plus size={14} /> Add Content
              </Button>
            </DialogTrigger>
            <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
              <DialogHeader>
                <DialogTitle>Add Content</DialogTitle>
              </DialogHeader>
              <div className="space-y-4 pt-2">

                {/* URL scrape */}
                <div className="space-y-2">
                  <Label className="text-xs">URL (blog, podcast page, tweet)</Label>
                  <div className="flex gap-2">
                    <Input
                      placeholder="https://..."
                      value={url}
                      onChange={e => { setUrl(e.target.value); setScrapeResult(null); setScrapeFailed(false); resetSpeakerState() }}
                      className="text-sm"
                    />
                    <Button variant="outline" size="sm" onClick={handleScrape} disabled={!url.trim() || isScraping} className="shrink-0">
                      {isScraping ? <Loader2 size={14} className="animate-spin" /> : "Scrape"}
                    </Button>
                  </div>
                </div>

                {/* Scrape preview */}
                {scrapeResult && !extractedContent && (
                  <div className="rounded-lg border border-border/60 bg-muted/20 p-3 space-y-1">
                    <p className="text-xs font-medium">{scrapeResult.title || "Untitled"}</p>
                    <p className="text-xs text-muted-foreground line-clamp-3">{scrapeResult.text}</p>
                    <p className="text-[10px] text-emerald-500">✓ Scraped successfully</p>
                  </div>
                )}

                {/* Manual fallback */}
                {scrapeFailed && (
                  <div className="space-y-2">
                    <p className="text-xs text-amber-500">Couldn't scrape this URL — paste the content manually below.</p>
                    <Input placeholder="Title (optional)" value={manualTitle} onChange={e => setManualTitle(e.target.value)} className="text-sm" />
                    <Textarea
                      placeholder="Paste transcript or text here..."
                      value={manualText}
                      onChange={e => { setManualText(e.target.value); resetSpeakerState() }}
                      className="text-sm min-h-32 resize-none"
                    />
                  </div>
                )}

                {/* Partner + type */}
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label className="text-xs">Partner</Label>
                    <Select value={partner} onValueChange={v => { setPartner(v); resetSpeakerState() }}>
                      <SelectTrigger className="text-sm"><SelectValue placeholder="Select..." /></SelectTrigger>
                      <SelectContent>
                        {PARTNERS.map(p => <SelectItem key={p.key} value={p.key}>{p.label}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs">Type</Label>
                    <Select value={sourceType} onValueChange={v => { setSourceType(v); resetSpeakerState() }}>
                      <SelectTrigger className="text-sm"><SelectValue placeholder="Select..." /></SelectTrigger>
                      <SelectContent>
                        {SOURCE_TYPES.map(s => <SelectItem key={s.key} value={s.key}>{s.label}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                {/* Speaker detection — podcast only */}
                {showSpeakerDetect && (
                  <div className="rounded-lg border border-purple-500/20 bg-purple-500/5 p-3 space-y-2">
                    <div className="flex items-center gap-2">
                      <Users size={13} className="text-purple-400" />
                      <p className="text-xs text-purple-300 font-medium">Podcast detected — filter to partner's voice only</p>
                    </div>
                    <p className="text-[11px] text-muted-foreground">
                      Detect speakers to save only {PARTNERS.find(p => p.key === partner)?.label}'s lines, removing hosts and other guests.
                    </p>
                    <Button
                      variant="outline"
                      size="sm"
                      className="w-full text-xs border-purple-500/30 hover:bg-purple-500/10"
                      onClick={handleDetectSpeakers}
                      disabled={isDetecting}
                    >
                      {isDetecting ? <><Loader2 size={12} className="animate-spin mr-1.5" /> Detecting speakers...</> : "Detect Speakers"}
                    </Button>
                  </div>
                )}

                {/* Speaker detection results — unlabeled, needs confirmation */}
                {speakerResult?.status === "unlabeled" && !extractedContent && (
                  <div className="space-y-2">
                    <p className="text-xs font-medium">Which speaker is {PARTNERS.find(p => p.key === partner)?.label}?</p>
                    <p className="text-[11px] text-muted-foreground">No speaker labels found. Click the speaker whose quotes match the partner.</p>
                    {speakerResult.speakers.map(sp => (
                      <button
                        key={sp.id}
                        onClick={() => handleConfirmSpeaker(sp.id)}
                        disabled={isExtracting}
                        className={cn(
                          "w-full text-left rounded-lg border p-3 space-y-1.5 transition-all",
                          confirmedSpeaker === sp.id
                            ? "border-emerald-500/50 bg-emerald-500/10"
                            : "border-border/60 bg-muted/10 hover:border-border hover:bg-muted/20"
                        )}
                      >
                        <div className="flex items-center justify-between">
                          <p className="text-xs font-semibold">{sp.id}</p>
                          <span className="text-[10px] text-muted-foreground">~{sp.wordCount.toLocaleString()} words</span>
                        </div>
                        {sp.samples.map((quote, i) => (
                          <p key={i} className="text-[11px] text-muted-foreground italic line-clamp-2">"{quote}"</p>
                        ))}
                      </button>
                    ))}
                    {isExtracting && (
                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        <Loader2 size={12} className="animate-spin" /> Extracting {confirmedSpeaker}'s lines…
                      </div>
                    )}
                  </div>
                )}

                {/* Extracted content confirmation */}
                {extractedContent && (
                  <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 p-3 space-y-1">
                    <div className="flex items-center gap-1.5">
                      <CheckCircle2 size={13} className="text-emerald-400" />
                      <p className="text-xs text-emerald-400 font-medium">
                        {confirmedSpeaker === "only speaker"
                          ? "Single speaker — full transcript will be saved"
                          : `Extracted ${PARTNERS.find(p => p.key === partner)?.label}'s lines only`}
                      </p>
                    </div>
                    <p className="text-xs text-muted-foreground line-clamp-3">{extractedContent.slice(0, 300)}…</p>
                    <p className="text-[10px] text-muted-foreground/50">{extractedContent.split(/\s+/).length.toLocaleString()} words</p>
                    <button onClick={resetSpeakerState} className="text-[10px] text-muted-foreground/50 hover:text-muted-foreground underline">
                      Re-detect speakers
                    </button>
                  </div>
                )}

                <Button
                  className="w-full"
                  onClick={handleSave}
                  disabled={
                    isSaving ||
                    !partner ||
                    !sourceType ||
                    !contentToSave.trim() ||
                    // For podcasts: must either have extracted content OR have skipped detection
                    (sourceType === "podcast" && rawTextAvailable && !extractedContent && speakerResult === null
                      ? false // allow saving without detecting (user can skip)
                      : false)
                  }
                >
                  {isSaving ? <><Loader2 size={14} className="animate-spin mr-2" /> Saving & tagging...</> : "Save"}
                </Button>

                {/* Skip detection nudge for podcasts */}
                {showSpeakerDetect && (
                  <p className="text-[10px] text-muted-foreground/40 text-center -mt-2">
                    Or save without speaker filtering — all voices will be included.
                  </p>
                )}
              </div>
            </DialogContent>
          </Dialog>
          </div>
        </div>

        {/* Filters */}
        <div className="space-y-3 mb-6">
          <div className="flex items-center gap-1 flex-wrap">
            <button onClick={() => setFilterPartner("all")} className={cn(pillBase, filterPartner === "all" ? pillActive : pillInactive)}>All</button>
            {PARTNERS.map(p => (
              <button key={p.key} onClick={() => setFilterPartner(p.key)} className={cn(pillBase, filterPartner === p.key ? pillActive : pillInactive)}>
                {p.label}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-1 flex-wrap">
            <button onClick={() => setFilterSourceType("all")} className={cn(pillBase, filterSourceType === "all" ? pillActive : pillInactive)}>All Types</button>
            {SOURCE_TYPES.map(s => (
              <button key={s.key} onClick={() => setFilterSourceType(s.key)} className={cn(pillBase, filterSourceType === s.key ? pillActive : pillInactive)}>
                {s.label}
              </button>
            ))}
          </div>

          {initialTags.length > 0 && (
            <div className="flex items-center gap-1 flex-wrap">
              <button onClick={() => setFilterTag("all")} className={cn(pillBase, filterTag === "all" ? pillActive : pillInactive)}>All Tags</button>
              {initialTags.map(tag => (
                <button key={tag} onClick={() => setFilterTag(tag)} className={cn(pillBase, filterTag === tag ? pillActive : pillInactive)}>
                  {tag}
                </button>
              ))}
            </div>
          )}

          <div className="relative max-w-sm">
            <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search content..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="pl-8 text-sm h-8"
            />
          </div>
        </div>

        <p className="text-xs text-muted-foreground mb-4">
          {filtered.length} {filtered.length === 1 ? "item" : "items"}
          {filterPartner !== "all" || filterSourceType !== "all" || filterTag !== "all" || search ? " matching filters" : ""}
        </p>

        {filtered.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border/40 p-16 text-center">
            <p className="text-sm text-muted-foreground/50">No content yet.</p>
            <p className="text-xs text-muted-foreground/30 mt-1">Add your first item or wait for Monday's X sync.</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {filtered.map(item => {
              const p = PARTNER_MAP[item.partner]
              const s = SOURCE_MAP[item.sourceType]
              const Icon = s?.icon
              const displayTitle = item.title || item.content.slice(0, 60) + (item.content.length > 60 ? "…" : "")

              return (
                <div key={item.id} className="group rounded-xl border border-border/60 bg-card hover:border-border transition-all overflow-hidden flex flex-col">
                  <div className="p-4 flex-1 space-y-3">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      {p && <span className={cn("text-[10px] px-2 py-0.5 rounded-full border font-medium", p.color)}>{p.label}</span>}
                      {s && (
                        <span className={cn("text-[10px] px-2 py-0.5 rounded-full border font-medium flex items-center gap-1", s.color)}>
                          {Icon && <Icon size={9} />}{s.label}
                        </span>
                      )}
                      <span className="text-[10px] text-muted-foreground/50 ml-auto">
                        {formatDate(item.publishedAt ?? item.createdAt)}
                      </span>
                      <button
                        onClick={() => deleteContent(item.id)}
                        className="opacity-0 group-hover:opacity-100 text-muted-foreground/40 hover:text-destructive transition-all ml-1"
                      >
                        <Trash2 size={11} />
                      </button>
                    </div>

                    <p className="text-sm font-medium leading-snug line-clamp-2">{displayTitle}</p>
                    <p className="text-xs text-muted-foreground leading-relaxed line-clamp-2">{item.content}</p>

                    {item.tags.length > 0 && (
                      <div className="flex flex-wrap gap-1">
                        {item.tags.map(tag => (
                          <Badge key={tag} variant="secondary" className="text-[10px] px-1.5 py-0 rounded-md cursor-pointer hover:bg-muted" onClick={() => setFilterTag(tag)}>
                            {tag}
                          </Badge>
                        ))}
                      </div>
                    )}
                  </div>

                  {item.sourceUrl && (
                    <div className="px-4 py-2.5 border-t border-border/40 bg-muted/10">
                      <a
                        href={item.sourceUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
                      >
                        <ExternalLink size={11} /> View full source
                      </a>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
