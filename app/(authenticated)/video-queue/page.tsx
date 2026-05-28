"use client"

import React, { useState, useEffect } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import {
  scheduleVideoQueue, getVideoLibraryStatus, getVideoDrafts,
  updateDraft, deleteDraft, approveVideoDraft, rewriteDraftWithAI,
  publishNow, syncDriveFolder,
} from "@/lib/actions/agent"
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table"
import { CalendarDays, Video, Pencil, Trash2, Check, X, RefreshCw, Sparkles, Send, FolderSync } from "lucide-react"

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
  scheduledAt: Date | null
  status: string
}

type VideoStatus = {
  id: string; partner: string; title: string
  forcedNext: boolean; posted: boolean; publishedAt: Date | null
}

function driveEmbedUrl(url: string): string | null {
  const match = url.match(/\/d\/([^/?]+)/)
  return match ? `https://drive.google.com/file/d/${match[1]}/preview` : null
}

function fmtSlot(date: Date) {
  return new Date(date).toLocaleString("en-US", {
    timeZone: "America/Los_Angeles", weekday: "short",
    month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  }) + " PT"
}

export default function VideoQueuePage() {
  const [generating, setGenerating] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [syncMessage, setSyncMessage] = useState<string | null>(null)
  const [generateMessage, setGenerateMessage] = useState<string | null>(null)
  const [drafts, setDrafts] = useState<Draft[]>([])
  const [videos, setVideos] = useState<VideoStatus[]>([])
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editHook, setEditHook] = useState("")
  const [editBody, setEditBody] = useState("")
  const [savingId, setSavingId] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [approvingId, setApprovingId] = useState<string | null>(null)
  const [publishingId, setPublishingId] = useState<string | null>(null)
  const [publishResults, setPublishResults] = useState<Record<string, { twitter: boolean; linkedin: boolean }>>({})
  const [rewritingId, setRewritingId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

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
      const res = await scheduleVideoQueue()
      setGenerateMessage(res.scheduled > 0
        ? `${res.scheduled} draft${res.scheduled !== 1 ? "s" : ""} generated — review below`
        : (res.message ?? "No drafts generated"))
      await loadDrafts(); await loadVideos()
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setGenerating(false) }
  }

  async function handleApprove(id: string) {
    setApprovingId(id)
    await approveVideoDraft(id)
    await loadDrafts()
    setApprovingId(null)
  }

  async function handlePublishNow(id: string) {
    setPublishingId(id); setError(null)
    try {
      const result = await publishNow(id)
      setPublishResults(prev => ({ ...prev, [id]: { twitter: result.twitter, linkedin: result.linkedin } }))
      await loadDrafts()
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setPublishingId(null) }
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

  const pending = drafts.filter(d => d.status === "pending")
  const scheduled = drafts.filter(d => d.status === "scheduled")
  const unpostedCount = videos.filter(v => !v.posted).length

  const cardProps = { editingId, editHook, editBody, savingId, deletingId, approvingId, publishingId, publishResults, rewritingId, onEdit: startEdit, onCancelEdit: cancelEdit, onSaveEdit: saveEdit, onDelete: handleDelete, onApprove: handleApprove, onPublishNow: handlePublishNow, onRewrite: handleRewrite, onHookChange: setEditHook, onBodyChange: setEditBody }

  return (
    <div className="min-h-screen p-6 flex flex-col items-center">
      <div className="w-full max-w-2xl flex flex-col gap-8">

        <div>
          <h1 className="text-3xl font-bold mb-1">Video Queue</h1>
          <p className="text-muted-foreground">Sync from Drive, generate drafts, review, then publish.</p>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-3 gap-4">
          <Card><div className="p-4">
            <p className="text-xs text-muted-foreground mb-1">In library</p>
            <p className="text-2xl font-bold">{videos.length}</p>
            <p className="text-xs text-muted-foreground">{unpostedCount} unposted</p>
          </div></Card>
          <Card><div className="p-4">
            <p className="text-xs text-muted-foreground mb-1">Awaiting review</p>
            <p className="text-2xl font-bold">{pending.length}</p>
          </div></Card>
          <Card><div className="p-4">
            <p className="text-xs text-muted-foreground mb-1">Scheduled</p>
            <p className="text-2xl font-bold">{scheduled.length}</p>
          </div></Card>
        </div>

        {error && <p className="text-sm text-destructive">{error}</p>}

        {/* Actions */}
        <div className="flex flex-col gap-2">
          <Button variant="outline" onClick={handleSync} disabled={syncing} className="w-full">
            <FolderSync className={`mr-2 h-4 w-4 ${syncing ? "animate-spin" : ""}`} />
            {syncing ? "Syncing from Drive..." : "Sync from Google Drive"}
          </Button>
          {syncMessage && <p className="text-sm text-muted-foreground text-center">{syncMessage}</p>}

          <Button onClick={handleGenerate} disabled={generating} className="w-full">
            <CalendarDays className={`mr-2 h-4 w-4 ${generating ? "animate-pulse" : ""}`} />
            {generating ? "Generating drafts from transcripts..." : "Generate Drafts for Unposted Videos"}
          </Button>
          {generateMessage && <p className="text-sm text-muted-foreground text-center">{generateMessage}</p>}
        </div>

        {/* Pending review */}
        {pending.length > 0 && (
          <section className="flex flex-col gap-3">
            <h2 className="font-semibold text-sm text-muted-foreground uppercase tracking-wide">Awaiting Review · {pending.length}</h2>
            {pending.map(draft => <DraftCard key={draft.id} draft={draft} showApprove {...cardProps} />)}
          </section>
        )}

        {/* Approved / Scheduled — table view */}
        {scheduled.length > 0 && (
          <section className="flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <h2 className="font-semibold text-sm text-muted-foreground uppercase tracking-wide">Approved · {scheduled.length}</h2>
              <Button variant="ghost" size="sm" onClick={() => { loadDrafts(); loadVideos() }}>
                <RefreshCw className="h-3.5 w-3.5" />
              </Button>
            </div>
            <div className="rounded-lg border overflow-hidden">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[120px]">Partner</TableHead>
                    <TableHead>Video</TableHead>
                    <TableHead>Twitter</TableHead>
                    <TableHead className="w-[140px]">Scheduled</TableHead>
                    <TableHead className="w-[180px] text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {scheduled.map(draft => {
                    const result = publishResults[draft.id]
                    const isEditing = editingId === draft.id
                    return (
                      <React.Fragment key={draft.id}>
                        <TableRow className={isEditing ? "bg-muted/40" : undefined}>
                          <TableCell className="font-medium text-sm">{PARTNER_NAMES[draft.partner] || draft.partner}</TableCell>
                          <TableCell className="text-sm text-muted-foreground max-w-[160px] truncate">{draft.videoTitle ?? "—"}</TableCell>
                          <TableCell className="text-sm max-w-[260px]">
                            {isEditing
                              ? <span className="text-xs text-muted-foreground italic">editing...</span>
                              : <p className="truncate text-muted-foreground">{draft.hook.split("\n")[0]}</p>}
                            {result && !isEditing && (
                              <p className="text-xs mt-0.5 text-muted-foreground">
                                {result.twitter ? "✓ Twitter" : "✗ Twitter"} · {result.linkedin ? "✓ LinkedIn" : "✗ LinkedIn"}
                              </p>
                            )}
                          </TableCell>
                          <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                            {draft.scheduledAt ? fmtSlot(draft.scheduledAt) : "—"}
                          </TableCell>
                          <TableCell className="text-right">
                            <div className="flex items-center justify-end gap-1.5">
                              {!isEditing && (
                                <Button size="sm" className="h-7 px-2 gap-1 text-xs" disabled={publishingId === draft.id} onClick={() => handlePublishNow(draft.id)}>
                                  <Send className={`h-3 w-3 ${publishingId === draft.id ? "animate-pulse" : ""}`} />
                                  {publishingId === draft.id ? "..." : "Publish"}
                                </Button>
                              )}
                              {isEditing
                                ? <>
                                    <Button size="sm" className="h-7 px-2 gap-1 text-xs" disabled={savingId === draft.id} onClick={() => saveEdit(draft.id)}>
                                      <Check className="h-3 w-3" />{savingId === draft.id ? "..." : "Save"}
                                    </Button>
                                    <Button size="sm" variant="outline" className="h-7 px-2 gap-1 text-xs" onClick={cancelEdit}>
                                      <X className="h-3 w-3" /> Cancel
                                    </Button>
                                  </>
                                : <Button size="sm" variant="outline" className="h-7 px-2 gap-1 text-xs" onClick={() => startEdit(draft)}>
                                    <Pencil className="h-3 w-3" /> Edit
                                  </Button>
                              }
                              {!isEditing && (
                                <Button size="sm" variant="outline" className="h-7 px-2 gap-1 text-xs text-destructive border-destructive/30 hover:bg-destructive/10"
                                  disabled={deletingId === draft.id} onClick={() => handleDelete(draft.id)}>
                                  <Trash2 className="h-3 w-3" />
                                </Button>
                              )}
                            </div>
                          </TableCell>
                        </TableRow>
                        {isEditing && (
                          <TableRow>
                            <TableCell colSpan={5} className="bg-muted/40 pb-4">
                              <ScheduledEditPanel
                                draftId={draft.id}
                                hook={editHook}
                                body={editBody}
                                rewritingId={rewritingId}
                                onHookChange={setEditHook}
                                onBodyChange={setEditBody}
                                onRewrite={handleRewrite}
                              />
                            </TableCell>
                          </TableRow>
                        )}
                      </React.Fragment>
                    )
                  })}
                </TableBody>
              </Table>
            </div>
          </section>
        )}

        {/* Video library */}
        {videos.length > 0 && (
          <section className="flex flex-col gap-2">
            <h2 className="font-semibold text-sm text-muted-foreground uppercase tracking-wide flex items-center gap-2">
              <Video className="h-4 w-4" /> Library · {videos.length} total
            </h2>
            {videos.map(v => (
              <div key={v.id} className="flex items-center gap-3 rounded-lg border px-3 py-2">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{v.title}</p>
                  <p className="text-xs text-muted-foreground">{PARTNER_NAMES[v.partner] || v.partner}</p>
                </div>
                {v.posted
                  ? <Badge variant="default" className="shrink-0">Posted</Badge>
                  : <Badge variant="outline" className="shrink-0 text-muted-foreground">Unposted</Badge>}
              </div>
            ))}
          </section>
        )}
      </div>
    </div>
  )
}

