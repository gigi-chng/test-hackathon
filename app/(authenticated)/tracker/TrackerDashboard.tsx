"use client"

import { useState } from "react"
import { TrackerProject, TrackerKPI, TrackerGoal, TrackerUpdate } from "@prisma/client"
import { toggleGoal, addUpdate, upsertGoal, upsertKPI, deleteKPI, deleteGoal, createProject, updateProjectStatus, toggleGoalStage, reorderProjects, updateGoalMeta } from "@/lib/actions/tracker"
import { cn } from "@/lib/utils"
import { Plus, Check, ChevronLeft, ChevronRight, Trash2, MessageSquare, LayoutGrid, Calendar, TrendingUp, Pencil, Crosshair, Lock, Unlock, GripVertical } from "lucide-react"
import FocusView from "./FocusView"

type Project = TrackerProject & {
  kpis: TrackerKPI[]
  weeklyGoals: TrackerGoal[]
  updates: TrackerUpdate[]
}

const VERTICALS = [
  {
    key: "slow",
    label: "Slow",
    accent: "from-violet-500/20 to-violet-500/5",
    border: "border-violet-500/30",
    badge: "bg-violet-500/15 text-violet-400 border-violet-500/25",
    bar: "bg-violet-500",
    dot: "bg-violet-400",
    text: "text-violet-400",
  },
  {
    key: "slow-creator",
    label: "Slow Creator",
    accent: "from-amber-500/20 to-amber-500/5",
    border: "border-amber-500/30",
    badge: "bg-amber-500/15 text-amber-400 border-amber-500/25",
    bar: "bg-amber-500",
    dot: "bg-amber-400",
    text: "text-amber-400",
  },
  {
    key: "sam",
    label: "Sam",
    accent: "from-emerald-500/20 to-emerald-500/5",
    border: "border-emerald-500/30",
    badge: "bg-emerald-500/15 text-emerald-400 border-emerald-500/25",
    bar: "bg-emerald-500",
    dot: "bg-emerald-400",
    text: "text-emerald-400",
  },
]

const STATUS_STYLES: Record<string, string> = {
  active: "bg-green-500/10 text-green-400 border-green-500/20",
  passive: "bg-slate-500/10 text-slate-400 border-slate-500/20",
  paused: "bg-yellow-500/10 text-yellow-400 border-yellow-500/20",
  completed: "bg-sky-500/10 text-sky-400 border-sky-500/20",
}

