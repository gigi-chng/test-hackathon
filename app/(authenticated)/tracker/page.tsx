import { getProjects, seedDefaultProjects } from "@/lib/actions/tracker"
import TrackerDashboard from "./TrackerDashboard"

export default async function TrackerPage() {
  await seedDefaultProjects()
  const projects = await getProjects()
  return <TrackerDashboard projects={projects} />
}
