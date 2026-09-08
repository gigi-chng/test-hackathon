"use client"

import { useEffect, useState, useTransition } from "react"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Card } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Loader2, RefreshCw, AlertTriangle, CheckCircle2, Radio, Trash2, KeyRound,
} from "lucide-react"
import {
  listRiversideProjects,
  setSelectedProjects,
  syncRiverside,
  type ProductionGroup,
  type SyncResult,
} from "@/lib/actions/riverside-sync"
import {
  confirmTranscript,
  deleteTranscript,
  type PendingTranscript,
} from "@/lib/actions/transcripts"

const PARTNER_KEYS = ["sam", "will", "yoni", "megan"] as const
const PARTNER_NAMES: Record<string, string> = {
  sam: "Sam Lessin", will: "Will Quist", yoni: "Yoni Rechtman", megan: "Megan Lightcap",
}

// ─── Connection + scope picker ───────────────────────────────────────────────

export function RiversideSettings({ onSynced }: { onSynced: () => void }) {
  const [productions, setProductions] = useState<ProductionGroup[]>([])
  const [selected, setSelected] = useState<string[]>([])
  const [prefilled, setPrefilled] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [result, setResult] = useState<SyncResult | null>(null)
  const [pending, start] = useTransition()

  useEffect(() => {
    listRiversideProjects().then(async res => {
      if (!res.ok) {
        setError(res.reason)
        setLoading(false)
        return
      }
      setProductions(res.productions)

      // First run: tick our own production so the default is "just Slow"
      // rather than either nothing or the entire account.
      if (res.selected.length === 0 && res.suggested.length > 0) {
        setSelected(res.suggested)
        setPrefilled(true)
        await setSelectedProjects(res.suggested)
      } else {
        setSelected(res.selected)
      }
      setLoading(false)
    })
  }, [])

  function toggle(id: string) {
    const next = selected.includes(id)
      ? selected.filter(s => s !== id)
      : [...selected, id]
    setSelected(next)
    setPrefilled(false)
    start(async () => { await setSelectedProjects(next) })
  }

  function sync() {
    start(async () => {
      setResult(await syncRiverside())
      onSynced()
    })
  }

  if (loading) {
    return (
      <Card className="p-6 flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Checking Riverside
      </Card>
    )
  }

  if (error) {
    return (
      <Card className="p-6">
        <div className="flex gap-3 text-sm">
          <KeyRound className="h-4 w-4 text-amber-600 shrink-0 mt-0.5" />
          <div>
            {error === "NO_KEY" ? (
              <>
                <p className="font-medium">Riverside isn&apos;t connected yet</p>
                <p className="text-muted-foreground mt-1">
                  Add <code className="text-xs">RIVERSIDE_API_KEY</code> to{" "}
                  <code className="text-xs">.env</code> and to Vercel. Copy the existing key
                  from Riverside &rarr; Settings &rarr; Developers. Don&apos;t regenerate it —
                  the workspace has one shared key and regenerating would break whoever else
                  is using it.
                </p>
              </>
            ) : error === "BAD_KEY" ? (
              <>
                <p className="font-medium text-amber-700">Riverside rejected the key</p>
                <p className="text-muted-foreground mt-1">
                  It was probably regenerated in Settings &rarr; Developers. Copy the new value
                  into <code className="text-xs">RIVERSIDE_API_KEY</code> in Vercel — nothing
                  imports until that&apos;s done.
                </p>
              </>
            ) : (
              <>
                <p className="font-medium">Couldn&apos;t reach Riverside</p>
                <p className="text-muted-foreground mt-1">{error}</p>
              </>
            )}
          </div>
        </div>
      </Card>
    )
  }

  return (
    <Card className="p-6 space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-sm font-medium flex items-center gap-2">
            <Radio className="h-4 w-4 text-emerald-600" /> Riverside connected
          </p>
          <p className="text-xs text-muted-foreground mt-1">
            Runs daily. Only the productions ticked below are pulled — everything else in the
            workspace is ignored.
          </p>
        </div>
        <Button size="sm" variant="secondary" onClick={sync} disabled={pending}>
          {pending
            ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Syncing</>
            : <><RefreshCw className="h-4 w-4 mr-2" />Sync now</>}
        </Button>
      </div>

      {productions.length === 0 ? (
        <p className="text-xs text-muted-foreground border-t pt-4">
          No productions found in this workspace.
        </p>
      ) : (
        <div className="space-y-4 border-t pt-4">
          {prefilled && (
            <p className="text-xs text-muted-foreground">
              Pre-selected the Slow production. Untick it or pick individual projects instead.
            </p>
          )}
          {productions.map(prod => {
            const whole = selected.includes(prod.id)
            return (
              <div key={prod.id} className="space-y-2">
                <label className="flex items-center gap-3 text-sm cursor-pointer">
                  <Checkbox checked={whole} onCheckedChange={() => toggle(prod.id)} />
                  <span className="flex-1 min-w-0 truncate font-medium">{prod.name}</span>
                  <span className="text-xs text-muted-foreground shrink-0">
                    {prod.recordings} recording{prod.recordings === 1 ? "" : "s"}
                  </span>
                </label>

                {prod.scopes.length > 0 && (
                  <div className="pl-7 space-y-1.5">
                    {prod.scopes.map(scope => (
                      <label
                        key={scope.id}
                        className={`flex items-center gap-3 text-sm ${
                          whole ? "opacity-50" : "cursor-pointer"
                        }`}
                      >
                        <Checkbox
                          checked={whole || selected.includes(scope.id)}
                          disabled={whole}
                          onCheckedChange={() => toggle(scope.id)}
                        />
                        <span className="flex-1 min-w-0 truncate text-muted-foreground">
                          {scope.label}
                        </span>
                        <span className="text-xs text-muted-foreground shrink-0">
                          {scope.recordings}
                        </span>
                      </label>
                    ))}
                    {whole && (
                      <p className="text-xs text-muted-foreground pt-0.5">
                        All of these are included, plus anything added later.
                      </p>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {result && (
        <div
          className={`flex gap-3 rounded-md border p-4 text-sm ${
            result.authFailed
              ? "border-red-500/40 bg-red-500/5"
              : "border-emerald-500/40 bg-emerald-500/5"
          }`}
        >
          {result.authFailed
            ? <AlertTriangle className="h-4 w-4 text-red-600 shrink-0 mt-0.5" />
            : <CheckCircle2 className="h-4 w-4 text-emerald-600 shrink-0 mt-0.5" />}
          <div>
            {result.authFailed ? (
              <p className="font-medium text-red-700">
                API key rejected — the shared key was probably rotated.
              </p>
            ) : result.noProjectsSelected ? (
              <p className="font-medium">
                Nothing ticked, so nothing was pulled. Pick a production above.
              </p>
            ) : (
              <>
                <p className="font-medium">
                  {result.autoConfirmed} extracted, {result.queued} need mapping
                </p>
                <p className="text-muted-foreground mt-1 text-xs">
                  {result.checked} recordings checked · {result.skipped} already imported
                  {result.deferred > 0 && ` · ${result.deferred} left for the next run`}
                  {result.notReady > 0 && ` · ${result.notReady} still transcribing`}
                </p>
              </>
            )}
            {result.errors.map(e => (
              <p key={e} className="text-amber-600 text-xs mt-1">{e}</p>
            ))}
          </div>
        </div>
      )}
    </Card>
  )
}

// ─── Review queue ────────────────────────────────────────────────────────────

export function PendingQueue({
  rows,
  onChange,
}: {
  rows: PendingTranscript[]
  onChange: () => void
}) {
  if (rows.length === 0) return null

  return (
    <div className="mt-10">
      <h2 className="text-sm font-medium mb-1">
        Needs speaker mapping
        <Badge variant="secondary" className="ml-2">{rows.length}</Badge>
      </h2>
      <p className="text-xs text-muted-foreground mb-3">
        Pulled from Riverside. Each new name only needs confirming once — after that it&apos;s
        remembered and future recordings import on their own.
      </p>
      <div className="space-y-3">
        {rows.map(row => (
          <PendingRow key={row.id} row={row} onChange={onChange} />
        ))}
      </div>
    </div>
  )
}

function PendingRow({ row, onChange }: { row: PendingTranscript; onChange: () => void }) {
  const [map, setMap] = useState<Record<string, string>>(row.seeded)
  const [pending, start] = useTransition()

  const mapped = Object.entries(map).filter(([, v]) => v)

  function confirm() {
    start(async () => {
      await confirmTranscript(row.id, map)
      onChange()
    })
  }

  function remove() {
    start(async () => {
      await deleteTranscript(row.id)
      onChange()
    })
  }

  return (
    <Card className="p-5 space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="font-medium text-sm truncate">{row.title}</p>
          <p className="text-xs text-muted-foreground mt-1">
            {row.recordedAt ? new Date(row.recordedAt).toLocaleDateString() : "no date"}
            {" · "}{row.words.toLocaleString()} words
            {row.sourceProject && ` · ${row.sourceProject}`}
            {" · "}<Badge variant="secondary" className="text-xs">{row.source}</Badge>
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={remove} disabled={pending}
          title="Discard this recording">
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>

      {row.unlabeled ? (
        <div className="flex gap-3 rounded-md border border-amber-500/40 bg-amber-500/5 p-4 text-sm">
          <AlertTriangle className="h-4 w-4 text-amber-600 shrink-0 mt-0.5" />
          <div>
            <p className="font-medium">Riverside&apos;s transcript has no speaker labels</p>
            <p className="text-muted-foreground mt-1">
              There&apos;s no way to tell who said what, so nothing can be attributed.
              Discard it, or export the per-participant tracks from Riverside and paste
              them in one at a time.
            </p>
          </div>
        </div>
      ) : (
        <div className="space-y-3 border-t pt-4">
          {row.anonymous && (
            <div className="flex gap-3 rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-xs">
              <AlertTriangle className="h-4 w-4 text-amber-600 shrink-0 mt-0.5" />
              <p className="text-muted-foreground">
                Riverside labelled this one by position, not by name. &ldquo;Speaker 1&rdquo;
                means a different person in every recording, so these are never remembered —
                check the sample quotes below, or the recording itself, before mapping.
              </p>
            </div>
          )}
          {PARTNER_KEYS.map(p => (
            <div key={p} className="grid grid-cols-3 gap-3 items-center">
              <Label className="text-sm">{PARTNER_NAMES[p]}</Label>
              <select
                className="col-span-2 h-9 rounded-md border border-input bg-background px-3 text-sm"
                value={map[p] ?? ""}
                onChange={e => setMap({ ...map, [p]: e.target.value })}
              >
                <option value="">Not in this recording</option>
                {row.speakers.map(s => (
                  <option key={s.label} value={s.label}>
                    {s.label} — {s.words.toLocaleString()} words
                  </option>
                ))}
              </select>
            </div>
          ))}

          <details className="text-xs text-muted-foreground" open={row.anonymous}>
            <summary className="cursor-pointer">
              Detected {row.speakers.length} speaker{row.speakers.length === 1 ? "" : "s"}
            </summary>
            <ul className="mt-2 space-y-3">
              {row.speakers.map(s => (
                <li key={s.label}>
                  <span className="font-medium text-foreground">{s.label}</span>
                  {" · "}{s.words.toLocaleString()} words
                  <div className="italic opacity-75">&ldquo;{s.sample}&hellip;&rdquo;</div>
                  {row.audioLabels.includes(s.label) && (
                    // Riverside keeps one track per voice, so this is that
                    // person alone — the only reliable way to place a
                    // "Speaker 1" without opening Riverside.
                    <audio
                      controls
                      preload="none"
                      className="mt-1.5 h-8 w-full max-w-sm"
                      src={`/api/riverside/audio?t=${row.id}&s=${encodeURIComponent(s.label)}`}
                    />
                  )}
                </li>
              ))}
            </ul>
          </details>

          <Button onClick={confirm} disabled={pending} size="sm">
            {pending
              ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Extracting</>
              : mapped.length === 0
                ? "Confirm — no partners in this one"
                : `Add to ${mapped.length} partner ${mapped.length === 1 ? "library" : "libraries"}`}
          </Button>
        </div>
      )}
    </Card>
  )
}
