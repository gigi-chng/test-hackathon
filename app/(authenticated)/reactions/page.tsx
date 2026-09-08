"use client"

import { useEffect, useState, useTransition } from "react"
import Link from "next/link"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Textarea } from "@/components/ui/textarea"
import { ArrowLeft, Loader2, Search, Mic, FileText, ExternalLink, PenLine, AlertTriangle } from "lucide-react"
import {
  findReactions,
  getSourceTypes,
  generatePov,
  type PartnerReaction,
  type Pov,
} from "@/lib/actions/reactions"
import type { Partner } from "@/lib/partners"

const TYPE_LABEL: Record<string, string> = {
  tweet: "tweet",
  blog: "blog",
  newsletter: "newsletter",
  podcast: "podcast",
  transcript: "spoken",
  press: "press",
}

export default function ReactionsPage() {
  const [text, setText] = useState("")
  const [result, setResult] = useState<{
    reactions: PartnerReaction[]
    searched: number
    transcriptShare: number
  } | null>(null)
  const [types, setTypes] = useState<{ sourceType: string; count: number }[]>([])
  const [excluded, setExcluded] = useState<string[]>([])
  const [povs, setPovs] = useState<Record<string, Pov>>({})
  const [drafting, setDrafting] = useState<string | null>(null)
  const [pending, start] = useTransition()

  useEffect(() => { getSourceTypes().then(setTypes) }, [])

  function search() {
    if (text.trim().length < 20) return
    start(async () => {
      const include = types.map(t => t.sourceType).filter(t => !excluded.includes(t))
      setPovs({})
      setResult(await findReactions(text, {
        sourceTypes: include.length === types.length ? undefined : include,
      }))
    })
  }

  async function draft(partner: Partner) {
    setDrafting(partner)
    try {
      const pov = await generatePov(text, partner)
      setPovs(prev => ({ ...prev, [partner]: pov }))
    } finally {
      setDrafting(null)
    }
  }

  function toggleType(t: string) {
    setExcluded(prev => (prev.includes(t) ? prev.filter(x => x !== t) : [...prev, t]))
  }

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-4xl mx-auto px-6 py-10">
        <Link href="/" className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground mb-6">
          <ArrowLeft className="h-4 w-4" /> Back
        </Link>

        <div className="mb-8">
          <h1 className="text-2xl font-semibold tracking-tight">Team reactions</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Paste a post to see what the team has already said about it, then draft the
            position that follows from it — in their voice, argued only from their own past
            work, with every claim cited back to the piece it came from.
          </p>
        </div>

        <Card className="p-6 space-y-4">
          <Textarea
            value={text}
            onChange={e => setText(e.target.value)}
            placeholder="Paste the post, article, or tweet you want a reaction to…"
            className="min-h-40"
          />

          {types.length > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-muted-foreground mr-1">Search:</span>
              {types.map(t => (
                <button
                  key={t.sourceType}
                  type="button"
                  onClick={() => toggleType(t.sourceType)}
                  className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${
                    excluded.includes(t.sourceType)
                      ? "border-input text-muted-foreground line-through"
                      : "border-primary/40 bg-primary/5 text-foreground"
                  }`}
                >
                  {TYPE_LABEL[t.sourceType] ?? t.sourceType} ({t.count})
                </button>
              ))}
            </div>
          )}

          <div className="flex items-center gap-3">
            <Button onClick={search} disabled={text.trim().length < 20 || pending}>
              {pending
                ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Searching</>
                : <><Search className="h-4 w-4 mr-2" />Find reactions</>}
            </Button>
            {text.trim().length > 0 && text.trim().length < 20 && (
              <span className="text-xs text-muted-foreground">A bit more text to go on.</span>
            )}
          </div>
        </Card>

        {result && (
          <div className="mt-8 space-y-4">
            <p className="text-xs text-muted-foreground">
              Searched {result.searched.toLocaleString()} pieces of content
              {result.transcriptShare > 0 &&
                ` · ${Math.round(result.transcriptShare * 100)}% from recordings`}
            </p>

            {result.reactions.map(r => (
              <Card key={r.partner} className="p-5">
                <div className="flex items-baseline justify-between gap-3 mb-3">
                  <h2 className="font-medium">{r.displayName}</h2>
                  <Badge variant={r.matches.length ? "secondary" : "outline"} className="text-xs">
                    {r.matches.length
                      ? `${r.topScore.toFixed(2)} best match`
                      : "nothing on topic"}
                  </Badge>
                </div>

                {r.matches.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    No material close enough to this to be worth showing.
                  </p>
                ) : (
                  <>
                    <PovBlock
                      pov={povs[r.partner]}
                      drafting={drafting === r.partner}
                      onDraft={() => draft(r.partner)}
                    />
                    <ul className="space-y-3">
                    {r.matches.map((m, i) => (
                      <li key={i} className="border-l-2 border-muted pl-3">
                        <div className="flex items-center gap-2 flex-wrap text-xs text-muted-foreground mb-1">
                          {m.sourceType === "transcript"
                            ? <Mic className="h-3 w-3" />
                            : <FileText className="h-3 w-3" />}
                          <span className="font-medium text-foreground">
                            {TYPE_LABEL[m.sourceType] ?? m.sourceType}
                          </span>
                          {m.title && <span className="truncate max-w-xs">{m.title}</span>}
                          {m.publishedAt && <span>· {new Date(m.publishedAt).toLocaleDateString()}</span>}
                          <span>· {m.score.toFixed(2)}</span>
                          {m.sourceUrl && !m.sourceUrl.startsWith("transcript:") && (
                            <a href={m.sourceUrl} target="_blank" rel="noopener noreferrer"
                              className="inline-flex items-center gap-1 hover:text-foreground">
                              <ExternalLink className="h-3 w-3" />
                            </a>
                          )}
                        </div>
                        <p className="text-sm">{m.excerpt}…</p>
                      </li>
                      ))}
                    </ul>
                  </>
                )}
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function PovBlock({
  pov,
  drafting,
  onDraft,
}: {
  pov?: Pov
  drafting: boolean
  onDraft: () => void
}) {
  if (!pov) {
    return (
      <Button size="sm" variant="secondary" onClick={onDraft} disabled={drafting} className="mb-4">
        {drafting
          ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Working out their position</>
          : <><PenLine className="h-4 w-4 mr-2" />Draft their POV</>}
      </Button>
    )
  }

  // Refused rather than invented. Shown as its own state so a thin evidence
  // base doesn't get mistaken for a considered position.
  if (!pov.enoughBasis) {
    return (
      <div className="mb-4 flex gap-3 rounded-md border border-amber-500/40 bg-amber-500/5 p-4 text-sm">
        <AlertTriangle className="h-4 w-4 text-amber-600 shrink-0 mt-0.5" />
        <div>
          <p className="font-medium">Not enough of their own material to argue from</p>
          <p className="text-muted-foreground mt-1">{pov.note}</p>
        </div>
      </div>
    )
  }

  return (
    <div className="mb-5 rounded-md border bg-muted/30 p-4 space-y-3">
      <p className="text-[15px] leading-relaxed font-medium">{pov.thesis}</p>

      <div>
        <p className="text-xs uppercase tracking-wide text-muted-foreground mb-1">Why</p>
        <p className="text-sm leading-relaxed">{pov.argument}</p>
      </div>

      <div>
        <p className="text-xs uppercase tracking-wide text-muted-foreground mb-1">
          Cuts against
        </p>
        <p className="text-sm leading-relaxed">{pov.contrarian}</p>
      </div>

      {pov.rootedIn.length > 0 && (
        <div className="border-t pt-3">
          <p className="text-xs uppercase tracking-wide text-muted-foreground mb-2">
            Built from — the bracketed numbers above
          </p>
          <ul className="space-y-1.5">
            {pov.rootedIn.map(m => (
              <li key={m.n} className="text-xs text-muted-foreground">
                <span className="font-medium text-foreground">[{m.n}]</span>{" "}
                {TYPE_LABEL[m.sourceType] ?? m.sourceType}
                {m.title && ` · ${m.title}`}
                {m.publishedAt && ` · ${new Date(m.publishedAt).toLocaleDateString()}`}
                {m.sourceUrl && !m.sourceUrl.startsWith("transcript:") && (
                  <a href={m.sourceUrl} target="_blank" rel="noopener noreferrer"
                    className="ml-1 inline-flex hover:text-foreground">
                    <ExternalLink className="h-3 w-3" />
                  </a>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {pov.note && <p className="text-xs text-amber-600">{pov.note}</p>}
    </div>
  )
}
