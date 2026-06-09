"use client"

import { useState, useEffect, useMemo } from "react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
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
import {
  addMediaAppearance,
  getMediaAppearances,
  deleteMediaAppearance,
  checkTranscriptionStatus,
} from "@/lib/actions/media-tracker"
import {
  Plus,
  Trash2,
  ExternalLink,
  ChevronDown,
  ChevronUp,
  RefreshCw,
  Mic,
  Newspaper,
  Video,
  Users,
  BookOpen,
  Globe,
  Loader2,
} from "lucide-react"

type Appearance = {
  id: string
  partner: string
  type: string
  show: string
  title: string
  url: string
  publishedAt: Date | null
  transcript: string | null
  topics: string[]
  notes: string | null
  status: string
  processingJobId: string | null
  createdAt: Date
}

const PARTNERS = [
  { key: "sam", name: "Sam Lessin" },
  { key: "will", name: "Will Quist" },
  { key: "yoni", name: "Yoni Rechtman" },
  { key: "megan", name: "Megan Lightcap" },
]

const TYPES = [
  { key: "podcast", label: "Podcast", icon: Mic },
  { key: "press", label: "Press", icon: Newspaper },
  { key: "video", label: "Video", icon: Video },
  { key: "panel", label: "Panel", icon: Users },
  { key: "newsletter", label: "Newsletter", icon: BookOpen },
  { key: "other", label: "Other", icon: Globe },
]

const PARTNER_NAMES: Record<string, string> = Object.fromEntries(PARTNERS.map(p => [p.key, p.name]))

const TYPE_COLORS: Record<string, string> = {
  podcast: "bg-purple-100 text-purple-800",
  press: "bg-blue-100 text-blue-800",
  video: "bg-red-100 text-red-800",
  panel: "bg-orange-100 text-orange-800",
  newsletter: "bg-green-100 text-green-800",
  other: "bg-gray-100 text-gray-700",
}

const PARTNER_COLORS: Record<string, string> = {
  sam: "bg-indigo-100 text-indigo-800",
  will: "bg-teal-100 text-teal-800",
  yoni: "bg-amber-100 text-amber-800",
  megan: "bg-rose-100 text-rose-800",
}