// ─── DraftCard ────────────────────────────────────────────────────────────────

function DraftCard({
  draft, showApprove,
  editingId, editHook, editBody, savingId, deletingId, approvingId, publishingId, publishResults, rewritingId,
  onEdit, onCancelEdit, onSaveEdit, onDelete, onApprove, onPublishNow, onRewrite, onHookChange, onBodyChange,
}: {
  draft: Draft
  showApprove: boolean
  editingId: string | null
  editHook: string
  editBody: string
  savingId: string | null
  deletingId: string | null
  approvingId: string | null
  publishingId: string | null
  publishResults: Record<string, { twitter: boolean; linkedin: boolean }>
  rewritingId: string | null
  onEdit: (d: Draft) => void
  onCancelEdit: () => void
  onSaveEdit: (id: string) => void
  onDelete: (id: string) => void
  onApprove: (id: string) => void
  onPublishNow: (id: string) => void
  onRewrite: (id: string, instruction: string) => void
  onHookChange: (v: string) => void
  onBodyChange: (v: string) => void
}) {
  const isEditing = editingId === draft.id
  const embedUrl = draft.videoStorageUrl ? driveEmbedUrl(draft.videoStorageUrl) : null
  const [aiPrompt, setAiPrompt] = useState("")
  const result = publishResults[draft.id]

  return (
    <Card>
      <CardContent className="pt-4 flex flex-col gap-3">

        {/* Header */}
        <div className="flex items-start justify-between gap-2">
          <div className="flex flex-col gap-0.5 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <Badge variant="outline" className={showApprove ? "border-amber-400 text-amber-600" : "border-blue-400 text-blue-600"}>
                {showApprove ? "review" : "scheduled"}
              </Badge>
              <span className="text-xs font-medium text-muted-foreground">{PARTNER_NAMES[draft.partner] || draft.partner}</span>
            </div>
            {!showApprove && draft.scheduledAt && (
              <p className="text-xs text-muted-foreground">{fmtSlot(draft.scheduledAt)}</p>
            )}
          </div>

          {!isEditing && (
            <div className="flex flex-col items-end gap-1.5 shrink-0">
              <div className="flex items-center gap-2">
                {showApprove ? (
                  <Button size="sm" className="h-8 px-3 gap-1.5" disabled={approvingId === draft.id} onClick={() => onApprove(draft.id)}>
                    <Check className="h-3.5 w-3.5" />
                    {approvingId === draft.id ? "Scheduling..." : "Approve"}
                  </Button>
                ) : (
                  <Button size="sm" className="h-8 px-3 gap-1.5" disabled={publishingId === draft.id} onClick={() => onPublishNow(draft.id)}>
                    <Send className={`h-3.5 w-3.5 ${publishingId === draft.id ? "animate-pulse" : ""}`} />
                    {publishingId === draft.id ? "Publishing..." : "Publish Now"}
                  </Button>
                )}
                <Button size="sm" variant="outline" className="h-8 px-3 gap-1.5" onClick={() => onEdit(draft)}>
                  <Pencil className="h-3.5 w-3.5" /> Edit
                </Button>
                <Button size="sm" variant="outline" className="h-8 px-3 gap-1.5 text-destructive border-destructive/30 hover:bg-destructive/10"
                  disabled={deletingId === draft.id} onClick={() => onDelete(draft.id)}>
                  <Trash2 className="h-3.5 w-3.5" />
                  {deletingId === draft.id ? "..." : "Delete"}
                </Button>
              </div>
              {result && (
                <p className="text-xs text-muted-foreground">
                  {result.twitter ? "✓ Twitter" : "✗ Twitter failed"} · {result.linkedin ? "✓ LinkedIn" : "✗ LinkedIn failed"}
                </p>
              )}
            </div>
          )}
        </div>

        {/* Video preview */}
        {embedUrl && (
          <div className="rounded-md overflow-hidden bg-black aspect-video w-full">
            <iframe src={embedUrl} className="w-full h-full" allow="autoplay" allowFullScreen />
          </div>
        )}
        {draft.videoTitle && (
          <p className="text-xs text-muted-foreground -mt-1">
            <Video className="inline h-3 w-3 mr-1" />{draft.videoTitle}
          </p>
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

            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium text-muted-foreground">Twitter</label>
              <textarea className="w-full rounded-md border bg-background px-3 py-2 text-sm resize-none focus:outline-none focus:ring-1 focus:ring-ring"
                rows={3} value={editHook} onChange={e => onHookChange(e.target.value)} />
              <p className="text-xs text-muted-foreground text-right">{editHook.length} chars</p>
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium text-muted-foreground">LinkedIn</label>
              <textarea className="w-full rounded-md border bg-background px-3 py-2 text-sm resize-none focus:outline-none focus:ring-1 focus:ring-ring"
                rows={6} value={editBody} onChange={e => onBodyChange(e.target.value)} />
              <p className="text-xs text-muted-foreground text-right">{editBody.length} chars</p>
            </div>
            <div className="flex gap-2">
              <Button size="sm" disabled={savingId === draft.id} onClick={() => onSaveEdit(draft.id)} className="flex-1">
                <Check className="mr-1.5 h-3.5 w-3.5" />
                {savingId === draft.id ? "Saving..." : "Save"}
              </Button>
              <Button size="sm" variant="outline" onClick={onCancelEdit} className="flex-1">
                <X className="mr-1.5 h-3.5 w-3.5" /> Cancel
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1">
              <p className="text-xs font-medium text-muted-foreground">Twitter</p>
              <p className="text-sm whitespace-pre-wrap">{draft.hook}</p>
            </div>
            <div className="flex flex-col gap-1">
              <p className="text-xs font-medium text-muted-foreground">LinkedIn</p>
              <p className="text-sm whitespace-pre-wrap text-muted-foreground leading-relaxed">{draft.body}</p>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

// ─── ScheduledEditPanel (inline table row expansion) ─────────────────────────

function ScheduledEditPanel({
  draftId, hook, body, rewritingId, onHookChange, onBodyChange, onRewrite,
}: {
  draftId: string
  hook: string
  body: string
  rewritingId: string | null
  onHookChange: (v: string) => void
  onBodyChange: (v: string) => void
  onRewrite: (id: string, instruction: string) => void
}) {
  const [aiPrompt, setAiPrompt] = useState("")
  return (
    <div className="flex flex-col gap-3 pt-1">
      {/* AI prompt bar */}
      <div className="flex gap-2 p-3 rounded-lg bg-background border">
        <input
          type="text"
          placeholder='Tell AI what to change — e.g. "make it shorter" or "lead with the quote about AI costs"'
          className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          value={aiPrompt}
          onChange={e => setAiPrompt(e.target.value)}
          onKeyDown={e => {
            if (e.key === "Enter" && aiPrompt.trim() && rewritingId !== draftId) {
              onRewrite(draftId, aiPrompt.trim()); setAiPrompt("")
            }
          }}
        />
        <Button size="sm" variant="secondary" className="shrink-0 gap-1.5"
          disabled={!aiPrompt.trim() || rewritingId === draftId}
          onClick={() => { onRewrite(draftId, aiPrompt.trim()); setAiPrompt("") }}>
          <Sparkles className={`h-3.5 w-3.5 ${rewritingId === draftId ? "animate-pulse" : ""}`} />
          {rewritingId === draftId ? "Rewriting..." : "Rewrite"}
        </Button>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-muted-foreground">Twitter</label>
          <textarea className="w-full rounded-md border bg-background px-3 py-2 text-sm resize-none focus:outline-none focus:ring-1 focus:ring-ring"
            rows={4} value={hook} onChange={e => onHookChange(e.target.value)} />
          <p className="text-xs text-muted-foreground text-right">{hook.length} chars</p>
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-muted-foreground">LinkedIn</label>
          <textarea className="w-full rounded-md border bg-background px-3 py-2 text-sm resize-none focus:outline-none focus:ring-1 focus:ring-ring"
            rows={4} value={body} onChange={e => onBodyChange(e.target.value)} />
          <p className="text-xs text-muted-foreground text-right">{body.length} chars</p>
        </div>
      </div>
    </div>
  )
}
