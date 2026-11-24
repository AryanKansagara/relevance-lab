// State in the URL hash: JSON, deflated, base64url.
async function pump(bytes: Uint8Array, stream: { readable: ReadableStream<Uint8Array>; writable: WritableStream<any> }) {
  const writer = stream.writable.getWriter()
  // Bad input rejects the writable side as well as the readable side. Await both together so
  // neither rejection is left unhandled and the caller sees a single error.
  const written = writer.write(bytes as unknown as BufferSource).then(() => writer.close())
  const [out] = await Promise.all([new Response(stream.readable as ReadableStream).arrayBuffer(), written])
  return new Uint8Array(out)
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
  const state: unknown = JSON.parse(new TextDecoder().decode(out))
  // A link that inflates to valid JSON that is not a workspace object (null, a number, an array) is damaged too.
  if (state === null || typeof state !== 'object' || Array.isArray(state)) throw new Error('Share link does not contain a workspace')
  return state as T
}
