import { wrapPcm16AsWav } from './utils'

export type AudioOutputDevice = {
  deviceId: string
  label: string
}

export const enumerateAudioOutputDevices = async (): Promise<
  AudioOutputDevice[]
> => {
  if (
    typeof navigator === 'undefined' ||
    !navigator.mediaDevices ||
    typeof navigator.mediaDevices.enumerateDevices !== 'function'
  ) {
    return []
  }
  const devices = await navigator.mediaDevices.enumerateDevices()
  return devices
    .filter((device) => device.kind === 'audiooutput')
    .map((device) => ({
      deviceId: device.deviceId,
      label: device.label || '',
    }))
}

export const applyAudioOutputDevice = async (
  media: HTMLMediaElement,
  deviceId: string,
): Promise<boolean> => {
  if (!deviceId) return true
  const output = media as HTMLMediaElement & {
    setSinkId?: (sinkId: string) => Promise<void>
  }
  if (!output.setSinkId) return false
  await output.setSinkId(deviceId)
  return true
}

export const createSpeakerTestToneUrl = (): string => {
  const sampleRate = 44_100
  const durationSeconds = 0.9
  const sampleCount = Math.floor(sampleRate * durationSeconds)
  const pcm = new ArrayBuffer(sampleCount * 2)
  const view = new DataView(pcm)
  const notes = [
    { start: 0.04, duration: 0.42, frequency: 523.25, gain: 0.18 },
    { start: 0.22, duration: 0.52, frequency: 659.25, gain: 0.14 },
    { start: 0.42, duration: 0.36, frequency: 783.99, gain: 0.1 },
  ]
  for (let i = 0; i < sampleCount; i++) {
    const time = i / sampleRate
    let sample = 0
    for (const note of notes) {
      const localTime = time - note.start
      if (localTime < 0 || localTime > note.duration) continue
      const attack = Math.min(1, localTime / 0.035)
      const release = Math.max(0, 1 - localTime / note.duration)
      const envelope = attack * release * release
      const fundamental =
        Math.sin(2 * Math.PI * note.frequency * localTime) * note.gain
      const shimmer =
        Math.sin(2 * Math.PI * note.frequency * 2 * localTime) *
        note.gain *
        0.18
      sample += (fundamental + shimmer) * envelope
    }
    view.setInt16(i * 2, floatToPcm16(sample), true)
  }
  const wav = wrapPcm16AsWav({
    pcm,
    sampleRate,
    channels: 1,
  })
  return URL.createObjectURL(new Blob([wav], { type: 'audio/wav' }))
}

const floatToPcm16 = (value: number): number => {
  const clamped = Math.max(-1, Math.min(1, value))
  return clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff
}