const STATUS_CYCLE: Record<string, string> = {
  active: "passive",
  passive: "paused",
  paused: "active",
  completed: "active",
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

function formatWeek(date: Date): string {
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" })
}

function isSameWeek(a: Date, b: Date): boolean {
  return getMondayOf(a).getTime() === getMondayOf(b).getTime()
}

function getWeeksInMonth(year: number, month: number): Date[] {
  const weeks: Date[] = []
  const firstDay = new Date(year, month, 1)
  const lastDay = new Date(year, month + 1, 0)
  let current = getMondayOf(firstDay)
  if (current > firstDay) current = new Date(current.getTime() - 7 * 86400000)
  while (current <= lastDay) {
    weeks.push(new Date(current))
    current = new Date(current.getTime() + 7 * 86400000)
  }
  return weeks
}

function PctRing({ pct, size = 36, color = "stroke-primary" }: { pct: number; size?: number; color?: string }) {
  const r = (size - 6) / 2
  const circ = 2 * Math.PI * r
  const offset = circ - (pct / 100) * circ
  return (
    <svg width={size} height={size} className="-rotate-90">
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={3} className="stroke-muted" />
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={3} strokeDasharray={circ} strokeDashoffset={offset} strokeLinecap="round" className={cn("transition-all", color)} />
    </svg>
  )
}

// ─── Monthly View ─────────────────────────────────────────────────────────────

function MonthlyView({ projects, monthOffset }: { projects: Project[]; monthOffset: number }) {
  const now = new Date()
  const targetDate = new Date(now.getFullYear(), now.getMonth() + monthOffset, 1)
  const year = targetDate.getFullYear()
  const month = targetDate.getMonth()
  const weeks = getWeeksInMonth(year, month)

  const goalsInMonth = (project: Project) =>
    project.weeklyGoals.filter(g => {
      const d = new Date(g.weekOf)
      return d.getFullYear() === year && d.getMonth() === month
    })

  const updatesInMonth = (project: Project) =>
    project.updates.filter(u => {
      const d = new Date(u.createdAt)
      return d.getFullYear() === year && d.getMonth() === month
    })

  return (
    <div className="space-y-10">
      {VERTICALS.map(vertical => {
        const vProjects = projects.filter(p => p.vertical === vertical.key)
        const allGoals = vProjects.flatMap(p => goalsInMonth(p))
        const completedGoals = allGoals.filter(g => g.completed).length
        const verticalPct = allGoals.length ? Math.round((completedGoals / allGoals.length) * 100) : null

        return (
          <div key={vertical.key}>
            {/* Vertical Header */}
            <div className={cn("flex items-center justify-between px-4 py-3 rounded-xl border mb-4 bg-gradient-to-r", vertical.accent, vertical.border)}>
              <div className="flex items-center gap-3">
                <span className={cn("w-2 h-2 rounded-full", vertical.dot)} />
                <h2 className="font-semibold">{vertical.label}</h2>
              </div>
              {verticalPct !== null && (
                <div className="flex items-center gap-2">
                  <PctRing pct={verticalPct} size={28} color={verticalPct === 100 ? "stroke-green-500" : verticalPct >= 60 ? vertical.bar.replace("bg-", "stroke-") : "stroke-orange-400"} />
                  <span className="text-sm font-medium tabular-nums">{completedGoals}/{allGoals.length} tasks · {verticalPct}%</span>
                </div>
              )}
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
              {vProjects.map(project => {
                const goals = goalsInMonth(project)
                const updates = updatesInMonth(project)
                const done = goals.filter(g => g.completed).length
                const pct = goals.length ? Math.round((done / goals.length) * 100) : null

                const byWeek = weeks.map(w => ({
                  weekLabel: formatWeek(w),
                  goals: goals.filter(g => isSameWeek(new Date(g.weekOf), w)),
                })).filter(w => w.goals.length > 0)

                return (
                  <div key={project.id} className="rounded-xl border border-border bg-card overflow-hidden">
                    {/* Card top accent bar */}
                    <div className={cn("h-0.5 bg-gradient-to-r", vertical.accent.replace("/20", "/60").replace("/5", "/20"))} />

                    <div className="p-5 space-y-5">
                      {/* Header */}
                      <div className="flex items-start justify-between">
                        <div>
                          <h3 className="font-semibold text-sm">{project.name}</h3>
                          <span className={cn("text-xs px-2 py-0.5 rounded-full border mt-1.5 inline-block capitalize", STATUS_STYLES[project.status])}>
                            {project.status}
                          </span>
                        </div>
                        {pct !== null && (
                          <div className="flex flex-col items-center">
                            <PctRing pct={pct} size={40} color={pct === 100 ? "stroke-green-500" : pct >= 60 ? vertical.bar.replace("bg-", "stroke-") : "stroke-orange-400"} />
                            <span className="text-[10px] text-muted-foreground mt-0.5 tabular-nums">{pct}%</span>
                          </div>
                        )}
                      </div>

                      {/* KPIs */}
                      {project.kpis.length > 0 && (
                        <div className="space-y-2.5">
                          <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-widest">Goals</p>
                          {project.kpis.map(kpi => {
                            const kpiPct = kpi.target && kpi.current !== null
                              ? Math.min(100, Math.round(((kpi.current ?? 0) / kpi.target) * 100))
                              : null
                            return (
                              <div key={kpi.id}>
                                <div className="flex justify-between text-xs mb-1">
                                  <span className="text-muted-foreground">{kpi.name}</span>
                                  <span className="font-semibold tabular-nums">
                                    {kpi.current ?? "—"}{kpi.unit ? ` ${kpi.unit}` : ""}
                                    {kpi.target ? <span className="text-muted-foreground font-normal"> / {kpi.target}</span> : null}
                                  </span>
                                </div>
                                {kpiPct !== null && (
                                  <div className="h-1 bg-muted/60 rounded-full overflow-hidden">
                                    <div
                                      className={cn("h-full rounded-full transition-all", kpiPct >= 100 ? "bg-green-500" : kpiPct >= 60 ? vertical.bar : "bg-orange-400")}
                                      style={{ width: `${kpiPct}%` }}
                                    />
                                  </div>
                                )}
                              </div>
                            )
                          })}
                        </div>
                      )}

                      {/* Weekly breakdown */}
                      {byWeek.length > 0 && (
                        <div className="space-y-2">
                          <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-widest">Weekly Tasks</p>
                          {byWeek.map(({ weekLabel, goals: wGoals }) => {
                            const wDone = wGoals.filter(g => g.completed).length
                            const wPct = Math.round((wDone / wGoals.length) * 100)
                            return (
                              <div key={weekLabel} className="flex items-center gap-2.5 text-xs">
                                <span className="text-muted-foreground w-12 flex-shrink-0 tabular-nums">{weekLabel}</span>
                                <div className="flex-1 h-1 bg-muted/60 rounded-full overflow-hidden">
                                  <div
                                    className={cn("h-full rounded-full transition-all", wPct === 100 ? "bg-green-500" : wPct >= 60 ? vertical.bar : "bg-orange-400")}
                                    style={{ width: `${wPct}%` }}
                                  />
                                </div>
                                <span className="w-8 text-right font-medium tabular-nums text-muted-foreground">{wDone}/{wGoals.length}</span>
                              </div>
                            )
                          })}
                        </div>
                      )}

                      {goals.length === 0 && (
                        <p className="text-xs text-muted-foreground/60 italic">No tasks recorded this month.</p>
                      )}

                      {/* Updates */}
                      {updates.length > 0 && (
                        <div className="space-y-1.5 pt-1 border-t border-border/60">
                          <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-widest pt-1">Updates</p>
                          {updates.slice(0, 3).map(u => (
                            <div key={u.id} className="text-xs leading-relaxed">
                              <span className="text-muted-foreground/70">
                                {new Date(u.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })} —{" "}
                              </span>
                              <span className="text-foreground/80">{u.text}</span>
                            </div>
                          ))}
                          {updates.length > 3 && (
                            <p className="text-xs text-muted-foreground/50">+{updates.length - 3} more</p>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ─── Project Card (Weekly) ────────────────────────────────────────────────────

function ProjectCard({
  project,
  vertical,
  weekLabel,
  currentWeekMonday,
  rankBase,
  isDragging,
  isDragTarget,
  onDragStart,
  onDragOver,
  onDragEnd,
}: {
  project: Project
  vertical: typeof VERTICALS[0]
  weekLabel: string
  currentWeekMonday: Date
  rankBase: number
  isDragging?: boolean
  isDragTarget?: boolean
  onDragStart?: () => void
  onDragOver?: () => void
  onDragEnd?: () => void
}) {
  const [expanded, setExpanded] = useState(false)
  const [updateInput, setUpdateInput] = useState("")
  const [taskInput, setTaskInput] = useState("")
  const [taskPriority, setTaskPriority] = useState("p2")
  const [taskWorkType, setTaskWorkType] = useState("sprint")
  const [showTaskForm, setShowTaskForm] = useState(false)
  const [showGoalForm, setShowGoalForm] = useState(false)
  const [goalInput, setGoalInput] = useState({ name: "", unit: "", target: "", current: "", stage: "live" })
  const [editingGoal, setEditingGoal] = useState<string | null>(null)
  const [goalEdit, setGoalEdit] = useState("")

  const tasks = project.weeklyGoals.filter(g => isSameWeek(new Date(g.weekOf), currentWeekMonday))
  const done = tasks.filter(g => g.completed).length
  const pct = tasks.length ? Math.round((done / tasks.length) * 100) : null

  async function handleAddUpdate() {
    const text = updateInput.trim()
    if (!text) return
    await addUpdate(project.id, text)
    setUpdateInput("")
  }

  async function handleAddTask() {
    const text = taskInput.trim()
    if (!text) return
    await upsertGoal({ projectId: project.id, weekOf: currentWeekMonday, text, priority: taskPriority, workType: taskWorkType, rankOrder: rankBase + tasks.length })
    setTaskInput("")
    setShowTaskForm(false)
  }

  async function handleAddGoal() {
    if (!goalInput.name.trim()) return
    await upsertKPI({
      projectId: project.id,
      name: goalInput.name,
      unit: goalInput.unit || undefined,
      target: goalInput.target ? parseFloat(goalInput.target) : undefined,
      current: goalInput.stage === "live" && goalInput.current ? parseFloat(goalInput.current) : undefined,
      stage: goalInput.stage,
    })
    setGoalInput({ name: "", unit: "", target: "", current: "", stage: "live" })
    setShowGoalForm(false)
  }

  async function handleSaveGoal(kpiId: string) {
    await upsertKPI({ id: kpiId, projectId: project.id, name: "", current: parseFloat(goalEdit) })
    setEditingGoal(null)
  }

  return (
    <div
      className={cn("rounded-xl border bg-card overflow-hidden transition-all", isDragging && "opacity-40 scale-[0.98]", isDragTarget && "ring-2 ring-primary/40 border-primary/30", !isDragging && !isDragTarget && (expanded ? "border-border" : "border-border/60 hover:border-border"))}
      onDragOver={e => { e.preventDefault(); onDragOver?.() }}
    >
      {/* Accent top bar */}
      <div className={cn("h-0.5 bg-gradient-to-r", vertical.accent.replace("/20", "/80").replace("/5", "/20"))} />

      {/* Card header — always visible */}
      <div className="p-4 cursor-pointer select-none" onClick={() => setExpanded(e => !e)}>
        <div className="flex items-start gap-3">
          {/* Drag handle — only this element is draggable */}
          <div
            draggable
            onDragStart={e => { e.stopPropagation(); onDragStart?.() }}
            onDragEnd={e => { e.stopPropagation(); onDragEnd?.() }}
            onClick={e => e.stopPropagation()}
            className="mt-0.5 text-muted-foreground/20 hover:text-muted-foreground/50 cursor-grab active:cursor-grabbing transition-colors flex-shrink-0"
          >
            <GripVertical size={14} />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <h3 className="font-semibold text-sm leading-tight">{project.name}</h3>
              <button
                onClick={e => { e.stopPropagation(); updateProjectStatus(project.id, STATUS_CYCLE[project.status] ?? "active") }}
                className={cn("text-[10px] px-1.5 py-0.5 rounded-full border capitalize font-medium transition-opacity hover:opacity-70", STATUS_STYLES[project.status])}
                title="Click to cycle status"
              >
                {project.status}
              </button>
            </div>

            {/* Progress */}
            {pct !== null ? (
              <div className="mt-2.5 space-y-1">
                <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                  <span>{done} of {tasks.length} tasks</span>
                  <span className="font-medium tabular-nums">{pct}%</span>
                </div>
                <div className="h-1 bg-muted/50 rounded-full overflow-hidden">
                  <div
                    className={cn("h-full rounded-full transition-all duration-500", pct === 100 ? "bg-green-500" : vertical.bar)}
                    style={{ width: `${pct}%` }}
                  />
                </div>
              </div>
            ) : (
              <p className="text-[11px] text-muted-foreground/50 mt-1">No tasks this week</p>
            )}
          </div>

          {/* Ring indicator */}
          {pct !== null && (
            <PctRing
              pct={pct}
              size={36}
              color={pct === 100 ? "stroke-green-500" : pct >= 60 ? vertical.bar.replace("bg-", "stroke-") : "stroke-orange-400"}
            />
          )}
        </div>

        {/* Goal pills */}
        {project.kpis.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mt-3">
            {project.kpis.map(kpi => (
              <div key={kpi.id} className={cn("flex items-center gap-1 text-[11px] rounded-full px-2.5 py-1 border", kpi.stage === "pre-live" ? "bg-muted/20 border-border/30 opacity-60" : "bg-muted/40 border-border/50")}>
                {kpi.stage === "pre-live" ? <Lock size={9} className="text-muted-foreground" /> : <TrendingUp size={9} className="text-muted-foreground" />}
                <span className="text-muted-foreground">{kpi.name}</span>
                {kpi.stage === "pre-live"
                  ? <span className="text-muted-foreground/50 italic">pre-live</span>
                  : <><span className="font-semibold ml-0.5 tabular-nums">{kpi.current ?? "—"}{kpi.unit ? ` ${kpi.unit}` : ""}</span>
                    {kpi.target && <span className="text-muted-foreground/60">/{kpi.target}</span>}</>
                }
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Expanded content */}
      {expanded && (
        <div className="border-t border-border/60">

          {/* Tasks section */}
          <div className="p-4 space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-widest">Tasks · {weekLabel}</span>
              <button onClick={() => setShowTaskForm(s => !s)} className={cn("w-5 h-5 rounded-md flex items-center justify-center transition-colors", showTaskForm ? "bg-primary text-primary-foreground" : "hover:bg-muted text-muted-foreground")}>
                <Plus size={12} />
              </button>
            </div>

            {showTaskForm && (
              <div className="space-y-2">
                <input
                  autoFocus
                  value={taskInput}
                  onChange={e => setTaskInput(e.target.value)}
                  onKeyDown={e => { if (e.key === "Enter") handleAddTask(); if (e.key === "Escape") setShowTaskForm(false) }}
                  placeholder="Add a task or deliverable..."
                  className="w-full text-xs bg-muted/40 border border-border/60 rounded-lg px-3 py-1.5 focus:outline-none focus:ring-1 focus:ring-primary/50"
                />
                <div className="flex items-center gap-2">
                  {/* Priority */}
                  <div className="flex items-center gap-1 bg-muted/30 rounded-lg p-0.5">
                    {["p1","p2","p3"].map(p => (
                      <button key={p} onClick={() => setTaskPriority(p)}
                        className={cn("px-2 py-1 rounded-md text-[10px] font-semibold transition-all uppercase",
                          taskPriority === p ? (p === "p1" ? "bg-red-500/20 text-red-400" : p === "p2" ? "bg-amber-500/20 text-amber-400" : "bg-muted text-muted-foreground") : "text-muted-foreground/40 hover:text-muted-foreground"
                        )}>{p}</button>
                    ))}
                  </div>
                  {/* Work type */}
                  <div className="flex items-center gap-1 bg-muted/30 rounded-lg p-0.5">
                    {["sprint","maintenance"].map(w => (
                      <button key={w} onClick={() => setTaskWorkType(w)}
                        className={cn("px-2 py-1 rounded-md text-[10px] font-medium transition-all capitalize",
                          taskWorkType === w ? "bg-background shadow-sm text-foreground border border-border/40" : "text-muted-foreground/40 hover:text-muted-foreground"
                        )}>{w === "maintenance" ? "Maint." : w}</button>
                    ))}
                  </div>
                  <button onClick={handleAddTask} className="ml-auto text-xs bg-primary text-primary-foreground px-3 py-1.5 rounded-lg font-medium">Add</button>
                </div>
              </div>
            )}

            {tasks.length === 0 ? (
              <p className="text-xs text-muted-foreground/40 italic py-1">No tasks set — click + to add one.</p>
            ) : (
              <div className="space-y-1.5">
                {tasks.map(task => {
                  const pStyle = task.priority === "p1" ? "text-red-400 border-red-500/20 bg-red-500/10"
                    : task.priority === "p3" ? "text-muted-foreground/50 border-border/30 bg-muted/20"
                    : "text-amber-400 border-amber-500/20 bg-amber-500/10"
                  return (
                    <div key={task.id} className="flex items-center gap-2 group py-0.5">
                      <button
                        onClick={() => toggleGoal(task.id, !task.completed)}
                        className={cn("w-4 h-4 rounded-md border flex-shrink-0 flex items-center justify-center transition-all",
                          task.completed ? "bg-green-500 border-green-500 text-white" : "border-border/60 hover:border-primary/50 bg-muted/20"
                        )}
                      >
                        {task.completed && <Check size={9} strokeWidth={3} />}
                      </button>
                      <span className={cn("text-xs flex-1 leading-relaxed", task.completed && "line-through text-muted-foreground/40")}>
                        {task.text}
                      </span>
                      <div className="flex items-center gap-0.5 bg-muted/30 rounded-lg p-0.5 flex-shrink-0">
                        {(["p1","p2","p3"] as const).map(pri => {
                          const active = task.priority === pri
                          const s = pri === "p1" ? "text-red-400 bg-red-500/20" : pri === "p2" ? "text-amber-400 bg-amber-500/20" : "text-muted-foreground bg-muted"
                          return (
                            <button key={pri}
                              onClick={e => { e.stopPropagation(); updateGoalMeta(task.id, { priority: pri }) }}
                              className={cn("text-[9px] px-1.5 py-0.5 rounded-md font-semibold uppercase transition-all",
                                active ? s : "text-muted-foreground/30 hover:text-muted-foreground/60"
                              )}
                            >{pri}</button>
                          )
                        })}
                      </div>
                      <button onClick={() => deleteGoal(task.id)} className="opacity-0 group-hover:opacity-100 text-muted-foreground/40 hover:text-destructive transition-all">
                        <Trash2 size={11} />
                      </button>
                    </div>
                  )
                })}
              </div>
            )}
          </div>

          {/* Goals section (metrics) */}
          <div className="px-4 pb-4 space-y-3 border-t border-border/40 pt-4">
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-widest">Goals</span>
              <button onClick={() => setShowGoalForm(s => !s)} className={cn("w-5 h-5 rounded-md flex items-center justify-center transition-colors", showGoalForm ? "bg-primary text-primary-foreground" : "hover:bg-muted text-muted-foreground")}>
                <Plus size={12} />
              </button>
            </div>

            {showGoalForm && (
              <div className="space-y-2">
                <div className="grid grid-cols-2 gap-2">
                  {[
                    { key: "name", placeholder: "Goal name (e.g. LinkedIn impressions)" },
                    { key: "unit", placeholder: "Unit (posts, %, impressions...)" },
                    { key: "target", placeholder: "Target value", type: "number" },
                  ].map(f => (
                    <input
                      key={f.key}
                      type={f.type || "text"}
                      placeholder={f.placeholder}
                      value={goalInput[f.key as keyof typeof goalInput]}
                      onChange={e => setGoalInput(p => ({ ...p, [f.key]: e.target.value }))}
                      className={cn("text-xs bg-muted/40 border border-border/60 rounded-lg px-3 py-1.5 focus:outline-none focus:ring-1 focus:ring-primary/50", f.key === "name" && "col-span-2")}
                    />
                  ))}
                  {/* Stage toggle */}
                  <div className="col-span-2 flex items-center gap-2">
                    <span className="text-[10px] text-muted-foreground">Stage:</span>
                    <div className="flex items-center gap-1 bg-muted/30 rounded-lg p-0.5">
                      <button onClick={() => setGoalInput(p => ({ ...p, stage: "live" }))}
                        className={cn("flex items-center gap-1 px-2 py-1 rounded-md text-[10px] font-medium transition-all",
                          goalInput.stage === "live" ? "bg-background shadow-sm text-foreground border border-border/40" : "text-muted-foreground/50 hover:text-muted-foreground"
                        )}>
                        <Unlock size={9} /> Live
                      </button>
                      <button onClick={() => setGoalInput(p => ({ ...p, stage: "pre-live" }))}
                        className={cn("flex items-center gap-1 px-2 py-1 rounded-md text-[10px] font-medium transition-all",
                          goalInput.stage === "pre-live" ? "bg-background shadow-sm text-foreground border border-border/40" : "text-muted-foreground/50 hover:text-muted-foreground"
                        )}>
                        <Lock size={9} /> Pre-live
                      </button>
                    </div>
                    {goalInput.stage === "pre-live" && (
                      <span className="text-[10px] text-muted-foreground/50 italic">Metric locked until project goes live</span>
                    )}
                  </div>
                  {goalInput.stage === "live" && (
                    <input
                      type="number"
                      placeholder="Current value"
                      value={goalInput.current}
                      onChange={e => setGoalInput(p => ({ ...p, current: e.target.value }))}
                      className="col-span-2 text-xs bg-muted/40 border border-border/60 rounded-lg px-3 py-1.5 focus:outline-none focus:ring-1 focus:ring-primary/50"
                    />
                  )}
                </div>
                <div className="flex gap-2">
                  <button onClick={handleAddGoal} className="text-xs bg-primary text-primary-foreground px-3 py-1.5 rounded-lg font-medium">Save Goal</button>
                  <button onClick={() => setShowGoalForm(false)} className="text-xs text-muted-foreground hover:text-foreground">Cancel</button>
                </div>
              </div>
            )}

            {project.kpis.length === 0 && !showGoalForm && (
              <p className="text-xs text-muted-foreground/40 italic">No goals defined.</p>
            )}

            <div className="space-y-3">
              {project.kpis.map(kpi => {
                const isPreLive = kpi.stage === "pre-live"
                const goalPct = !isPreLive && kpi.target && kpi.current !== null
                  ? Math.min(100, Math.round(((kpi.current ?? 0) / kpi.target) * 100))
                  : null
                return (
                  <div key={kpi.id} className={cn("group space-y-1", isPreLive && "opacity-60")}>
                    <div className="flex items-center justify-between text-xs">
                      <div className="flex items-center gap-1.5">
                        {isPreLive && <Lock size={10} className="text-muted-foreground/50 flex-shrink-0" />}
                        <span className="text-muted-foreground">{kpi.name}</span>
                        {kpi.target && <span className="text-muted-foreground/40 tabular-nums">→ {kpi.target}{kpi.unit ? ` ${kpi.unit}` : ""}</span>}
                      </div>
                      <div className="flex items-center gap-1.5">
                        {isPreLive ? (
                          <>
                            <span className="text-[10px] text-muted-foreground/40 italic">not yet tracking</span>
                            <button
                              onClick={() => toggleGoalStage(kpi.id, "live")}
                              className="opacity-0 group-hover:opacity-100 flex items-center gap-1 text-[10px] text-emerald-400 hover:text-emerald-300 transition-all"
                              title="Mark as live"
                            >
                              <Unlock size={10} /> Go live
                            </button>
                          </>
                        ) : (
                          <>
                            {editingGoal === kpi.id ? (
                              <input
                                autoFocus type="number"
                                value={goalEdit}
                                onChange={e => setGoalEdit(e.target.value)}
                                onBlur={() => handleSaveGoal(kpi.id)}
                                onKeyDown={e => { if (e.key === "Enter") handleSaveGoal(kpi.id); if (e.key === "Escape") setEditingGoal(null) }}
                                className="w-16 text-xs bg-muted/40 border border-primary/50 rounded px-1.5 py-0.5 text-right focus:outline-none"
                              />
                            ) : (
                              <button
                                onClick={() => { setEditingGoal(kpi.id); setGoalEdit(String(kpi.current ?? "")) }}
                                className="font-semibold tabular-nums hover:text-primary transition-colors flex items-center gap-1"
                              >
                                {kpi.current ?? "—"}{kpi.unit ? ` ${kpi.unit}` : ""}
                                <Pencil size={9} className="opacity-0 group-hover:opacity-50" />
                              </button>
                            )}
                            <button
                              onClick={() => toggleGoalStage(kpi.id, "pre-live")}
                              className="opacity-0 group-hover:opacity-100 text-muted-foreground/40 hover:text-amber-400 transition-all"
                              title="Mark as pre-live"
                            >
                              <Lock size={10} />
                            </button>
                          </>
                        )}
                        <button onClick={() => deleteKPI(kpi.id)} className="opacity-0 group-hover:opacity-100 text-muted-foreground/40 hover:text-destructive transition-all">
                          <Trash2 size={11} />
                        </button>
                      </div>
                    </div>
                    {goalPct !== null && (
                      <div className="h-1 bg-muted/50 rounded-full overflow-hidden">
                        <div
                          className={cn("h-full rounded-full transition-all duration-500", goalPct >= 100 ? "bg-green-500" : goalPct >= 60 ? vertical.bar : "bg-orange-400")}
                          style={{ width: `${goalPct}%` }}
                        />
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </div>

          {/* Updates section */}
          <div className="px-4 pb-4 space-y-3 border-t border-border/40 pt-4">
            <div className="flex items-center gap-2">
              <MessageSquare size={11} className="text-muted-foreground" />
              <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-widest">Updates</span>
            </div>
            <div className="flex gap-2">
              <input
                value={updateInput}
                onChange={e => setUpdateInput(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter") handleAddUpdate() }}
                placeholder="Log a quick update..."
                className="flex-1 text-xs bg-muted/40 border border-border/60 rounded-lg px-3 py-1.5 focus:outline-none focus:ring-1 focus:ring-primary/50"
              />
              <button onClick={handleAddUpdate} className="text-xs bg-muted hover:bg-muted/80 px-3 py-1.5 rounded-lg border border-border/60 transition-colors font-medium">Log</button>
            </div>
            {project.updates.length === 0 && (
              <p className="text-xs text-muted-foreground/40 italic">No updates yet.</p>
            )}
            <div className="space-y-2">
              {project.updates.slice(0, 5).map(u => (
                <div key={u.id} className="text-xs leading-relaxed">
                  <span className="text-muted-foreground/50 tabular-nums">
                    {new Date(u.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })} —{" "}
                  </span>
                  <span className="text-foreground/70">{u.text}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Weekly View ──────────────────────────────────────────────────────────────

function sortProjects(projects: Project[]) {
  return [...projects].sort((a, b) => {
    if (a.status === "passive" && b.status !== "passive") return 1
    if (a.status !== "passive" && b.status === "passive") return -1
    return a.order - b.order
  })
}

function WeeklyView({ projects, weekOffset, setWeekOffset }: {
  projects: Project[]
  weekOffset: number
  setWeekOffset: (fn: (w: number) => number) => void
}) {
  const [showNewProject, setShowNewProject] = useState<string | null>(null)
  const [newProjectName, setNewProjectName] = useState("")
  const [draggingProject, setDraggingProject] = useState<string | null>(null)
  const [dragOverProject, setDragOverProject] = useState<string | null>(null)

  function handleProjectDragEnd(verticalKey: string) {
    if (!draggingProject || !dragOverProject || draggingProject === dragOverProject) {
      setDraggingProject(null); setDragOverProject(null); return
    }
    const vp = sortProjects(projects.filter(p => p.vertical === verticalKey))
    const fromIdx = vp.findIndex(p => p.id === draggingProject)
    const toIdx = vp.findIndex(p => p.id === dragOverProject)
    if (fromIdx === -1 || toIdx === -1) { setDraggingProject(null); setDragOverProject(null); return }
    const reordered = [...vp]
    const [moved] = reordered.splice(fromIdx, 1)
    reordered.splice(toIdx, 0, moved)
    reorderProjects(reordered.map((p, i) => ({ id: p.id, order: i })))
    setDraggingProject(null); setDragOverProject(null)
  }

  // Build a global rank base map: vertical order × 10000 + project position × 1000
  const rankBaseMap = new Map<string, number>()
  let globalIdx = 0
  VERTICALS.forEach(v => {
    sortProjects(projects.filter(p => p.vertical === v.key)).forEach(p => {
      rankBaseMap.set(p.id, globalIdx * 1000)
      globalIdx++
    })
  })

  const currentWeekMonday = getMondayOf(addWeeks(new Date(), weekOffset))
  const weekLabel = weekOffset === 0 ? "This Week"
    : weekOffset === 1 ? "Next Week"
    : weekOffset === -1 ? "Last Week"
    : `Week of ${formatWeek(currentWeekMonday)}`

  async function handleNewProject(vertical: string) {
    if (!newProjectName.trim()) return
    await createProject({ vertical, name: newProjectName })
    setNewProjectName("")
    setShowNewProject(null)
  }

  return (
    <>
      {/* Week nav */}
      <div className="flex justify-end mb-6">
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

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {VERTICALS.map(vertical => {
          const vProjects = sortProjects(projects.filter(p => p.vertical === vertical.key))
          return (
            <div key={vertical.key} className="space-y-3">
              {/* Vertical label */}
              <div className="flex items-center justify-between px-1">
                <div className="flex items-center gap-2">
                  <span className={cn("w-1.5 h-1.5 rounded-full", vertical.dot)} />
                  <h2 className="font-semibold text-sm">{vertical.label}</h2>
                  <span className="text-xs text-muted-foreground/50">{vProjects.length}</span>
                </div>
                <button onClick={() => setShowNewProject(vertical.key)} className="w-6 h-6 rounded-lg hover:bg-muted flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors">
                  <Plus size={13} />
                </button>
              </div>

              {showNewProject === vertical.key && (
                <div className="flex gap-2 px-1">
                  <input
                    autoFocus
                    value={newProjectName}
                    onChange={e => setNewProjectName(e.target.value)}
                    onKeyDown={e => { if (e.key === "Enter") handleNewProject(vertical.key); if (e.key === "Escape") setShowNewProject(null) }}
                    placeholder="Project name..."
                    className="flex-1 text-xs bg-muted/40 border border-border/60 rounded-lg px-3 py-1.5 focus:outline-none focus:ring-1 focus:ring-primary/50"
                  />
                  <button onClick={() => handleNewProject(vertical.key)} className="text-xs bg-primary text-primary-foreground px-2.5 py-1.5 rounded-lg font-medium">Add</button>
                  <button onClick={() => setShowNewProject(null)} className="text-xs text-muted-foreground hover:text-foreground">✕</button>
                </div>
              )}

              {vProjects.map(project => (
                <ProjectCard
                  key={project.id}
                  project={project}
                  vertical={vertical}
                  weekLabel={weekLabel}
                  currentWeekMonday={currentWeekMonday}
                  rankBase={rankBaseMap.get(project.id) ?? 0}
                  isDragging={draggingProject === project.id}
                  isDragTarget={dragOverProject === project.id && draggingProject !== project.id}
                  onDragStart={() => setDraggingProject(project.id)}
                  onDragOver={() => setDragOverProject(project.id)}
                  onDragEnd={() => handleProjectDragEnd(vertical.key)}
                />
              ))}

              {vProjects.length === 0 && (
                <div className="rounded-xl border border-dashed border-border/40 p-8 text-center">
                  <p className="text-xs text-muted-foreground/40">No projects yet</p>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </>
  )
}

// ─── Main Dashboard ───────────────────────────────────────────────────────────

export default function TrackerDashboard({ projects }: { projects: Project[] }) {
  const [view, setView] = useState<"weekly" | "monthly" | "focus">("weekly")
  const [weekOffset, setWeekOffset] = useState(0)
  const [monthOffset, setMonthOffset] = useState(0)

  const now = new Date()
  const targetMonth = new Date(now.getFullYear(), now.getMonth() + monthOffset, 1)
  const monthLabel = monthOffset === 0 ? "This Month"
    : monthOffset === -1 ? "Last Month"
    : targetMonth.toLocaleDateString("en-US", { month: "long", year: "numeric" })

  const totalProjects = projects.length
  const totalActiveGoals = projects.flatMap(p =>
    p.weeklyGoals.filter(g => isSameWeek(new Date(g.weekOf), getMondayOf(new Date())))
  )
  const doneToday = totalActiveGoals.filter(g => g.completed).length

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-7xl mx-auto px-5 py-8">

        {/* Header */}
        <div className="flex items-start justify-between mb-8">
          <div>
            <h1 className="text-xl font-bold tracking-tight">Project Tracker</h1>
            <p className="text-muted-foreground text-xs mt-1">
              {totalProjects} projects · {doneToday}/{totalActiveGoals.length} tasks done this week
            </p>
          </div>

          <div className="flex items-center gap-3">
            {/* Month nav (monthly view only) */}
            {view === "monthly" && (
              <div className="flex items-center gap-1 bg-muted/30 border border-border/50 rounded-xl px-1 py-1">
                <button onClick={() => setMonthOffset(m => m - 1)} className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-muted text-muted-foreground transition-colors">
                  <ChevronLeft size={15} />
                </button>
                <span className="text-sm font-medium px-3 min-w-28 text-center">{monthLabel}</span>
                <button onClick={() => setMonthOffset(m => m + 1)} className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-muted text-muted-foreground transition-colors">
                  <ChevronRight size={15} />
                </button>
                {monthOffset !== 0 && (
                  <button onClick={() => setMonthOffset(0)} className="text-xs text-muted-foreground hover:text-foreground px-2 py-1 rounded-lg hover:bg-muted transition-colors ml-1">
                    Now
                  </button>
                )}
              </div>
            )}

            {/* View toggle */}
            <div className="flex items-center bg-muted/30 border border-border/50 rounded-xl p-1 gap-0.5">
              <button
                onClick={() => setView("weekly")}
                className={cn("flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all",
                  view === "weekly" ? "bg-background shadow-sm text-foreground border border-border/50" : "text-muted-foreground hover:text-foreground"
                )}
              >
                <LayoutGrid size={13} /> Weekly
              </button>
              <button
                onClick={() => setView("focus")}
                className={cn("flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all",
                  view === "focus" ? "bg-background shadow-sm text-foreground border border-border/50" : "text-muted-foreground hover:text-foreground"
                )}
              >
                <Crosshair size={13} /> Focus
              </button>
              <button
                onClick={() => setView("monthly")}
                className={cn("flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all",
                  view === "monthly" ? "bg-background shadow-sm text-foreground border border-border/50" : "text-muted-foreground hover:text-foreground"
                )}
              >
                <Calendar size={13} /> Monthly
              </button>
            </div>
          </div>
        </div>

        {view === "weekly" && <WeeklyView projects={projects} weekOffset={weekOffset} setWeekOffset={setWeekOffset} />}
        {view === "focus" && <FocusView projects={projects} weekOffset={weekOffset} setWeekOffset={setWeekOffset} />}
        {view === "monthly" && <MonthlyView projects={projects} monthOffset={monthOffset} />}
      </div>
    </div>
  )
}
