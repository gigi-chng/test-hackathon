"use client"

import React, { useState, useEffect } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import {
  generateVideoDraftsFromTrends, getVideoLibraryStatus, getVideoDrafts,
  updateDraft, deleteDraft, rewriteDraftWithAI, syncDriveFolder,
} from "@/lib/actions/agent"
import { TrendingUp, Video, Pencil, Trash2, Check, X, Sparkles, FolderSync, Twitter, Linkedin } from "lucide-react"

const PARTNER_NAMES: Record<string, string> = {
  sam: "Sam Lessin", will: "Will Quist", yoni: "Yoni Rechtman", megan: "Megan Lightcap",
}

type Draft = {
  id: string
  hook: string
  body: string
  partner: string
  videoId: string | null
  videoTitle: string | null
  videoStorageUrl: string | null
  partnerSourceUrl: string | null
  status: string
  createdAt: Date
}

type VideoStatus = {
  id: string; partner: string; title: string
  forcedNext: boolean; posted: boolean; publishedAt: Date | null
}

export default function VideoQueuePage() {
  const [drafts, setDrafts] = useState<Draft[]>([])
  const [videos, setVideos] = useState<VideoStatus[]>([])
  const [generating, setGenerating] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [generateMessage, setGenerateMessage] = useState<string | null>(null)
  const [syncMessage, setSyncMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editHook, setEditHook] = useState("")
  const [editBody, setEditBody] = useState("")
  const [savingId, setSavingId] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [rewritingId, setRewritingId] = useState<string | null>(null)

  useEffect(() => { loadDrafts(); loadVideos() }, [])

  async function loadDrafts() { setDrafts((await getVideoDrafts()) as Draft[]) }
  async function loadVideos() { setVideos((await getVideoLibraryStatus()) as VideoStatus[]) }

  async function handleSync() {
    setSyncing(true); setSyncMessage(null); setError(null)
    try {
      const res = await syncDriveFolder()
      setSyncMessage(res.message ?? `${res.added} new video${res.added !== 1 ? "s" : ""} added · ${res.skipped} already in library`)
      await loadVideos()
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setSyncing(false) }
  }

  async function handleGenerate() {
    setGenerating(true); setGenerateMessage(null); setError(null)
    try {
      const res = await generateVideoDraftsFromTrends()
      setGenerateMessage(res.generated > 0
        ? `${res.generated} draft${res.generated !== 1 ? "s" : ""} generated — review below`
        : (res.message ?? "No drafts generated"))
      await loadDrafts(); await loadVideos()
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setGenerating(false) }
  }

  function startEdit(draft: Draft) { setEditingId(draft.id); setEditHook(draft.hook); setEditBody(draft.body) }
  function cancelEdit() { setEditingId(null) }

  async function saveEdit(id: string) {
    setSavingId(id)
    await updateDraft(id, { hook: editHook, body: editBody })
    await loadDrafts()
    setSavingId(null); setEditingId(null)
  }

  async function handleDelete(id: string) {
    setDeletingId(id)
    await deleteDraft(id)
    await loadDrafts()
    setDeletingId(null)
  }

  async function handleRewrite(id: string, instruction: string) {
    setRewritingId(id)
    try {
      const result = await rewriteDraftWithAI(id, instruction)
      setEditHook(result.hook); setEditBody(result.body)
    } finally { setRewritingId(null) }
  }

  const availableCount = videos.filter(v => !v.posted).length

  return (
    <div className="min-h-screen p-6 flex flex-col items-center">
      <div className="w-full max-w-4xl flex flex-col gap-8">

        <div>
          <h1 className="text-3xl font-bold mb-1">Content Generator</h1>
          <p className="text-muted-foreground">Find trending moments on X and match them to your video library.</p>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-3 gap-4">
          <Card><div className="p-4">
            <p className="text-xs text-muted-foreground mb-1">In library</p>
            <p className="text-2xl font-bold">{videos.length}</p>
          </div></Card>
          <Card><div className="p-4">
            <p className="text-xs text-muted-foreground mb-1">Available</p>
            <p className="text-2xl font-bold">{availableCount}</p>
            <p className="text-xs text-muted-foreground">unposted</p>
          </div></Card>
          <Card><div className="p-4">
            <p className="text-xs text-muted-foreground mb-1">Drafts ready</p>
            <p className="text-2xl font-bold">{drafts.length}</p>
          </div></Card>
        </div>

        {error && <p className="text-sm text-destructive">{error}</p>}

        {/* Actions */}
        <div className="flex gap-2">
          <Button variant="outline" onClick={handleSync} disabled={syncing}>
            <FolderSync className={`mr-2 h-4 w-4 ${syncing ? "animate-spin" : ""}`} />
            {syncing ? "Syncing..." : "Sync from Drive"}
          </Button>
          <Button onClick={handleGenerate} disabled={generating} className="flex-1">
            <TrendingUp className={`mr-2 h-4 w-4 ${generating ? "animate-pulse" : ""}`} />
            {generating ? "Finding trends and matching videos..." : "Generate from X Trends"}
          </Button>
        </div>

        {syncMessage && <p className="text-sm text-muted-foreground">{syncMessage}</p>}
        {generateMessage && <p className="text-sm text-muted-foreground">{generateMessage}</p>}

        {/* Drafts */}
        <section className="flex flex-col gap-3">
          <h2 className="font-semibold text-lg">Drafts &middot; {drafts.length}</h2>
          {drafts.length === 0
            ? <p className="text-sm text-muted-foreground">No drafts yet. Click &ldquo;Generate from X Trends&rdquo; to find trending moments and match them to your video library.</p>
            : drafts.map(draft => (
              <DraftCard
                key={draft.id}
                draft={draft}
                editingId={editingId}
                editHook={editHook}
                editBody={editBody}
                savingId={savingId}
                deletingId={deletingId}
                rewritingId={rewritingId}
                onEdit={startEdit}
                onCancelEdit={cancelEdit}
                onSaveEdit={saveEdit}
                onDelete={handleDelete}
                onRewrite={handleRewrite}
                onHookChange={setEditHook}
                onBodyChange={setEditBody}
              />
            ))
          }
        </section>

      </div>
    </div>
  )
}

