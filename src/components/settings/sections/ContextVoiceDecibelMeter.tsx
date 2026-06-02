import { Play } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'

export const DECIBEL_CHART_FLOOR = -50
export const DECIBEL_CHART_CEILING = -5

const DECIBEL_HISTOGRAM_BINS = 100
const DECIBEL_AXIS_TICKS = [-50, -40, -30, -20, -10, -5] as const
const DECIBEL_ANALYSER_FFT_SIZE = 4096

const clampChartDecibels = (value: number): number =>
  Math.min(DECIBEL_CHART_CEILING, Math.max(DECIBEL_CHART_FLOOR, value))

const decibelToPercent = (value: number): number =>
  ((clampChartDecibels(value) - DECIBEL_CHART_FLOOR) /
    (DECIBEL_CHART_CEILING - DECIBEL_CHART_FLOOR)) *
  100

const formatDecibels = (value: number | null): string =>
  value === null ? '--.- dB' : `${value.toFixed(1)} dB`

const decibelToBin = (value: number): number => {
  const ratio = decibelToPercent(value) / 100
  return Math.min(
    DECIBEL_HISTOGRAM_BINS - 1,
    Math.max(0, Math.floor(ratio * DECIBEL_HISTOGRAM_BINS)),
  )
}

const getCssVar = (
  element: HTMLElement,
  name: string,
  fallback: string,
): string => {
  const value = getComputedStyle(element).getPropertyValue(name).trim()
  return value || fallback
}

const paintDecibelHistogram = ({
  canvas,
  histogram,
  highlight,
}: {
  canvas: HTMLCanvasElement | null
  histogram: Float32Array
  highlight: Float32Array
}): void => {
  if (!canvas) return
  const rect = canvas.getBoundingClientRect()
  if (rect.width <= 0 || rect.height <= 0) return

  const dpr = window.devicePixelRatio || 1
  const width = Math.max(1, Math.floor(rect.width * dpr))
  const height = Math.max(1, Math.floor(rect.height * dpr))
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width
    canvas.height = height
  }

  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, rect.width, rect.height)

  const accent = getCssVar(canvas, '--interactive-accent', '#7c5cff')
  const accentHover = getCssVar(canvas, '--interactive-accent-hover', accent)

  const maxCount = Math.max(0, ...histogram)
  const maxLogCount = Math.max(1, Math.log1p(maxCount))
  const binWidth = rect.width / histogram.length
  const centerY = rect.height / 2
  const maxHalfHeight = Math.max(1, rect.height / 2 - 6)
  const lineWidth = Math.max(1, Math.min(3, binWidth * 0.72))
  ctx.lineCap = 'round'
  for (let index = 0; index < histogram.length; index += 1) {
    const count = histogram[index]
    const highlightLevel = Math.max(0, Math.min(1, highlight[index] ?? 0))
    const x = index * binWidth + binWidth / 2
    const scaledCount = count > 0 ? Math.log1p(count) / maxLogCount : 0
    const halfHeight = count > 0 ? Math.max(2, scaledCount * maxHalfHeight) : 1
    const gradient = ctx.createLinearGradient(
      0,
      centerY - halfHeight,
      0,
      centerY + halfHeight,
    )
    gradient.addColorStop(0, accentHover)
    gradient.addColorStop(1, accent)
    ctx.strokeStyle = gradient
    ctx.globalAlpha = count > 0 ? 0.5 : 0.28
    ctx.lineWidth = lineWidth
    ctx.beginPath()
    ctx.moveTo(x, centerY - halfHeight)
    ctx.lineTo(x, centerY + halfHeight)
    ctx.stroke()
    if (highlightLevel > 0.02) {
      ctx.strokeStyle = accentHover
      ctx.globalAlpha = 0.16 + highlightLevel * 0.8
      ctx.beginPath()
      ctx.moveTo(x, centerY - halfHeight)
      ctx.lineTo(x, centerY + halfHeight)
      ctx.stroke()
    }
  }
  ctx.globalAlpha = 1
}

type VoiceDecibelMeterProps = {
  t: (keyPath: string, fallback?: string) => string
  deviceId: string
  speechStartDecibels: number
  silenceDecibels: number
  speechRequiredMs: number
  silenceHoldMs: number
}

type ActiveVadState = 'speech' | 'silence' | null

