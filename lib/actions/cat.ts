"use server"

export async function fetchCatImageAsDataUrl(): Promise<string> {
  // Fetch a random cat image URL from TheCatAPI
  const res = await fetch("https://api.thecatapi.com/v1/images/search")
  const data = await res.json()
  const imageUrl: string = data[0].url

  // Fetch the actual image on the server (no CORS restrictions)
  const imgRes = await fetch(imageUrl)
  const buffer = await imgRes.arrayBuffer()
  const contentType = imgRes.headers.get("content-type") ?? "image/jpeg"
  const base64 = Buffer.from(buffer).toString("base64")

  return `data:${contentType};base64,${base64}`
}
