import type { RequestMessage } from '../../../types/llm/request'

import type { SurfaceContextInjection } from './types'

/**
 * Render the free-form description of the surface Quick Ask was opened from.
 *
 * Resolved here rather than at panel-open time: the surface keeps changing
 * while the panel is up, and assembling the description can mean reading
 * files. Whoever supplied it is outside the host (a module owns its own
 * board), so a failure to describe the surface degrades the answer instead of
 * failing the request.
 */
export async function renderSurfaceContextInjection(
  injection: SurfaceContextInjection,
): Promise<RequestMessage | null> {
  let text: string
  try {
    text = await injection.getText()
  } catch (error) {
    console.error('[YOLO] Failed to build surface context injection:', error)
    return null
  }

  const trimmed = typeof text === 'string' ? text.trim() : ''
  if (!trimmed) return null

  return {
    role: 'user',
    content: [
      '# Surface Context',
      'The editor the user is writing in is embedded in a larger surface. Here is what surrounds it:',
      `"""\n${trimmed}\n"""`,
      '',
    ].join('\n'),
  }
}
