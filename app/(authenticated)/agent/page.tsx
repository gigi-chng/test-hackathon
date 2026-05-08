"use client"

import { useState, useEffect } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { ingestPartnerBlog, ingestAllPartners } from "@/lib/actions/ingest"
import { type Partner } from "@/lib/partners"
import { getPendingDrafts, getAllDrafts, getContentCount, triggerPipeline } from "@/lib/actions/agent"
import { RefreshCw, Users, CheckCircle, AlertCircle, Zap, Clock, Send, Megaphone } from "lucide-react"
import Link from "next/link"

const PARTNERS: { key: Partner; name: string; sources: string[] }[] = [
  { key: "sam", name: "Sam Lessin", sources: ["wlessin.com", "@lessin"] },
  { key: "will", name: "Will Quist", sources: ["wquist.com", "@wquist", "LinkedIn"] },
  { key: "yoni", name: "Yoni Rechtman", sources: ["99d.substack.com", "@yrechtman", "LinkedIn"] },
  { key: "megan", name: "Megan Lightcap", sources: ["meganlightcap.com", "@mmlightcap", "LinkedIn"] },
]

const PARTNER_NAMES: Record<string, string> = {
  sam: "Sam Lessin", will: "Will Quist", yoni: "Yoni Rechtman", megan: "Megan Lightcap",
}

type IngestResult = { ingested: number; skipped: number }
type Status = "idle" | "loading" | "done" | "error"

type Draft = {
  id: string
  hook: string
  body: string
  partner: string
  partnerCitation: string
  status: string
  createdAt: Date
  videoId: string | null
}

type ContentCount = { partner: string; _count: { id: number } }