// ─── DraftCard ────────────────────────────────────────────────────────────────

function DraftCard({
  draft,
  editingId, editHook, editBody, savingId, deletingId, rewritingId,
  onEdit, onCancelEdit, onSaveEdit, onDelete, onRewrite, onHookChange, onBodyChange,
}: {
  draft: Draft
  editingId: string | null
  editHook: string
  editBody: string
  savingId: string | null
  deletingId: string | null
  rewritingId: string | null
  onEdit: (d: Draft) => void
  onCancelEdit: () => void
  onSaveEdit: (id: string) => void
  onDelete: (id: string) => void
  onRewrite: (id: string, instruction: string) => void
  onHookChange: (v: string) => void
  onBodyChange: (v: string) => void
}) {
  const isEditing = editingId === draft.id
  const [aiPrompt, setAiPrompt] = useState("")

  const driveFileId = draft.videoStorageUrl?.match(/\/d\/([^/?]+)/)?.[1] ?? null
  const embedUrl = driveFileId ? `https://drive.google.com/file/d/${driveFileId}/preview` : null

  const trendLabel = draft.partnerSourceUrl
    ? (draft.partnerSourceUrl.startsWith("http") ? "Trending topic" : draft.partnerSourceUrl.slice(0, 60))
    : null

  return (
    <Card>
      <CardContent className="pt-4 flex flex-col gap-3">

        {/* Header */}
        <div className="flex items-start justify-between gap-2">
          <div className="flex flex-col gap-1 min-w-0">
            {trendLabel && (
              <Badge className="w-fit bg-amber-100 text-amber-700 border-amber-300 hover:bg-amber-100 text-xs font-normal">
                {trendLabel}
              </Badge>
            )}
            <p className="text-xs text-muted-foreground">
              {PARTNER_NAMES[draft.partner] || draft.partner}
              {draft.videoTitle && <> &middot; <Video className="inline h-3 w-3 mx-0.5" />{draft.videoTitle}</>}
            </p>
          </div>
          {!isEditing && (
            <Button
              size="sm"
              variant="outline"
              className="shrink-0 h-7 px-2 text-destructive border-destructive/30 hover:bg-destructive/10"
              disabled={deletingId === draft.id}
              onClick={() => onDelete(draft.id)}
            >
              <Trash2 className="h-3.5 w-3.5" />
              {deletingId === draft.id ? "..." : ""}
            </Button>
          )}
        </div>

        {/* Video preview */}
        {embedUrl && (
          <div className="rounded-md overflow-hidden bg-black aspect-video w-full">
            <iframe src={embedUrl} className="w-full h-full" allow="autoplay" allowFullScreen />
          </div>
        )}

        {/* Content */}
        {isEditing ? (
          <div className="flex flex-col gap-3">
            {/* AI prompt bar */}
            <div className="flex gap-2 p-3 rounded-lg bg-muted/50 border">
              <input
                type="text"
                placeholder='Tell AI what to change — e.g. "make it shorter" or "lead with the quote about AI costs"'
                className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
                value={aiPrompt}
                onChange={e => setAiPrompt(e.target.value)}
                onKeyDown={e => {
                  if (e.key === "Enter" && aiPrompt.trim() && rewritingId !== draft.id) {
                    onRewrite(draft.id, aiPrompt.trim()); setAiPrompt("")
                  }
                }}
              />
              <Button size="sm" variant="secondary" className="shrink-0 gap-1.5"
                disabled={!aiPrompt.trim() || rewritingId === draft.id}
                onClick={() => { onRewrite(draft.id, aiPrompt.trim()); setAiPrompt("") }}>
                <Sparkles className={`h-3.5 w-3.5 ${rewritingId === draft.id ? "animate-pulse" : ""}`} />
                {rewritingId === draft.id ? "Rewriting..." : "Rewrite"}
              </Button>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="flex flex-col gap-1">
                <label className="text-xs font-medium flex items-center gap-1">
                  <Twitter className="h-3 w-3" /> Twitter
                </label>
                <textarea
                  className="w-full rounded-md border bg-background px-3 py-2 text-sm resize-none focus:outline-none focus:ring-1 focus:ring-ring"
                  rows={5}
                  value={editHook}
                  onChange={e => onHookChange(e.target.value)}
                />
                <p className="text-xs text-muted-foreground text-right">{editHook.length} chars</p>
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-xs font-medium flex items-center gap-1">
                  <Linkedin className="h-3 w-3" /> LinkedIn
                </label>
                <textarea
                  className="w-full rounded-md border bg-background px-3 py-2 text-sm resize-none focus:outline-none focus:ring-1 focus:ring-ring"
                  rows={8}
                  value={editBody}
                  onChange={e => onBodyChange(e.target.value)}
                />
                <p className="text-xs text-muted-foreground text-right">{editBody.length} chars</p>
              </div>
            </div>

            <div className="flex gap-2 justify-end">
              <Button size="sm" variant="outline" onClick={onCancelEdit}>
                <X className="mr-1.5 h-3.5 w-3.5" /> Cancel
              </Button>
              <Button size="sm" disabled={savingId === draft.id} onClick={() => onSaveEdit(draft.id)}>
                <Check className="mr-1.5 h-3.5 w-3.5" />
                {savingId === draft.id ? "Saving..." : "Save"}
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <div className="grid grid-cols-2 gap-4">
              <div className="flex flex-col gap-1">
                <p className="text-xs font-medium flex items-center gap-1 text-muted-foreground">
                  <Twitter className="h-3 w-3" /> Twitter
                </p>
                <p className="text-sm whitespace-pre-wrap">{draft.hook}</p>
              </div>
              <div className="flex flex-col gap-1">
                <p className="text-xs font-medium flex items-center gap-1 text-muted-foreground">
                  <Linkedin className="h-3 w-3" /> LinkedIn
                </p>
                <p className="text-sm whitespace-pre-wrap text-muted-foreground leading-relaxed">{draft.body}</p>
              </div>
            </div>

            <div className="flex justify-end">
              <Button size="sm" variant="outline" className="gap-1.5" onClick={() => onEdit(draft)}>
                <Pencil className="h-3.5 w-3.5" /> Edit
              </Button>
            </div>
          </div>
        )}

      </CardContent>
    </Card>
  )
}
