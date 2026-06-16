"use client"

import { useState, useOptimistic, useTransition } from "react"
import { TrackerProject, TrackerKPI, TrackerGoal, TrackerUpdate } from "@prisma/client"
import { toggleGoal, updateGoalMeta, reorderGoals } from "@/lib/actions/tracker"
import { cn } from "@/lib/utils"
import { Check, GripVertical, ChevronLeft, ChevronRight } from "lucide-react"

type Project = TrackerProject & {
  kpis: TrackerKPI[]
  weeklyGoals: TrackerGoal[]
  updates: TrackerUpdate[]
}

const VERTICALS = [
  { key: "slow", label: "Slow", dot: "bg-violet-400", badge: "bg-violet-500/15 text-violet-400 border-violet-500/25", bar: "bg-violet-500" },
  { key: "slow-creator", label: "Slow Creator", dot: "bg-amber-400", badge: "bg-amber-500/15 text-amber-400 border-amber-500/25", bar: "bg-amber-500" },
  { key: "sam", label: "Sam", dot: "bg-emerald-400", badge: "bg-emerald-500/15 text-emerald-400 border-emerald-500/25", bar: "bg-emerald-500" },
]

const PRIORITY_STYLES = {
  p1: { label: "P1", bg: "bg-red-500/10 text-red-400 border-red-500/20", dot: "bg-red-400", ring: "ring-red-500/20" },
  p2: { label: "P2", bg: "bg-amber-500/10 text-amber-400 border-amber-500/20", dot: "bg-amber-400", ring: "ring-amber-500/20" },
  p3: { label: "P3", bg: "bg-muted/60 text-muted-foreground border-border/40", dot: "bg-muted-foreground", ring: "" },
}

const WORKTYPE_STYLES = {
  sprint: { label: "Sprint", bg: "bg-blue-500/10 text-blue-400 border-blue-500/20" },
  maintenance: { label: "Maint.", bg: "bg-muted/40 text-muted-foreground border-border/30" },
}

function getMondayOf(date: Date): Date {
  const d = new Date(date)
  const day = d.getDay()
  const diff = d.getDate() - day + (day === 0 ? -6 : 1)
  d.setDate(diff)
  d.setHours(0, 0, 0, 0)
  return d
}

function addWeeks(date: Date, weeks: number): Date {
  const d = new Date(date)
  d.setDate(d.getDate() + weeks * 7)
  return d
}

function isSameWeek(a: Date, b: Date): boolean {
  return getMondayOf(a).getTime() === getMondayOf(b).getTime()
}

function formatWeek(date: Date): string {
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" })
}

type TaskRow = TrackerGoal & { projectName: string; vertical: typeof VERTICALS[0] }