export default function AgentPage() {
  const [allStatus, setAllStatus] = useState<Status>("idle")
  const [partnerStatus, setPartnerStatus] = useState<Record<string, Status>>({})
  const [ingestResults, setIngestResults] = useState<Record<string, IngestResult>>({})
  const [pipelineStatus, setPipelineStatus] = useState<Status>("idle")
  const [pipelineResult, setPipelineResult] = useState<{ drafted: number; skipped: number; reason?: string } | null>(null)
  const [drafts, setDrafts] = useState<Draft[]>([])
  const [contentCounts, setContentCounts] = useState<ContentCount[]>([])
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    loadDrafts()
    loadContentCounts()
  }, [])

  async function loadDrafts() {
    const d = await getAllDrafts()
    setDrafts(d as Draft[])
  }

  async function loadContentCounts() {
    const c = await getContentCount()
    setContentCounts(c as ContentCount[])
  }

  async function handleIngestAll() {
    setAllStatus("loading")
    setError(null)
    try {
      const res = await ingestAllPartners()
      setIngestResults(res as Record<string, IngestResult>)
      setAllStatus("done")
      await loadContentCounts()
    } catch {
      setError("Ingestion failed. Check API keys and database connection.")
      setAllStatus("error")
    }
  }

  async function handleIngestOne(partner: Partner) {
    setPartnerStatus(prev => ({ ...prev, [partner]: "loading" }))
    try {
      const res = await ingestPartnerBlog(partner)
      setIngestResults(prev => ({ ...prev, [partner]: res }))
      setPartnerStatus(prev => ({ ...prev, [partner]: "done" }))
      await loadContentCounts()
    } catch {
      setPartnerStatus(prev => ({ ...prev, [partner]: "error" }))
    }
  }

  async function handleRunPipeline() {
    setPipelineStatus("loading")
    setPipelineResult(null)
    setError(null)
    try {
      const res = await triggerPipeline()
      setPipelineResult(res)
      setPipelineStatus("done")
      await loadDrafts()
    } catch (e) {
      setError(`Pipeline failed: ${e instanceof Error ? e.message : String(e)}`)
      setPipelineStatus("error")
    }
  }

  const pendingCount = drafts.filter(d => d.status === "pending").length
  const publishedCount = drafts.filter(d => d.status === "published").length

  return (
    <div className="min-h-screen p-6 flex flex-col items-center gap-6">
      <div className="w-full max-w-3xl">
        <div className="flex items-center justify-between mb-1">
          <h1 className="text-3xl font-bold">Slow Ventures Agent</h1>
          <Link href="/investment-announcements">
            <Button variant="outline" size="sm">
              <Megaphone className="mr-2 h-4 w-4" />
              New Announcement
            </Button>
          </Link>
        </div>
        <p className="text-muted-foreground mb-8">
          Manage the knowledge base and monitor post drafts.
        </p>

        {/* Stats row */}
        <div className="grid grid-cols-3 gap-4 mb-6">
          <Card>
            <CardContent className="pt-4">
              <p className="text-xs text-muted-foreground mb-1">Knowledge base</p>
              <p className="text-2xl font-bold">
                {contentCounts.reduce((s, c) => s + c._count.id, 0)}
              </p>
              <p className="text-xs text-muted-foreground">content chunks</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4">
              <p className="text-xs text-muted-foreground mb-1">Awaiting approval</p>
              <p className="text-2xl font-bold">{pendingCount}</p>
              <p className="text-xs text-muted-foreground">drafts</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4">
              <p className="text-xs text-muted-foreground mb-1">Published</p>
              <p className="text-2xl font-bold">{publishedCount}</p>
              <p className="text-xs text-muted-foreground">posts</p>
            </CardContent>
          </Card>
        </div>

        {/* Run pipeline */}
        <Card className="mb-6">
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Zap className="h-4 w-4" />
              Agent Pipeline
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <p className="text-sm text-muted-foreground">
              Scans trending VC/tech news, scores against partner knowledge base, and emails you drafts. Runs automatically 3× daily — or trigger manually here.
            </p>
            <Button
              onClick={handleRunPipeline}
              disabled={pipelineStatus === "loading"}
              className="w-full"
            >
              <Zap className={`mr-2 h-4 w-4 ${pipelineStatus === "loading" ? "animate-pulse" : ""}`} />
              {pipelineStatus === "loading" ? "Scanning trends..." : "Run Pipeline Now"}
            </Button>
            {pipelineResult && (
              <p className="text-sm text-muted-foreground">
                {pipelineResult.reason
                  ? pipelineResult.reason
                  : `${pipelineResult.drafted} draft${pipelineResult.drafted !== 1 ? "s" : ""} created · ${pipelineResult.skipped} signals skipped`}
              </p>
            )}
            {error && <p className="text-sm text-destructive">{error}</p>}
          </CardContent>
        </Card>

        {/* Drafts queue */}
        {drafts.length > 0 && (
          <Card className="mb-6">
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <Send className="h-4 w-4" />
                Draft Queue
              </CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              {drafts.map(draft => (
                <div key={draft.id} className="border rounded-lg p-4 flex flex-col gap-2">
                  <div className="flex items-center justify-between">
                    <Badge variant={
                      draft.status === "published" ? "default" :
                      draft.status === "pending" ? "secondary" :
                      draft.status === "rejected" ? "destructive" : "outline"
                    }>
                      {draft.status}
                    </Badge>
                    <div className="flex items-center gap-1 text-xs text-muted-foreground">
                      <Clock className="h-3 w-3" />
                      {new Date(draft.createdAt).toLocaleDateString()}
                    </div>
                  </div>
                  <p className="text-sm font-semibold">{draft.hook}</p>
                  <p className="text-sm text-muted-foreground leading-relaxed">{draft.body}</p>
                  <p className="text-xs text-muted-foreground">
                    Drawing on <strong>{PARTNER_NAMES[draft.partner] || draft.partner}</strong>
                    {draft.videoId && " · video attached"}
                  </p>
                </div>
              ))}
            </CardContent>
          </Card>
        )}

        {/* Knowledge base */}
        <Card className="mb-6">
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Users className="h-4 w-4" />
              Knowledge Base
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <p className="text-sm text-muted-foreground">
              Scrape and embed all partner content. Existing posts are skipped automatically.
            </p>
            <Button
              onClick={handleIngestAll}
              disabled={allStatus === "loading"}
              variant="outline"
              className="w-full"
            >
              <RefreshCw className={`mr-2 h-4 w-4 ${allStatus === "loading" ? "animate-spin" : ""}`} />
              {allStatus === "loading" ? "Ingesting all partners..." : "Sync All Partners"}
            </Button>

            <div className="grid grid-cols-2 gap-3">
              {PARTNERS.map(p => {
                const status = partnerStatus[p.key] || "idle"
                const result = ingestResults[p.key]
                const count = contentCounts.find(c => c.partner === p.key)?._count.id || 0

                return (
                  <div key={p.key} className="border rounded-lg p-3 flex flex-col gap-2">
                    <div className="flex items-center justify-between">
                      <p className="font-medium text-sm">{p.name}</p>
                      {status === "done" && <CheckCircle className="h-3.5 w-3.5 text-green-500" />}
                      {status === "error" && <AlertCircle className="h-3.5 w-3.5 text-destructive" />}
                    </div>
                    <div className="flex flex-wrap gap-1">
                      {p.sources.map(s => (
                        <Badge key={s} variant="secondary" className="text-xs">{s}</Badge>
                      ))}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {count} chunks stored
                      {result && ` · +${result.ingested} new`}
                    </p>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleIngestOne(p.key)}
                      disabled={status === "loading"}
                    >
                      <RefreshCw className={`mr-1.5 h-3 w-3 ${status === "loading" ? "animate-spin" : ""}`} />
                      {status === "loading" ? "Syncing..." : "Sync"}
                    </Button>
                  </div>
                )
              })}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