export function VoiceDecibelMeter({
  t,
  deviceId,
  speechStartDecibels,
  silenceDecibels,
  speechRequiredMs,
  silenceHoldMs,
}: VoiceDecibelMeterProps) {
  const [monitoring, setMonitoring] = useState(false)
  const [levelDb, setLevelDb] = useState<number | null>(null)
  const [peakDb, setPeakDb] = useState<number | null>(null)
  const [activeVadState, setActiveVadState] = useState<ActiveVadState>(null)
  const [error, setError] = useState('')
  const streamRef = useRef<MediaStream | null>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null)
  const rafRef = useRef<number | null>(null)
  const startRunRef = useRef(0)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const histogramRef = useRef(new Float32Array(DECIBEL_HISTOGRAM_BINS))
  const highlightRef = useRef(new Float32Array(DECIBEL_HISTOGRAM_BINS))
  const vadSpeechActiveSinceMsRef = useRef(0)
  const vadSilenceSinceMsRef = useRef(0)
  const vadEverHeardSpeechRef = useRef(false)
  const vadOptionsRef = useRef({
    speechStartDecibels,
    silenceDecibels,
    speechRequiredMs,
    silenceHoldMs,
  })

  useEffect(() => {
    paintDecibelHistogram({
      canvas: canvasRef.current,
      histogram: histogramRef.current,
      highlight: highlightRef.current,
    })
  }, [levelDb])

  useEffect(() => {
    vadOptionsRef.current = {
      speechStartDecibels,
      silenceDecibels,
      speechRequiredMs,
      silenceHoldMs,
    }
  }, [silenceDecibels, silenceHoldMs, speechRequiredMs, speechStartDecibels])

  const stop = useCallback(() => {
    startRunRef.current += 1
    if (rafRef.current !== null) {
      window.cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
    try {
      sourceRef.current?.disconnect()
    } catch {
      // Best-effort cleanup.
    }
    sourceRef.current = null
    if (audioContextRef.current) {
      void audioContextRef.current.close()
      audioContextRef.current = null
    }
    streamRef.current?.getTracks().forEach((track) => track.stop())
    streamRef.current = null
    highlightRef.current.fill(0)
    vadSpeechActiveSinceMsRef.current = 0
    vadSilenceSinceMsRef.current = 0
    vadEverHeardSpeechRef.current = false
    setActiveVadState(null)
    setMonitoring(false)
    setLevelDb(null)
    setPeakDb(null)
  }, [])

  useEffect(() => stop, [stop])

  const start = useCallback(async () => {
    const runId = startRunRef.current + 1
    startRunRef.current = runId
    setError('')
    const mediaDevices = navigator.mediaDevices
    if (!mediaDevices?.getUserMedia) {
      setError(
        t(
          'settings.contextVoiceInput.decibelMeterUnavailable',
          'Microphone level meter is not available in this environment.',
        ),
      )
      return
    }

    try {
      const audioConstraint: MediaTrackConstraints | boolean = deviceId
        ? { deviceId: { exact: deviceId } }
        : true
      const stream = await mediaDevices.getUserMedia({
        audio: audioConstraint,
      })
      if (startRunRef.current !== runId) {
        stream.getTracks().forEach((track) => track.stop())
        return
      }
      const AudioContextCtor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext
      if (!AudioContextCtor) {
        throw new Error('AudioContext is not available.')
      }

      const ctx = new AudioContextCtor()
      await ctx.resume()
      if (startRunRef.current !== runId) {
        stream.getTracks().forEach((track) => track.stop())
        void ctx.close()
        return
      }
      const analyser = ctx.createAnalyser()
      analyser.fftSize = DECIBEL_ANALYSER_FFT_SIZE
      analyser.smoothingTimeConstant = 0.15
      analyser.minDecibels = DECIBEL_CHART_FLOOR
      const source = ctx.createMediaStreamSource(stream)
      source.connect(analyser)
      const buffer = new Uint8Array(analyser.fftSize)

      streamRef.current = stream
      audioContextRef.current = ctx
      sourceRef.current = source
      histogramRef.current.fill(0)
      highlightRef.current.fill(0)
      vadSpeechActiveSinceMsRef.current = 0
      vadSilenceSinceMsRef.current = 0
      vadEverHeardSpeechRef.current = false
      setMonitoring(true)
      setActiveVadState('silence')
      setLevelDb(DECIBEL_CHART_FLOOR)
      setPeakDb(DECIBEL_CHART_FLOOR)

      const draw = () => {
        analyser.getByteTimeDomainData(buffer)
        let sumSquares = 0
        for (let index = 0; index < buffer.length; index += 1) {
          const value = (buffer[index] - 128) / 128
          sumSquares += value * value
        }
        const rms = Math.sqrt(sumSquares / buffer.length)
        // Keep this formula in sync with voiceFloatingIslandController VAD
        // so the settings meter reflects the thresholds used at runtime.
        const nextDb = rms > 0 ? 20 * Math.log10(rms) : -120
        const now = Date.now()
        const vadOptions = vadOptionsRef.current
        if (!vadEverHeardSpeechRef.current) {
          if (nextDb > vadOptions.speechStartDecibels) {
            if (vadSpeechActiveSinceMsRef.current === 0) {
              vadSpeechActiveSinceMsRef.current = now
            }
            if (
              now - vadSpeechActiveSinceMsRef.current >=
              vadOptions.speechRequiredMs
            ) {
              vadEverHeardSpeechRef.current = true
              vadSilenceSinceMsRef.current = 0
              setActiveVadState('speech')
            } else {
              setActiveVadState('silence')
            }
          } else {
            vadSpeechActiveSinceMsRef.current = 0
            setActiveVadState('silence')
          }
        } else if (nextDb > vadOptions.silenceDecibels) {
          vadSilenceSinceMsRef.current = 0
          setActiveVadState('speech')
        } else {
          vadSpeechActiveSinceMsRef.current = 0
          if (vadSilenceSinceMsRef.current === 0) {
            vadSilenceSinceMsRef.current = now
          }
          if (now - vadSilenceSinceMsRef.current >= vadOptions.silenceHoldMs) {
            vadSilenceSinceMsRef.current = 0
            vadEverHeardSpeechRef.current = false
            setActiveVadState('silence')
          } else {
            setActiveVadState('speech')
          }
        }

        const bin = decibelToBin(nextDb)
        histogramRef.current[bin] += 1
        for (let index = 0; index < highlightRef.current.length; index += 1) {
          highlightRef.current[index] *= 0.72
        }
        highlightRef.current[bin] = 1
        paintDecibelHistogram({
          canvas: canvasRef.current,
          histogram: histogramRef.current,
          highlight: highlightRef.current,
        })
        setLevelDb(nextDb)
        setPeakDb((current) =>
          current === null ? nextDb : Math.max(current, nextDb),
        )
        rafRef.current = window.requestAnimationFrame(draw)
      }
      draw()
    } catch (caught) {
      console.error('Failed to start voice decibel meter', caught)
      stop()
      setError(
        t(
          'settings.contextVoiceInput.decibelMeterPermissionError',
          'Could not read the microphone. Check permission and device selection.',
        ),
      )
    }
  }, [deviceId, stop, t])

  const toggle = () => {
    if (monitoring) {
      stop()
      return
    }
    void start()
  }
  const buttonLabel = monitoring
    ? t('settings.contextVoiceInput.decibelMeterStop', 'Stop')
    : t('settings.contextVoiceInput.decibelMeterStart', 'Start')

  return (
    <div className="yolo-voice-decibel-meter">
      <div className="yolo-voice-decibel-meter__top">
        <div className="yolo-voice-decibel-meter__readout">
          <span className="yolo-voice-decibel-meter__value">
            {formatDecibels(levelDb)}
          </span>
          <span className="yolo-voice-decibel-meter__peak">
            {t('settings.contextVoiceInput.decibelMeterPeak', 'Peak')}{' '}
            {formatDecibels(peakDb)}
          </span>
        </div>
        <button
          type="button"
          className={`yolo-voice-decibel-meter__button mod-${
            monitoring ? 'warning' : 'cta'
          }`}
          aria-label={buttonLabel}
          onClick={toggle}
        >
          {monitoring ? (
            <span className="yolo-voice-decibel-meter__stop-icon" />
          ) : (
            <Play size={16} fill="currentColor" />
          )}
        </button>
      </div>

      <div className="yolo-voice-decibel-meter__plot">
        <canvas
          ref={canvasRef}
          className="yolo-voice-decibel-meter__histogram"
          role="img"
          aria-label={t(
            'settings.contextVoiceInput.decibelMeterLevel',
            'Current microphone level',
          )}
        />
        <div
          className={`yolo-voice-decibel-meter__marker yolo-voice-decibel-meter__marker--speech${
            activeVadState === 'speech' ? ' is-active' : ''
          }`}
          style={{ left: `${decibelToPercent(speechStartDecibels)}%` }}
          aria-hidden="true"
        >
          <span>
            {t(
              'settings.contextVoiceInput.decibelMeterSpeechStart',
              'Speech start',
            )}
          </span>
        </div>
        <div
          className={`yolo-voice-decibel-meter__marker yolo-voice-decibel-meter__marker--silence${
            activeVadState === 'silence' ? ' is-active' : ''
          }`}
          style={{ left: `${decibelToPercent(silenceDecibels)}%` }}
          aria-hidden="true"
        >
          <span>
            {t('settings.contextVoiceInput.decibelMeterSilence', 'Silence')}
          </span>
        </div>
      </div>

      <div className="yolo-voice-decibel-meter__axis" aria-hidden="true">
        {DECIBEL_AXIS_TICKS.map((tick) => (
          <span key={tick}>{tick} dB</span>
        ))}
      </div>

      {error && <div className="yolo-voice-decibel-meter__error">{error}</div>}
    </div>
  )
}
