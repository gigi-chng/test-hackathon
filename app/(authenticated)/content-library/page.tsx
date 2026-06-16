import { getContent, getAllTags } from "@/lib/actions/content-library"
import ContentLibrary from "./ContentLibrary"

export default async function ContentLibraryPage() {
  const [content, tags] = await Promise.all([getContent(), getAllTags()])
  return <ContentLibrary initialContent={content} initialTags={tags} />
}
