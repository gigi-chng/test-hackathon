"use client"

import { useEffect, useState, useTransition } from "react"
import Link from "next/link"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Textarea } from "@/components/ui/textarea"
import { ArrowLeft, Loader2, Search, Mic, FileText, ExternalLink } from "lucide-react"
import {
  findReactions,
  getSourceTypes,
  type PartnerReaction,
} from "@/lib/actions/reactions"

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
  const [pending, start] = useTransition()

  useEffect(() => { getSourceTypes().then(setTypes) }, [])

  function search() {
    if (text.trim().length < 20) return
    start(async () => {
      const include = types.map(t => t.sourceType).filter(t => !excluded.includes(t))
      setResult(await findReactions(text, {
        sourceTypes: include.length === types.length ? undefined : include,
      }))
    })
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
            Paste a post and see what the team has already said about it — writing and
            spoken material from recordings, ranked by how close it is. Everything shown is
            something they actually said; nothing here is generated.
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
                )}
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
