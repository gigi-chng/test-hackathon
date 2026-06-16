"use client"

import React, { useState, useEffect } from "react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { generateFromVideo, saveDraft } from "@/lib/actions/content-generator"
import { getVideoDrafts, deleteDraft, updateDraft, rewriteDraftWithAI } from "@/lib/actions/agent"
import {
  Twitter,
  Linkedin,
  Sparkles,
  Trash2,
  Check,
  X,
  Pencil,
  Copy,
  BookmarkPlus,
  TrendingUp,
  ChevronDown,
  ChevronUp,
} from "lucide-react"

type Partner = "sam" | "will" | "yoni" | "megan"

type TweetResult = {
  id: string
  text: string
  url: string
  author: string
  likes: number
  retweets: number
}

type GenerateResult = {
  tweets: TweetResult[]
  xDraft: string
  linkedinDraft: string
  citation: string
  videoTitle: string
}

type SavedDraft = {
  id: string
  hook: string
  body: string
  partner: string
  quoteTweetUrl: string | null
  createdAt: Date
}

const PARTNER_DISPLAY: Record<Partner, { name: string; handle: string }> = {
  sam: { name: "Sam Lessin", handle: "@lessin" },
  will: { name: "Will Quist", handle: "@wquist" },
  yoni: { name: "Yoni Rechtman", handle: "@yrechtman" },
  megan: { name: "Megan Lightcap", handle: "@mmlightcap" },
}