export default function MediaTrackerPage() {
  const [appearances, setAppearances] = useState<Appearance[]>([])
  const [loading, setLoading] = useState(true)
  const [adding, setAdding] = useState(false)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Filters
  const [filterPartner, setFilterPartner] = useState("all")
  const [filterType, setFilterType] = useState("all")
  const [filterTopic, setFilterTopic] = useState("all")
  const [search, setSearch] = useState("")

  // Form state
  const [form, setForm] = useState({
    partner: "",
    type: "",
    show: "",
    title: "",
    url: "",
    publishedAt: "",
    notes: "",
  })

  useEffect(() => {
    load()
  }, [])

  async function load() {
    setLoading(true)
    const data = await getMediaAppearances()
    setAppearances(data as Appearance[])
    setLoading(false)
  }

  async function handleAdd() {
    if (!form.partner || !form.type || !form.show || !form.title || !form.url) {
      setError("Please fill in all required fields.")
      return
    }
    setAdding(true)
    setError(null)
    try {
      await addMediaAppearance(form)
      setDialogOpen(false)
      setForm({ partner: "", type: "", show: "", title: "", url: "", publishedAt: "", notes: "" })
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to add appearance")
    } finally {
      setAdding(false)
    }
  }

  async function handleDelete(id: string) {
    await deleteMediaAppearance(id)
    setAppearances(prev => prev.filter(a => a.id !== id))
  }

  async function handleCheckStatus(id: string) {
    await checkTranscriptionStatus(id)
    await load()
  }

  // Collect all unique topics across all appearances
  const allTopics = useMemo(() => {
    const set = new Set<string>()
    appearances.forEach(a => a.topics.forEach(t => set.add(t)))
    return Array.from(set).sort()
  }, [appearances])

  // Apply filters
  const filtered = useMemo(() => {
    return appearances.filter(a => {
      if (filterPartner !== "all" && a.partner !== filterPartner) return false
      if (filterType !== "all" && a.type !== filterType) return false
      if (filterTopic !== "all" && !a.topics.includes(filterTopic)) return false
      if (search) {
        const s = search.toLowerCase()
        if (
          !a.title.toLowerCase().includes(s) &&
          !a.show.toLowerCase().includes(s) &&
          !a.transcript?.toLowerCase().includes(s)
        ) return false
      }
      return true
    })
  }, [appearances, filterPartner, filterType, filterTopic, search])

  const processingCount = appearances.filter(a => a.status === "processing").length

  return (
    <div className="min-h-screen p-6 flex flex-col items-center">
      <div className="w-full max-w-5xl flex flex-col gap-6">

        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold mb-1">Media Tracker</h1>
            <p className="text-muted-foreground text-sm">
              {appearances.length} appearance{appearances.length !== 1 ? "s" : ""} tracked
              {processingCount > 0 && ` · ${processingCount} transcribing`}
            </p>
          </div>
          <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
            <DialogTrigger asChild>
              <Button className="gap-2">
                <Plus className="h-4 w-4" />
                Add Appearance
              </Button>
            </DialogTrigger>
            <DialogContent className="max-w-lg">
              <DialogHeader>
                <DialogTitle>Add Media Appearance</DialogTitle>
              </DialogHeader>
              <div className="flex flex-col gap-4 pt-2">
                <div className="grid grid-cols-2 gap-3">
                  <div className="flex flex-col gap-1.5">
                    <Label>Partner *</Label>
                    <Select value={form.partner} onValueChange={v => setForm(f => ({ ...f, partner: v }))}>
                      <SelectTrigger>
                        <SelectValue placeholder="Select partner" />
                      </SelectTrigger>
                      <SelectContent>
                        {PARTNERS.map(p => (
                          <SelectItem key={p.key} value={p.key}>{p.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label>Type *</Label>
                    <Select value={form.type} onValueChange={v => setForm(f => ({ ...f, type: v }))}>
                      <SelectTrigger>
                        <SelectValue placeholder="Select type" />
                      </SelectTrigger>
                      <SelectContent>
                        {TYPES.map(t => (
                          <SelectItem key={t.key} value={t.key}>{t.label}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                <div className="flex flex-col gap-1.5">
                  <Label>Show / Publication *</Label>
                  <Input
                    placeholder="e.g. The Twenty Minute VC, TechCrunch"
                    value={form.show}
                    onChange={e => setForm(f => ({ ...f, show: e.target.value }))}
                  />
                </div>

                <div className="flex flex-col gap-1.5">
                  <Label>Title / Episode Name *</Label>
                  <Input
                    placeholder="e.g. Sam Lessin on the future of AI agents"
                    value={form.title}
                    onChange={e => setForm(f => ({ ...f, title: e.target.value }))}
                  />
                </div>

                <div className="flex flex-col gap-1.5">
                  <Label>URL *</Label>
                  <Input
                    placeholder="https://..."
                    value={form.url}
                    onChange={e => setForm(f => ({ ...f, url: e.target.value }))}
                  />
                  <p className="text-xs text-muted-foreground">
                    Audio/video URLs will be auto-transcribed. Press URLs will be scraped.
                  </p>
                </div>

                <div className="flex flex-col gap-1.5">
                  <Label>Date Published</Label>
                  <Input
                    type="date"
                    value={form.publishedAt}
                    onChange={e => setForm(f => ({ ...f, publishedAt: e.target.value }))}
                  />
                </div>

                <div className="flex flex-col gap-1.5">
                  <Label>Notes</Label>
                  <Textarea
                    placeholder="Any context, key quotes, follow-up actions..."
                    rows={3}
                    value={form.notes}
                    onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
                  />
                </div>

                {error && <p className="text-sm text-destructive">{error}</p>}

                <Button onClick={handleAdd} disabled={adding} className="w-full">
                  {adding ? (
                    <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Adding...</>
                  ) : "Add Appearance"}
                </Button>
              </div>
            </DialogContent>
          </Dialog>
        </div>

        {/* Filters */}
        <div className="flex flex-col gap-3">
          <Input
            placeholder="Search by title, publication, or transcript content..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="max-w-lg"
          />
          <div className="flex flex-wrap gap-2">
            {/* Partner filter */}
            <div className="flex gap-1.5 flex-wrap">
              <button
                onClick={() => setFilterPartner("all")}
                className={`px-3 py-1 rounded-full text-xs font-medium border transition-colors ${filterPartner === "all" ? "bg-foreground text-background border-foreground" : "border-border text-muted-foreground hover:border-foreground/50"}`}
              >
                All partners
              </button>
              {PARTNERS.map(p => (
                <button
                  key={p.key}
                  onClick={() => setFilterPartner(filterPartner === p.key ? "all" : p.key)}
                  className={`px-3 py-1 rounded-full text-xs font-medium border transition-colors ${filterPartner === p.key ? "bg-foreground text-background border-foreground" : "border-border text-muted-foreground hover:border-foreground/50"}`}
                >
                  {p.name.split(" ")[0]}
                </button>
              ))}
            </div>

            <div className="w-px bg-border mx-1" />

            {/* Type filter */}
            <div className="flex gap-1.5 flex-wrap">
              <button
                onClick={() => setFilterType("all")}
                className={`px-3 py-1 rounded-full text-xs font-medium border transition-colors ${filterType === "all" ? "bg-foreground text-background border-foreground" : "border-border text-muted-foreground hover:border-foreground/50"}`}
              >
                All types
              </button>
              {TYPES.map(t => (
                <button
                  key={t.key}
                  onClick={() => setFilterType(filterType === t.key ? "all" : t.key)}
                  className={`px-3 py-1 rounded-full text-xs font-medium border transition-colors ${filterType === t.key ? "bg-foreground text-background border-foreground" : "border-border text-muted-foreground hover:border-foreground/50"}`}
                >
                  {t.label}
                </button>
              ))}
            </div>
          </div>

          {/* Topic filter */}
          {allTopics.length > 0 && (
            <div className="flex gap-1.5 flex-wrap">
              <button
                onClick={() => setFilterTopic("all")}
                className={`px-3 py-1 rounded-full text-xs font-medium border transition-colors ${filterTopic === "all" ? "bg-foreground text-background border-foreground" : "border-border text-muted-foreground hover:border-foreground/50"}`}
              >
                All topics
              </button>
              {allTopics.map(t => (
                <button
                  key={t}
                  onClick={() => setFilterTopic(filterTopic === t ? "all" : t)}
                  className={`px-3 py-1 rounded-full text-xs font-medium border transition-colors ${filterTopic === t ? "bg-foreground text-background border-foreground" : "border-border text-muted-foreground hover:border-foreground/50"}`}
                >
                  {t}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Results count */}
        {(filterPartner !== "all" || filterType !== "all" || filterTopic !== "all" || search) && (
          <p className="text-sm text-muted-foreground -mt-2">
            Showing {filtered.length} of {appearances.length}
          </p>
        )}

        {/* Cards */}
        {loading ? (
          <div className="flex items-center justify-center py-16 text-muted-foreground text-sm">
            <Loader2 className="h-4 w-4 animate-spin mr-2" /> Loading...
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-muted-foreground gap-2">
            <p className="text-sm">
              {appearances.length === 0
                ? "No appearances yet. Add the first one."
                : "No results match your filters."}
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {filtered.map(a => (
              <AppearanceCard
                key={a.id}
                appearance={a}
                onDelete={handleDelete}
                onCheckStatus={handleCheckStatus}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

// ─── AppearanceCard ───────────────────────────────────────────────────────────

function AppearanceCard({
  appearance: a,
  onDelete,
  onCheckStatus,
}: {
  appearance: Appearance
  onDelete: (id: string) => void
  onCheckStatus: (id: string) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [checking, setChecking] = useState(false)

  const TypeIcon = TYPES.find(t => t.key === a.type)?.icon ?? Globe

  async function handleDelete() {
    setDeleting(true)
    await onDelete(a.id)
  }

  async function handleCheck() {
    setChecking(true)
    await onCheckStatus(a.id)
    setChecking(false)
  }

  const preview = a.transcript
    ? a.transcript.slice(0, 300) + (a.transcript.length > 300 ? "..." : "")
    : null

  return (
    <div className="rounded-lg border bg-card p-4 flex flex-col gap-3">
      {/* Top row */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-2 flex-1 min-w-0">
          <TypeIcon className="h-4 w-4 mt-0.5 text-muted-foreground shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap mb-1">
              <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${PARTNER_COLORS[a.partner] || "bg-gray-100 text-gray-700"}`}>
                {PARTNER_NAMES[a.partner] || a.partner}
              </span>
              <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${TYPE_COLORS[a.type] || "bg-gray-100 text-gray-700"}`}>
                {TYPES.find(t => t.key === a.type)?.label || a.type}
              </span>
              {a.status === "processing" && (
                <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-yellow-100 text-yellow-800 flex items-center gap-1">
                  <Loader2 className="h-2.5 w-2.5 animate-spin" /> Transcribing
                </span>
              )}
              {a.status === "error" && (
                <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-red-100 text-red-800">
                  Error
                </span>
              )}
            </div>
            <p className="font-medium text-sm leading-snug">{a.title}</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              {a.show}
              {a.publishedAt && ` · ${new Date(a.publishedAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`}
            </p>
          </div>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-1 shrink-0">
          {a.status === "processing" && (
            <button
              onClick={handleCheck}
              disabled={checking}
              className="text-muted-foreground hover:text-foreground transition-colors p-1"
              title="Check transcription status"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${checking ? "animate-spin" : ""}`} />
            </button>
          )}
          <a
            href={a.url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-muted-foreground hover:text-foreground transition-colors p-1"
          >
            <ExternalLink className="h-3.5 w-3.5" />
          </a>
          <button
            onClick={handleDelete}
            disabled={deleting}
            className="text-muted-foreground hover:text-destructive transition-colors p-1 disabled:opacity-50"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* Topics */}
      {a.topics.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {a.topics.map(t => (
            <Badge key={t} variant="secondary" className="text-xs font-normal">
              {t}
            </Badge>
          ))}
        </div>
      )}

      {/* Notes */}
      {a.notes && (
        <p className="text-xs text-muted-foreground border-l-2 border-border pl-2 italic">
          {a.notes}
        </p>
      )}

      {/* Transcript toggle */}
      {preview && (
        <div className="border-t pt-3">
          <button
            onClick={() => setExpanded(!expanded)}
            className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            {expanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
            {expanded ? "Hide transcript" : "Show transcript"}
          </button>
          {expanded && (
            <div className="mt-2 max-h-64 overflow-y-auto text-xs leading-relaxed text-muted-foreground whitespace-pre-wrap rounded bg-muted/30 p-3">
              {a.transcript}
            </div>
          )}
          {!expanded && (
            <p className="mt-1.5 text-xs text-muted-foreground leading-relaxed line-clamp-2">
              {preview}
            </p>
          )}
        </div>
      )}

      {a.status === "processing" && !a.transcript && (
        <p className="text-xs text-muted-foreground border-t pt-3">
          Transcript is being generated. Click the refresh icon above to check if it&apos;s ready.
        </p>
      )}
    </div>
  )
}