export default function FocusView({ projects, weekOffset, setWeekOffset }: {
  projects: Project[]
  weekOffset: number
  setWeekOffset: (fn: (w: number) => number) => void
}) {
  const [filter, setFilter] = useState<"all" | "sprint" | "maintenance">("all")
  const [verticalFilter, setVerticalFilter] = useState<string>("all")
  const [dragging, setDragging] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState<string | null>(null)
  const [, startTransition] = useTransition()

  const currentWeekMonday = getMondayOf(addWeeks(new Date(), weekOffset))
  const weekLabel = weekOffset === 0 ? "This Week"
    : weekOffset === 1 ? "Next Week"
    : weekOffset === -1 ? "Last Week"
    : `Week of ${formatWeek(currentWeekMonday)}`

  // Flatten all goals for the current week, respecting kanban order (passive projects last)
  const sortedProjects = [...projects].sort((a, b) => {
    const vOrder = { slow: 0, "slow-creator": 1, sam: 2 } as Record<string, number>
    const vDiff = (vOrder[a.vertical] ?? 9) - (vOrder[b.vertical] ?? 9)
    if (vDiff !== 0) return vDiff
    if (a.status === "passive" && b.status !== "passive") return 1
    if (a.status !== "passive" && b.status === "passive") return -1
    return a.order - b.order
  })

  const allTasks: TaskRow[] = sortedProjects.flatMap(project => {
    const vertical = VERTICALS.find(v => v.key === project.vertical)!
    return project.weeklyGoals
      .filter(g => {
        const weekDate = new Date(g.weekOf)
        const isThisWeek = isSameWeek(weekDate, currentWeekMonday)
        const isOverdue = !g.completed && weekDate < currentWeekMonday
        return isThisWeek || isOverdue
      })
      .map(g => ({ ...g, projectName: project.name, vertical }))
  })

  // Apply filters
  const filtered = allTasks
    .filter(t => filter === "all" || t.workType === filter)
    .filter(t => verticalFilter === "all" || t.vertical.key === verticalFilter)
    .sort((a, b) => {
      const pOrder = { p1: 0, p2: 1, p3: 2 }
      const pDiff = (pOrder[a.priority as keyof typeof pOrder] ?? 1) - (pOrder[b.priority as keyof typeof pOrder] ?? 1)
      if (pDiff !== 0) return pDiff
      return a.rankOrder - b.rankOrder
    })

  const doneCount = filtered.filter(t => t.completed).length
  const totalCount = filtered.length
  const pct = totalCount ? Math.round((doneCount / totalCount) * 100) : 0

  function handlePriorityChange(id: string, priority: string) {
    updateGoalMeta(id, { priority })
  }

  function handleWorkTypeChange(id: string, workType: string) {
    updateGoalMeta(id, { workType })
  }

  // Drag to reorder
  function handleDragStart(id: string) { setDragging(id) }
  function handleDragOver(e: React.DragEvent, id: string) { e.preventDefault(); setDragOver(id) }
  function handleDragEnd() {
    if (!dragging || !dragOver || dragging === dragOver) { setDragging(null); setDragOver(null); return }
    const dragTask = filtered.find(x => x.id === dragging)
    const group = filtered.filter(t => t.priority === dragTask?.priority)
    const fromIdx = group.findIndex(t => t.id === dragging)
    const toIdx = group.findIndex(t => t.id === dragOver)
    if (fromIdx === -1 || toIdx === -1) { setDragging(null); setDragOver(null); return }
    const reordered = [...group]
    const [moved] = reordered.splice(fromIdx, 1)
    reordered.splice(toIdx, 0, moved)
    const updates = reordered.map((t, i) => ({ id: t.id, rankOrder: i }))
    startTransition(() => { reorderGoals(updates) })
    setDragging(null)
    setDragOver(null)
  }

  function TaskCard({ task }: { task: TaskRow }) {
    const p = PRIORITY_STYLES[task.priority as keyof typeof PRIORITY_STYLES] ?? PRIORITY_STYLES.p2
    const w = WORKTYPE_STYLES[task.workType as keyof typeof WORKTYPE_STYLES] ?? WORKTYPE_STYLES.sprint
    const isDraggingThis = dragging === task.id
    const isDragTarget = dragOver === task.id && dragging !== task.id

    return (
      <div
        onDragOver={e => handleDragOver(e, task.id)}
        onDragEnd={handleDragEnd}
        className={cn(
          "flex items-center gap-3 p-3 rounded-xl border bg-card transition-all group",
          isDraggingThis && "opacity-40 scale-95",
          isDragTarget && "border-primary/50 bg-primary/5",
          !isDraggingThis && !isDragTarget && "border-border/60 hover:border-border"
        )}
      >
        {/* Drag handle — only this is draggable */}
        <div
          draggable
          onDragStart={() => handleDragStart(task.id)}
          className="text-muted-foreground/20 group-hover:text-muted-foreground/50 cursor-grab active:cursor-grabbing transition-colors flex-shrink-0"
        >
          <GripVertical size={14} />
        </div>

        {/* Checkbox */}
        <button
          onClick={() => toggleGoal(task.id, !task.completed)}
          className={cn(
            "w-4 h-4 rounded-md border flex-shrink-0 flex items-center justify-center transition-all",
            task.completed ? "bg-green-500 border-green-500 text-white" : "border-border/60 hover:border-primary/50 bg-muted/20"
          )}
        >
          {task.completed && <Check size={9} strokeWidth={3} />}
        </button>

        {/* Task text */}
        <span className={cn("text-sm flex-1 leading-snug", task.completed && "line-through text-muted-foreground/40")}>
          {task.text}
        </span>

        {/* Meta */}
        <div className="flex items-center gap-1.5 flex-shrink-0">
          {/* Vertical badge */}
          <span className={cn("text-[10px] px-2 py-0.5 rounded-full border font-medium", task.vertical.badge)}>
            {task.vertical.label}
          </span>

          {/* Project */}
          <span className="text-[10px] text-muted-foreground/50 hidden sm:block max-w-24 truncate">
            {task.projectName}
          </span>

          {/* Work type toggle */}
          <button
            onClick={() => handleWorkTypeChange(task.id, task.workType === "sprint" ? "maintenance" : "sprint")}
            className={cn("text-[10px] px-2 py-0.5 rounded-full border font-medium transition-colors hover:opacity-80", w.bg)}
            title="Toggle sprint / maintenance"
          >
            {w.label}
          </button>

          {/* Priority selector */}
          <div className="flex items-center gap-0.5 bg-muted/30 rounded-lg p-0.5">
            {(["p1", "p2", "p3"] as const).map(pri => (
              <button
                key={pri}
                onClick={() => handlePriorityChange(task.id, pri)}
                className={cn(
                  "text-[10px] px-1.5 py-0.5 rounded-md font-semibold uppercase transition-all",
                  task.priority === pri
                    ? PRIORITY_STYLES[pri].bg
                    : "text-muted-foreground/30 hover:text-muted-foreground/70"
                )}
              >
                {PRIORITY_STYLES[pri].label}
              </button>
            ))}
          </div>
        </div>
      </div>
    )
  }

  const p1 = filtered.filter(t => t.priority === "p1")
  const p2 = filtered.filter(t => t.priority === "p2")
  const p3 = filtered.filter(t => t.priority === "p3")

  return (
    <div className="space-y-6">
      {/* Controls bar */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 flex-wrap">
          {/* Work type filter */}
          <div className="flex items-center bg-muted/30 border border-border/50 rounded-xl p-1 gap-0.5">
            {[{ key: "all", label: "All" }, { key: "sprint", label: "Sprints" }, { key: "maintenance", label: "Maintenance" }].map(f => (
              <button
                key={f.key}
                onClick={() => setFilter(f.key as typeof filter)}
                className={cn("px-3 py-1.5 rounded-lg text-xs font-medium transition-all",
                  filter === f.key ? "bg-background shadow-sm text-foreground border border-border/50" : "text-muted-foreground hover:text-foreground"
                )}
              >
                {f.label}
              </button>
            ))}
          </div>

          {/* Vertical filter */}
          <div className="flex items-center bg-muted/30 border border-border/50 rounded-xl p-1 gap-0.5">
            <button
              onClick={() => setVerticalFilter("all")}
              className={cn("px-3 py-1.5 rounded-lg text-xs font-medium transition-all",
                verticalFilter === "all" ? "bg-background shadow-sm text-foreground border border-border/50" : "text-muted-foreground hover:text-foreground"
              )}
            >
              All
            </button>
            {VERTICALS.map(v => (
              <button
                key={v.key}
                onClick={() => setVerticalFilter(v.key)}
                className={cn("flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all",
                  verticalFilter === v.key ? "bg-background shadow-sm text-foreground border border-border/50" : "text-muted-foreground hover:text-foreground"
                )}
              >
                <span className={cn("w-1.5 h-1.5 rounded-full", v.dot)} />
                {v.label}
              </button>
            ))}
          </div>
        </div>

        {/* Week nav */}
        <div className="flex items-center gap-1 bg-muted/30 border border-border/50 rounded-xl px-1 py-1">
          <button onClick={() => setWeekOffset(w => w - 1)} className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-muted text-muted-foreground transition-colors">
            <ChevronLeft size={15} />
          </button>
          <span className="text-sm font-medium px-3 min-w-32 text-center">{weekLabel}</span>
          <button onClick={() => setWeekOffset(w => w + 1)} className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-muted text-muted-foreground transition-colors">
            <ChevronRight size={15} />
          </button>
          {weekOffset !== 0 && (
            <button onClick={() => setWeekOffset(() => 0)} className="text-xs text-muted-foreground hover:text-foreground px-2 py-1 rounded-lg hover:bg-muted transition-colors ml-1">
              Today
            </button>
          )}
        </div>
      </div>

      {/* Summary bar */}
      {totalCount > 0 && (
        <div className="flex items-center gap-4 px-4 py-3 rounded-xl bg-muted/20 border border-border/40">
          <div className="flex-1">
            <div className="flex items-center justify-between text-xs mb-1.5">
              <span className="text-muted-foreground">{doneCount} of {totalCount} tasks complete</span>
              <span className="font-semibold tabular-nums">{pct}%</span>
            </div>
            <div className="h-1.5 bg-muted/60 rounded-full overflow-hidden">
              <div
                className={cn("h-full rounded-full transition-all duration-500", pct === 100 ? "bg-green-500" : "bg-primary")}
                style={{ width: `${pct}%` }}
              />
            </div>
          </div>
          <div className="flex items-center gap-3 text-xs text-muted-foreground flex-shrink-0">
            <span className="text-red-400 font-medium">{filtered.filter(t => t.priority === "p1").length} P1</span>
            <span className="text-amber-400 font-medium">{filtered.filter(t => t.priority === "p2").length} P2</span>
            <span className="text-muted-foreground/60">{filtered.filter(t => t.priority === "p3").length} P3</span>
          </div>
        </div>
      )}

      {totalCount === 0 && (
        <div className="rounded-xl border border-dashed border-border/40 p-12 text-center">
          <p className="text-sm text-muted-foreground/40">No tasks for {weekLabel.toLowerCase()}.</p>
          <p className="text-xs text-muted-foreground/30 mt-1">Add goals to your projects in the Weekly view.</p>
        </div>
      )}

      {/* Task list — flat, grouped by priority */}
      {totalCount > 0 && (
        <div className="space-y-6">
          {[
            { label: "P1 — Must do", tasks: p1 },
            { label: "P2 — Should do", tasks: p2 },
            { label: "P3 — Nice to do", tasks: p3 },
          ].map(group => {
            if (!group.tasks.length) return null
            return (
              <div key={group.label} className="space-y-2">
                <p className="text-[10px] font-semibold text-muted-foreground/60 uppercase tracking-widest px-1">
                  {group.label} · {group.tasks.length}
                </p>
                {group.tasks.map(task => <TaskCard key={task.id} task={task} />)}
              </div>
            )
          })}
        </div>
      )}

      <p className="text-[10px] text-muted-foreground/30 text-center pt-2">
        Drag to reorder within priority group · Click P1/P2/P3 to change priority · Click work type to toggle sprint/maintenance
      </p>
    </div>
  )
}