export default function VideoQueuePage() {
  const [partner, setPartner] = useState<Partner>("sam")
  const [videoInput, setVideoInput] = useState("")
  const [generating, setGenerating] = useState(false)
  const [result, setResult] = useState<GenerateResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selectedTweetId, setSelectedTweetId] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [savedDrafts, setSavedDrafts] = useState<SavedDraft[]>([])
  const [showSavedDrafts, setShowSavedDrafts] = useState(false)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editHook, setEditHook] = useState("")
  const [editBody, setEditBody] = useState("")
  const [savingId, setSavingId] = useState<string | null>(null)
  const [rewritingId, setRewritingId] = useState<string | null>(null)

  useEffect(() => {
    loadSavedDrafts()
  }, [])

  async function loadSavedDrafts() {
    const drafts = await getVideoDrafts()
    setSavedDrafts(
      drafts.map((d) => ({
        id: d.id,
        hook: d.hook,
        body: d.body,
        partner: d.partner,
        quoteTweetUrl: d.quoteTweetUrl,
        createdAt: d.createdAt,
      }))
    )
  }

  async function handleGenerate() {
    if (!videoInput.trim()) return
    setGenerating(true)
    setResult(null)
    setError(null)
    setSelectedTweetId(null)
    try {
      const res = await generateFromVideo(videoInput.trim(), partner)
      setResult(res)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setGenerating(false)
    }
  }

  async function handleSave() {
    if (!result) return
    setSaving(true)
    try {
      const selectedTweet = result.tweets.find((t) => t.id === selectedTweetId)
      await saveDraft({
        hook: result.xDraft,
        body: result.linkedinDraft,
        partner,
        citation: result.citation,
        quoteTweetUrl: selectedTweet?.url,
        quoteTweetId: selectedTweet?.id,
      })
      await loadSavedDrafts()
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete(id: string) {
    setDeletingId(id)
    await deleteDraft(id)
    await loadSavedDrafts()
    setDeletingId(null)
  }

  function startEdit(draft: SavedDraft) {
    setEditingId(draft.id)
    setEditHook(draft.hook)
    setEditBody(draft.body)
  }

  function cancelEdit() {
    setEditingId(null)
  }

  async function saveEdit(id: string) {
    setSavingId(id)
    await updateDraft(id, { hook: editHook, body: editBody })
    await loadSavedDrafts()
    setSavingId(null)
    setEditingId(null)
  }

  async function handleRewrite(id: string, instruction: string) {
    setRewritingId(id)
    try {
      const res = await rewriteDraftWithAI(id, instruction)
      setEditHook(res.hook)
      setEditBody(res.body)
    } finally {
      setRewritingId(null)
    }
  }

  return (
    <div className="min-h-screen p-6 flex flex-col items-center">
      <div className="w-full max-w-3xl flex flex-col gap-8">

        {/* Header */}
        <div>
          <h1 className="text-3xl font-bold mb-1">Content Generator</h1>
          <p className="text-muted-foreground">
            Drop a video, get tweet options and ready-to-post drafts in the partner&apos;s voice.
          </p>
        </div>

        {/* Partner selector */}
        <div className="flex gap-2">
          {(["sam", "will", "yoni", "megan"] as Partner[]).map((p) => (
            <button
              key={p}
              onClick={() => setPartner(p)}
              className={`px-4 py-2 rounded-full text-sm font-medium border transition-colors
                ${
                  partner === p
                    ? "bg-foreground text-background border-foreground"
                    : "bg-background text-muted-foreground border-border hover:border-foreground/50"
                }`}
            >
              {PARTNER_DISPLAY[p].name.split(" ")[0]}
            </button>
          ))}
        </div>

        {/* Video input */}
        <div className="flex flex-col gap-2">
          <textarea
            placeholder="Paste a Drive link, transcript, or notes about the video..."
            className="w-full rounded-lg border bg-background px-4 py-3 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-ring min-h-[120px]"
            value={videoInput}
            onChange={(e) => setVideoInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && e.metaKey) handleGenerate()
            }}
          />
          <Button
            onClick={handleGenerate}
            disabled={generating || !videoInput.trim()}
            className="self-end gap-2"
          >
            <TrendingUp className="h-4 w-4" />
            {generating ? "Finding tweets & drafting..." : "Generate"}
          </Button>
        </div>

        {error && <p className="text-sm text-destructive">{error}</p>}

        {/* Results */}
        {result && (
          <div className="flex flex-col gap-6">

            {/* Tweet options */}
            {result.tweets.length > 0 && (
              <div className="flex flex-col gap-3">
                <h2 className="font-semibold">Quote tweet options</h2>
                <p className="text-xs text-muted-foreground -mt-2">
                  Select one to post as a quote reply, or skip and post standalone.
                </p>
                <div className="flex flex-col gap-2">
                  {result.tweets.map((tweet) => (
                    <div
                      key={tweet.id}
                      onClick={() =>
                        setSelectedTweetId(selectedTweetId === tweet.id ? null : tweet.id)
                      }
                      className={`rounded-lg border p-3 cursor-pointer transition-colors flex flex-col gap-1.5
                        ${
                          selectedTweetId === tweet.id
                            ? "border-foreground bg-muted/40"
                            : "hover:bg-muted/20"
                        }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-xs font-medium text-muted-foreground">
                          @{tweet.author}
                        </span>
                        <div className="flex items-center gap-2 text-xs text-muted-foreground">
                          <span>♥ {tweet.likes.toLocaleString()}</span>
                          <span>🔁 {tweet.retweets.toLocaleString()}</span>
                          <a
                            href={tweet.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={(e) => e.stopPropagation()}
                            className="text-blue-500 hover:underline"
                          >
                            View →
                          </a>
                        </div>
                      </div>
                      <p className="text-sm leading-relaxed">{tweet.text}</p>
                      {selectedTweetId === tweet.id && (
                        <span className="text-xs text-foreground font-medium">
                          ✓ Selected as quote tweet
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Drafts */}
            <div className="flex flex-col gap-3">
              <h2 className="font-semibold">Drafts</h2>
              {result.citation && (
                <p className="text-xs text-muted-foreground italic">
                  Built around: &ldquo;
                  {result.citation.slice(0, 120)}
                  {result.citation.length > 120 ? "..." : ""}&rdquo;
                </p>
              )}
              <div className="grid grid-cols-2 gap-4">
                <div className="flex flex-col gap-2">
                  <div className="flex items-center justify-between">
                    <p className="text-xs font-medium flex items-center gap-1">
                      <Twitter className="h-3 w-3" /> X / Twitter
                    </p>
                    <button
                      onClick={() => navigator.clipboard.writeText(result.xDraft)}
                      className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1"
                    >
                      <Copy className="h-3 w-3" /> Copy
                    </button>
                  </div>
                  <div className="rounded-lg border bg-muted/20 p-3 text-sm whitespace-pre-wrap leading-relaxed min-h-[120px]">
                    {result.xDraft}
                  </div>
                  <p className="text-xs text-muted-foreground text-right">
                    {result.xDraft.length} chars
                  </p>
                </div>
                <div className="flex flex-col gap-2">
                  <div className="flex items-center justify-between">
                    <p className="text-xs font-medium flex items-center gap-1">
                      <Linkedin className="h-3 w-3" /> LinkedIn
                    </p>
                    <button
                      onClick={() => navigator.clipboard.writeText(result.linkedinDraft)}
                      className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1"
                    >
                      <Copy className="h-3 w-3" /> Copy
                    </button>
                  </div>
                  <div className="rounded-lg border bg-muted/20 p-3 text-sm whitespace-pre-wrap leading-relaxed min-h-[120px]">
                    {result.linkedinDraft}
                  </div>
                  <p className="text-xs text-muted-foreground text-right">
                    {result.linkedinDraft.length} chars
                  </p>
                </div>
              </div>
              <div className="flex justify-end">
                <Button onClick={handleSave} disabled={saving} variant="outline" className="gap-2">
                  <BookmarkPlus className="h-4 w-4" />
                  {saved ? "Saved!" : saving ? "Saving..." : "Save Draft"}
                </Button>
              </div>
            </div>
          </div>
        )}

        {/* Saved drafts — collapsible */}
        {savedDrafts.length > 0 && (
          <div className="border-t pt-6">
            <button
              onClick={() => setShowSavedDrafts(!showSavedDrafts)}
              className="flex items-center gap-2 text-sm font-medium text-muted-foreground hover:text-foreground w-full"
            >
              {showSavedDrafts ? (
                <ChevronUp className="h-4 w-4" />
              ) : (
                <ChevronDown className="h-4 w-4" />
              )}
              Saved Drafts ({savedDrafts.length})
            </button>

            {showSavedDrafts && (
              <div className="flex flex-col gap-3 mt-3">
                {savedDrafts.map((draft) => (
                  <SavedDraftCard
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
                ))}
              </div>
            )}
          </div>
        )}

      </div>
    </div>
  )
}

// ─── SavedDraftCard ───────────────────────────────────────────────────────────

type SavedDraftCardProps = {
  draft: SavedDraft
  editingId: string | null
  editHook: string
  editBody: string
  savingId: string | null
  deletingId: string | null
  rewritingId: string | null
  onEdit: (d: SavedDraft) => void
  onCancelEdit: () => void
  onSaveEdit: (id: string) => void
  onDelete: (id: string) => void
  onRewrite: (id: string, instruction: string) => void
  onHookChange: (v: string) => void
  onBodyChange: (v: string) => void
}

function SavedDraftCard({
  draft,
  editingId,
  editHook,
  editBody,
  savingId,
  deletingId,
  rewritingId,
  onEdit,
  onCancelEdit,
  onSaveEdit,
  onDelete,
  onRewrite,
  onHookChange,
  onBodyChange,
}: SavedDraftCardProps) {
  const isEditing = editingId === draft.id
  const [aiPrompt, setAiPrompt] = useState("")

  const partnerNames: Record<string, string> = {
    sam: "Sam Lessin",
    will: "Will Quist",
    yoni: "Yoni Rechtman",
    megan: "Megan Lightcap",
  }

  return (
    <div className="rounded-lg border bg-card p-4 flex flex-col gap-3">
      {/* Header */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-medium">
            {partnerNames[draft.partner] || draft.partner}
          </span>
          {draft.quoteTweetUrl && (
            <a
              href={draft.quoteTweetUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-xs text-blue-500 hover:underline"
            >
              <Twitter className="h-3 w-3" />
              Quote tweet
            </a>
          )}
          <Badge variant="outline" className="text-xs">
            {new Date(draft.createdAt).toLocaleDateString()}
          </Badge>
        </div>
        {!isEditing && (
          <button
            onClick={() => onDelete(draft.id)}
            disabled={deletingId === draft.id}
            className="text-muted-foreground hover:text-destructive transition-colors disabled:opacity-50"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        )}
      </div>

      {/* Content */}
      {isEditing ? (
        <div className="flex flex-col gap-3">
          {/* AI rewrite bar */}
          <div className="flex gap-2 p-3 rounded-lg bg-muted/50 border">
            <input
              type="text"
              placeholder='Tell AI what to change — e.g. "make it shorter" or "lead with the quote about AI costs"'
              className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
              value={aiPrompt}
              onChange={(e) => setAiPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && aiPrompt.trim() && rewritingId !== draft.id) {
                  onRewrite(draft.id, aiPrompt.trim())
                  setAiPrompt("")
                }
              }}
            />
            <Button
              size="sm"
              variant="secondary"
              className="shrink-0 gap-1.5"
              disabled={!aiPrompt.trim() || rewritingId === draft.id}
              onClick={() => {
                onRewrite(draft.id, aiPrompt.trim())
                setAiPrompt("")
              }}
            >
              <Sparkles
                className={`h-3.5 w-3.5 ${rewritingId === draft.id ? "animate-pulse" : ""}`}
              />
              {rewritingId === draft.id ? "Rewriting..." : "Rewrite"}
            </Button>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium flex items-center gap-1">
                <Twitter className="h-3 w-3" /> X / Twitter
              </label>
              <textarea
                className="w-full rounded-md border bg-background px-3 py-2 text-sm resize-none focus:outline-none focus:ring-1 focus:ring-ring"
                rows={5}
                value={editHook}
                onChange={(e) => onHookChange(e.target.value)}
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
                onChange={(e) => onBodyChange(e.target.value)}
              />
              <p className="text-xs text-muted-foreground text-right">{editBody.length} chars</p>
            </div>
          </div>

          <div className="flex gap-2 justify-end">
            <Button size="sm" variant="outline" onClick={onCancelEdit}>
              <X className="mr-1.5 h-3.5 w-3.5" /> Cancel
            </Button>
            <Button
              size="sm"
              disabled={savingId === draft.id}
              onClick={() => onSaveEdit(draft.id)}
            >
              <Check className="mr-1.5 h-3.5 w-3.5" />
              {savingId === draft.id ? "Saving..." : "Save"}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="grid grid-cols-2 gap-4">
            <div className="flex flex-col gap-1.5">
              <p className="text-xs font-medium flex items-center gap-1 text-muted-foreground">
                <Twitter className="h-3 w-3" /> X / Twitter
              </p>
              <p className="text-sm whitespace-pre-wrap leading-relaxed">{draft.hook}</p>
            </div>
            <div className="flex flex-col gap-1.5">
              <p className="text-xs font-medium flex items-center gap-1 text-muted-foreground">
                <Linkedin className="h-3 w-3" /> LinkedIn
              </p>
              <p className="text-sm whitespace-pre-wrap leading-relaxed text-muted-foreground">
                {draft.body}
              </p>
            </div>
          </div>
          <div className="flex justify-end">
            <Button size="sm" variant="outline" className="gap-1.5" onClick={() => onEdit(draft)}>
              <Pencil className="h-3.5 w-3.5" /> Edit
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
