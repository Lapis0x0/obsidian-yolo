// The typesetting worker (package.json `yoloModule.workers.typeset`): the
// board's text and note cards laid out off the main thread (./typesetter.ts)
// — into the GPU scene's instances, or drawn into their pictures — in the
// fonts the board hands it (`fonts`) — a worker's own FontFaceSet starts with none of the
// document's web fonts.
//
// Speaks the host's worker calls: `{ id, method, payload }` in, `{ id,
// result }` or `{ id, error }` out.

import type {
  FontsPayload,
  PicturePayload,
  TypesetPayload,
} from './typesetProtocol'
import { Typesetter } from './typesetter'

type WorkerScope = Readonly<{
  // The set's add and delete, which the TypeScript lib leaves out.
  fonts: Readonly<{
    add: (face: FontFace) => void
    delete: (face: FontFace) => boolean
  }>
  postMessage: (message: unknown, transfer?: Transferable[]) => void
  addEventListener: (
    type: 'message',
    listener: (event: MessageEvent) => void,
  ) => void
}>

const scope = self as unknown as WorkerScope
const canvas = new OffscreenCanvas(1, 1)
const ctx = canvas.getContext('2d')
const pixel = new OffscreenCanvas(1, 1).getContext('2d', {
  willReadFrequently: true,
})
if (!ctx || !pixel) throw new Error('no OffscreenCanvas 2D context')
const typesetter = new Typesetter(ctx, pixel)
/** Settles once the last fonts handed over have loaded, or failed to. */
let fontsReady: Promise<unknown> = Promise.resolve()
let loaded: FontFace[] = []

function loadFonts(payload: FontsPayload): Promise<number> {
  for (const face of loaded) scope.fonts.delete(face)
  loaded = payload.faces.map(
    (face) => new FontFace(face.family, face.src, face.descriptors),
  )
  for (const face of loaded) scope.fonts.add(face)
  fontsReady = Promise.all(
    // A face that fails is left out: the canvas falls back as the
    // document does when a face cannot load.
    loaded.map((face) => face.load().catch(() => null)),
  ).then(() => typesetter.reset())
  return fontsReady.then(
    () => loaded.filter((face) => face.status === 'loaded').length,
  )
}

scope.addEventListener('message', (event: MessageEvent) => {
  const message = event.data as {
    id?: unknown
    method?: unknown
    payload?: unknown
  }
  if (typeof message?.id !== 'number') return
  const id = message.id
  const fail = (error: unknown) =>
    scope.postMessage({
      id,
      error: error instanceof Error ? error.message : String(error),
    })
  if (message.method === 'fonts') {
    loadFonts(message.payload as FontsPayload).then(
      (count) => scope.postMessage({ id, result: count }),
      fail,
    )
    return
  }
  if (message.method === 'picture') {
    const { tokens, card, scale, fade } = message.payload as PicturePayload
    fontsReady
      .then(() => {
        const bitmap = typesetter.picture(tokens, card, scale, fade)
        scope.postMessage({ id, result: bitmap }, [bitmap])
      })
      .catch(fail)
    return
  }
  if (message.method === 'typeset') {
    const payload = message.payload as TypesetPayload
    fontsReady
      .then(() => {
        const { result, transfer } = typesetter.typeset(
          payload.tokens,
          payload.cards,
        )
        scope.postMessage({ id, result }, transfer)
      })
      .catch(fail)
  }
})
