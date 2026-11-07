// State in the URL hash: JSON, deflated, base64url.
async function pump(bytes: Uint8Array, stream: { readable: ReadableStream<Uint8Array>; writable: WritableStream<any> }) {
  const writer = stream.writable.getWriter()
  writer.write(bytes as unknown as BufferSource)
  writer.close()
  return new Uint8Array(await new Response(stream.readable as ReadableStream).arrayBuffer())
}

export async function encodeState(state: unknown): Promise<string> {
  const out = await pump(new TextEncoder().encode(JSON.stringify(state)), new CompressionStream('deflate-raw') as any)
  let s = ''
  for (const b of out) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export async function decodeState<T>(hash: string): Promise<T> {
  const s = atob(hash.replace(/-/g, '+').replace(/_/g, '/'))
  const bytes = Uint8Array.from(s, (c) => c.charCodeAt(0))
  const out = await pump(bytes, new DecompressionStream('deflate-raw') as any)
  return JSON.parse(new TextDecoder().decode(out)) as T
}
