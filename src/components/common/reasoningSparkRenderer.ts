type RenderTarget = {
  framebuffer: WebGLFramebuffer
  texture: WebGLTexture
}

type SparkUniforms = {
  time: WebGLUniformLocation | null
  elapsed: WebGLUniformLocation | null
  active: WebGLUniformLocation | null
  previous: WebGLUniformLocation | null
}

type BlurUniforms = {
  source: WebGLUniformLocation | null
  direction: WebGLUniformLocation | null
  resolution: WebGLUniformLocation | null
}

type CompositeUniforms = {
  scene: WebGLUniformLocation | null
  glow: WebGLUniformLocation | null
}

const VERTEX_SHADER = `#version 300 es
layout(location = 0) in vec2 a_position;
out vec2 v_uv;

void main() {
  v_uv = a_position * 0.5 + 0.5;
  gl_Position = vec4(a_position, 0.0, 1.0);
}
`

const SPARK_SHADER = `#version 300 es
precision highp float;

in vec2 v_uv;
out vec4 outColor;

uniform float u_time;
uniform float u_elapsed;
uniform float u_active;
uniform sampler2D u_previous;

float hash21(vec2 value) {
  value = fract(value * vec2(123.34, 456.21));
  value += dot(value, value + 45.32);
  return fract(value.x * value.y);
}

void main() {
  vec2 uv = v_uv;
  float leftFade = smoothstep(0.0, 0.42, uv.x);
  vec3 previous = texture(u_previous, uv).rgb;
  vec3 color = previous * 0.9 * leftFade;

  if (u_active > 0.5) {
    vec2 grid = uv * vec2(72.0, 5.0);
    vec2 cellId = floor(grid);
    vec2 inCell = abs(fract(grid) - 0.5);
    float seed = hash21(cellId);
    float cellShape = smoothstep(0.37, 0.28, max(inCell.x * 0.86, inCell.y));

    float cellDelay = seed * 1.05;
    float age = max(u_elapsed - cellDelay, 0.0);
    float ignited = step(0.001, age);
    float speed = 0.88 + seed * 0.28;
    float travelProgress = 1.0 - pow(
      1.0 - clamp(age / 2.35, 0.0, 1.0),
      3.0
    );
    float front = max(
      1.0 - travelProgress * speed - (seed - 0.5) * 0.035,
      0.025
    );
    float tailLength = max(1.0 - front, 0.001);
    float insideTrail = step(front - 0.004, uv.x);
    float distanceFromRight = clamp((1.0 - uv.x) / tailLength, 0.0, 1.0);
    float brightness = pow(max(1.0 - distanceFromRight, 0.0), 0.64);
    brightness = max(brightness, 0.055 * ignited) * insideTrail;
    brightness *= 1.0 - smoothstep(0.93, 1.03, distanceFromRight);

    float energyRamp = mix(0.22, 0.52, min(u_elapsed / 1.0, 1.0));
    float tempo = mix(0.82, 1.0, min(u_elapsed / 1.45, 1.0));
    float pulseA = sin(uv.x * 29.0 + u_time * 13.0 * tempo + seed * 6.1);
    float pulseB = sin(uv.x * 19.0 + u_time * 7.0 * tempo + seed * 3.2);
    float pulseC = sin(uv.x * 47.0 + u_time * 21.0 * tempo + seed * 9.4);
    float flicker = smoothstep(
      0.06,
      0.9,
      (pulseA + pulseB * 0.48 + pulseC * 0.22) * 0.34 + 0.5
    );

    float rhythmA = sin(distanceFromRight * 15.0 - u_time * 4.6 + seed * 2.7);
    float rhythmB = sin(distanceFromRight * 8.0 - u_time * 2.3 + seed * 4.8);
    float rhythm = smoothstep(-0.2, 0.52, rhythmA)
      * (rhythmB * 0.5 + 0.5);

    float waveAge = max(
      age - (1.0 - uv.x) / max(speed, 0.001),
      0.0
    );
    float arrivalFlash = step(0.0, waveAge) * exp(-waveAge * 3.4);
    float verticalShape = pow(
      max(1.0 - pow(abs(uv.y - 0.5) * 1.55, 2.0), 0.0),
      0.7
    );

    float sparkPhase = fract(u_time * (0.34 + seed * 0.14) + seed * 7.0);
    float sparkX = 1.0 - sparkPhase * tailLength;
    float sparkY = 0.5 + sin(sparkPhase * 10.0 + seed * 6.2) * 0.27;
    float spark = smoothstep(0.016, 0.0, abs(uv.x - sparkX))
      * smoothstep(0.19, 0.0, abs(uv.y - sparkY))
      * pow(1.0 - sparkPhase, 2.0)
      * energyRamp;

    float edge = exp(-pow((uv.x - front) * 19.0, 2.0))
      * (0.28 + flicker * rhythm * 1.15)
      * energyRamp;
    float energy = brightness * verticalShape
      * (flicker * 0.44 + rhythm * 0.34 + arrivalFlash * 0.48);
    energy += edge * verticalShape + spark * 0.58 * insideTrail;
    energy *= cellShape * leftFade * energyRamp;

    vec3 ember = vec3(0.22, 0.055, 0.48);
    vec3 violet = vec3(0.62, 0.25, 1.0);
    vec3 hot = vec3(1.0, 0.9, 1.0);
    float purpleHeat = clamp(
      brightness + arrivalFlash * 0.2 + spark * 0.18,
      0.0,
      1.0
    );
    float whiteHot = clamp(arrivalFlash * 0.72 + spark, 0.0, 1.0);
    vec3 sparkColor = mix(ember, violet, purpleHeat);
    sparkColor = mix(sparkColor, hot, pow(whiteHot, 3.0) * 0.48);

    float maxCore = exp(-pow((uv.x - 0.985) * 21.0, 2.0))
      * (0.78 + sin(u_time * 3.1) * 0.12);
    color += sparkColor * energy * 0.2;
    color += hot * maxCore * verticalShape * 0.065;
  }

  outColor = vec4(min(color, vec3(1.8)), 1.0);
}
`

const BLUR_SHADER = `#version 300 es
precision highp float;

in vec2 v_uv;
out vec4 outColor;

uniform sampler2D u_source;
uniform vec2 u_direction;
uniform vec2 u_resolution;

vec3 sampleGlow(vec2 uv) {
  vec3 color = texture(u_source, uv).rgb;
  float peak = max(color.r, max(color.g, color.b));
  float brightPass = u_direction.x > 0.5
    ? smoothstep(0.12, 0.38, peak)
    : 1.0;
  return color * brightPass;
}

void main() {
  vec2 offset = u_direction / u_resolution;
  vec3 color = sampleGlow(v_uv) * 0.227027;
  color += sampleGlow(v_uv + offset * 1.4) * 0.194595;
  color += sampleGlow(v_uv - offset * 1.4) * 0.194595;
  color += sampleGlow(v_uv + offset * 3.0) * 0.121622;
  color += sampleGlow(v_uv - offset * 3.0) * 0.121622;
  color += sampleGlow(v_uv + offset * 5.2) * 0.07027;
  color += sampleGlow(v_uv - offset * 5.2) * 0.07027;
  outColor = vec4(color, 1.0);
}
`

const COMPOSITE_SHADER = `#version 300 es
precision highp float;

in vec2 v_uv;
out vec4 outColor;

uniform sampler2D u_scene;
uniform sampler2D u_glow;

void main() {
  vec3 scene = texture(u_scene, v_uv).rgb;
  vec3 glow = texture(u_glow, v_uv).rgb;
  vec3 sceneEnergy = 1.0 - exp(-scene * 1.08);
  vec3 glowEnergy = 1.0 - exp(-glow * 1.2);
  float sceneIntensity = max(sceneEnergy.r, max(sceneEnergy.g, sceneEnergy.b));
  float glowIntensity = max(glowEnergy.r, max(glowEnergy.g, glowEnergy.b));

  vec3 sceneColor = sceneEnergy / max(sceneIntensity, 0.001);

  vec3 glowColor = glowEnergy / max(glowIntensity, 0.001);
  glowColor = mix(glowColor, vec3(0.82, 0.56, 1.0), 0.28);

  float sceneAlpha = pow(clamp(sceneIntensity, 0.0, 1.0), 0.5) * 0.9;
  float glowAlpha = pow(clamp(glowIntensity, 0.0, 1.0), 0.68) * 0.3;
  float alpha = sceneAlpha + glowAlpha * (1.0 - sceneAlpha);
  vec3 color = (
    sceneColor * sceneAlpha
    + glowColor * glowAlpha * (1.0 - sceneAlpha)
  ) / max(alpha, 0.001);

  outColor = vec4(color, clamp(alpha, 0.0, 0.92));
}
`

const FADE_OUT_MS = 360
const MAX_DPR = 2

export class ReasoningSparkRenderer {
  private readonly ownerDocument: Document
  private readonly ownerWindow: Window
  private readonly resizeObserver: ResizeObserver
  private gl: WebGL2RenderingContext | null = null
  private sparkProgram: WebGLProgram | null = null
  private blurProgram: WebGLProgram | null = null
  private compositeProgram: WebGLProgram | null = null
  private vao: WebGLVertexArrayObject | null = null
  private vertexBuffer: WebGLBuffer | null = null
  private sparkUniforms: SparkUniforms | null = null
  private blurUniforms: BlurUniforms | null = null
  private compositeUniforms: CompositeUniforms | null = null
  private simulationA: RenderTarget | null = null
  private simulationB: RenderTarget | null = null
  private blurA: RenderTarget | null = null
  private blurB: RenderTarget | null = null
  private animationFrame: number | null = null
  private active = false
  private destroyed = false
  private contextLost = false
  private activationStartedAt = 0
  private pausedAt: number | null = null
  private stopAfter = 0

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.ownerDocument = canvas.ownerDocument
    const ownerWindow = this.ownerDocument.defaultView
    if (!ownerWindow) throw new Error('Canvas has no owner window')
    this.ownerWindow = ownerWindow
    this.resizeObserver = new ownerWindow.ResizeObserver(this.handleResize)
    this.resizeObserver.observe(canvas)
    this.canvas.addEventListener('webglcontextlost', this.handleContextLost)
    this.canvas.addEventListener(
      'webglcontextrestored',
      this.handleContextRestored,
    )
    this.ownerDocument.addEventListener(
      'visibilitychange',
      this.handleVisibilityChange,
    )
  }

  setActive(active: boolean): void {
    if (this.destroyed || this.active === active) return
    this.active = active
    const now = this.ownerWindow.performance.now()

    if (active) {
      this.activationStartedAt = now
      this.stopAfter = Number.POSITIVE_INFINITY
      if (!this.ensureInitialized()) return
      this.clearSimulation()
      this.startLoop()
      return
    }

    this.stopAfter = now + FADE_OUT_MS
    this.startLoop()
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.stopLoop()
    this.resizeObserver.disconnect()
    this.canvas.removeEventListener('webglcontextlost', this.handleContextLost)
    this.canvas.removeEventListener(
      'webglcontextrestored',
      this.handleContextRestored,
    )
    this.ownerDocument.removeEventListener(
      'visibilitychange',
      this.handleVisibilityChange,
    )
    this.destroyResources()
    this.gl = null
  }

  private readonly handleResize = (): void => {
    if (!this.gl || this.contextLost) return
    const rect = this.canvas.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return
    const dpr = Math.min(this.ownerWindow.devicePixelRatio || 1, MAX_DPR)
    const width = Math.max(1, Math.round(rect.width * dpr))
    const height = Math.max(1, Math.round(rect.height * dpr))
    const sizeChanged =
      this.canvas.width !== width || this.canvas.height !== height
    if (!sizeChanged && this.simulationA) return
    if (sizeChanged) {
      this.canvas.width = width
      this.canvas.height = height
    }
    this.createRenderTargets()
    if (this.active) this.startLoop()
  }

  private readonly handleContextLost = (event: Event): void => {
    event.preventDefault()
    this.contextLost = true
    this.stopLoop()
    this.clearResourceReferences()
  }

  private readonly handleContextRestored = (): void => {
    this.contextLost = false
    if (!this.gl || !this.createResources()) return
    this.handleResize()
    if (this.active) {
      this.activationStartedAt = this.ownerWindow.performance.now()
      this.clearSimulation()
      this.startLoop()
    }
  }

  private readonly handleVisibilityChange = (): void => {
    const now = this.ownerWindow.performance.now()
    if (this.ownerDocument.hidden) {
      this.pausedAt = now
      this.stopLoop()
      return
    }

    if (this.pausedAt !== null && this.active) {
      this.activationStartedAt += now - this.pausedAt
    }
    this.pausedAt = null
    if (this.active || now < this.stopAfter) this.startLoop()
  }

  private ensureInitialized(): boolean {
    if (this.gl && this.sparkProgram && this.simulationA) return true

    const gl = this.canvas.getContext('webgl2', {
      alpha: true,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: false,
      powerPreference: 'low-power',
    })
    if (!gl) return false
    this.gl = gl
    if (!this.createResources()) return false
    this.handleResize()
    return this.simulationA !== null
  }

  private createResources(): boolean {
    const gl = this.gl
    if (!gl) return false
    this.destroyResources()
    this.gl = gl

    this.sparkProgram = this.createProgram(VERTEX_SHADER, SPARK_SHADER)
    this.blurProgram = this.createProgram(VERTEX_SHADER, BLUR_SHADER)
    this.compositeProgram = this.createProgram(VERTEX_SHADER, COMPOSITE_SHADER)
    if (!this.sparkProgram || !this.blurProgram || !this.compositeProgram) {
      this.destroyResources()
      this.gl = gl
      return false
    }

    this.vao = gl.createVertexArray()
    this.vertexBuffer = gl.createBuffer()
    if (!this.vao || !this.vertexBuffer) {
      this.destroyResources()
      this.gl = gl
      return false
    }
    gl.bindVertexArray(this.vao)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer)
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
      gl.STATIC_DRAW,
    )
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)

    this.sparkUniforms = {
      time: gl.getUniformLocation(this.sparkProgram, 'u_time'),
      elapsed: gl.getUniformLocation(this.sparkProgram, 'u_elapsed'),
      active: gl.getUniformLocation(this.sparkProgram, 'u_active'),
      previous: gl.getUniformLocation(this.sparkProgram, 'u_previous'),
    }
    this.blurUniforms = {
      source: gl.getUniformLocation(this.blurProgram, 'u_source'),
      direction: gl.getUniformLocation(this.blurProgram, 'u_direction'),
      resolution: gl.getUniformLocation(this.blurProgram, 'u_resolution'),
    }
    this.compositeUniforms = {
      scene: gl.getUniformLocation(this.compositeProgram, 'u_scene'),
      glow: gl.getUniformLocation(this.compositeProgram, 'u_glow'),
    }
    return true
  }

  private createProgram(
    vertexSource: string,
    fragmentSource: string,
  ): WebGLProgram | null {
    const gl = this.gl
    if (!gl) return null
    const vertexShader = this.compileShader(gl.VERTEX_SHADER, vertexSource)
    const fragmentShader = this.compileShader(
      gl.FRAGMENT_SHADER,
      fragmentSource,
    )
    if (!vertexShader || !fragmentShader) {
      if (vertexShader) gl.deleteShader(vertexShader)
      if (fragmentShader) gl.deleteShader(fragmentShader)
      return null
    }

    const program = gl.createProgram()
    if (!program) {
      gl.deleteShader(vertexShader)
      gl.deleteShader(fragmentShader)
      return null
    }
    gl.attachShader(program, vertexShader)
    gl.attachShader(program, fragmentShader)
    gl.linkProgram(program)
    gl.deleteShader(vertexShader)
    gl.deleteShader(fragmentShader)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      console.error(
        '[YOLO] Failed to link reasoning spark shader',
        gl.getProgramInfoLog(program),
      )
      gl.deleteProgram(program)
      return null
    }
    return program
  }

  private compileShader(type: number, source: string): WebGLShader | null {
    const gl = this.gl
    if (!gl) return null
    const shader = gl.createShader(type)
    if (!shader) return null
    gl.shaderSource(shader, source)
    gl.compileShader(shader)
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      console.error(
        '[YOLO] Failed to compile reasoning spark shader',
        gl.getShaderInfoLog(shader),
      )
      gl.deleteShader(shader)
      return null
    }
    return shader
  }

  private createRenderTargets(): void {
    const gl = this.gl
    if (!gl || this.canvas.width <= 0 || this.canvas.height <= 0) return
    this.destroyRenderTargets()
    this.simulationA = this.createRenderTarget()
    this.simulationB = this.createRenderTarget()
    this.blurA = this.createRenderTarget()
    this.blurB = this.createRenderTarget()
    if (!this.simulationA || !this.simulationB || !this.blurA || !this.blurB) {
      this.destroyRenderTargets()
      return
    }
    this.clearSimulation()
  }

  private createRenderTarget(): RenderTarget | null {
    const gl = this.gl
    if (!gl) return null
    const framebuffer = gl.createFramebuffer()
    const texture = gl.createTexture()
    if (!framebuffer || !texture) {
      if (framebuffer) gl.deleteFramebuffer(framebuffer)
      if (texture) gl.deleteTexture(texture)
      return null
    }

    gl.bindTexture(gl.TEXTURE_2D, texture)
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      this.canvas.width,
      this.canvas.height,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      null,
    )
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer)
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D,
      texture,
      0,
    )
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      gl.deleteFramebuffer(framebuffer)
      gl.deleteTexture(texture)
      return null
    }
    return { framebuffer, texture }
  }

  private clearSimulation(): void {
    const gl = this.gl
    if (!gl) return
    gl.clearColor(0, 0, 0, 1)
    for (const target of [
      this.simulationA,
      this.simulationB,
      this.blurA,
      this.blurB,
    ]) {
      if (!target) continue
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer)
      gl.clear(gl.COLOR_BUFFER_BIT)
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
  }

  private startLoop(): void {
    if (
      this.animationFrame !== null ||
      this.destroyed ||
      this.contextLost ||
      this.ownerDocument.hidden ||
      !this.simulationA
    ) {
      return
    }
    this.animationFrame = this.ownerWindow.requestAnimationFrame(this.render)
  }

  private stopLoop(): void {
    if (this.animationFrame === null) return
    this.ownerWindow.cancelAnimationFrame(this.animationFrame)
    this.animationFrame = null
  }

  private readonly render = (now: number): void => {
    this.animationFrame = null
    const gl = this.gl
    if (
      !gl ||
      !this.sparkProgram ||
      !this.blurProgram ||
      !this.compositeProgram ||
      !this.vao ||
      !this.sparkUniforms ||
      !this.blurUniforms ||
      !this.compositeUniforms ||
      !this.simulationA ||
      !this.simulationB ||
      !this.blurA ||
      !this.blurB
    ) {
      return
    }

    gl.viewport(0, 0, this.canvas.width, this.canvas.height)
    gl.bindVertexArray(this.vao)
    gl.disable(gl.BLEND)

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.simulationB.framebuffer)
    gl.useProgram(this.sparkProgram)
    gl.uniform1f(this.sparkUniforms.time, now / 1000)
    gl.uniform1f(
      this.sparkUniforms.elapsed,
      Math.max(0, (now - this.activationStartedAt) / 1000),
    )
    gl.uniform1f(this.sparkUniforms.active, this.active ? 1 : 0)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.simulationA.texture)
    gl.uniform1i(this.sparkUniforms.previous, 0)
    gl.drawArrays(gl.TRIANGLES, 0, 6)

    gl.useProgram(this.blurProgram)
    gl.uniform2f(
      this.blurUniforms.resolution,
      this.canvas.width,
      this.canvas.height,
    )
    gl.activeTexture(gl.TEXTURE0)
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.blurA.framebuffer)
    gl.bindTexture(gl.TEXTURE_2D, this.simulationB.texture)
    gl.uniform1i(this.blurUniforms.source, 0)
    gl.uniform2f(this.blurUniforms.direction, 1, 0)
    gl.drawArrays(gl.TRIANGLES, 0, 6)

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.blurB.framebuffer)
    gl.bindTexture(gl.TEXTURE_2D, this.blurA.texture)
    gl.uniform2f(this.blurUniforms.direction, 0, 1)
    gl.drawArrays(gl.TRIANGLES, 0, 6)

    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.useProgram(this.compositeProgram)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.simulationB.texture)
    gl.uniform1i(this.compositeUniforms.scene, 0)
    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_2D, this.blurB.texture)
    gl.uniform1i(this.compositeUniforms.glow, 1)
    gl.drawArrays(gl.TRIANGLES, 0, 6)

    const previous = this.simulationA
    this.simulationA = this.simulationB
    this.simulationB = previous

    if (this.active || now < this.stopAfter) this.startLoop()
  }

  private destroyRenderTargets(): void {
    const gl = this.gl
    if (gl) {
      for (const target of [
        this.simulationA,
        this.simulationB,
        this.blurA,
        this.blurB,
      ]) {
        if (!target) continue
        gl.deleteFramebuffer(target.framebuffer)
        gl.deleteTexture(target.texture)
      }
    }
    this.simulationA = null
    this.simulationB = null
    this.blurA = null
    this.blurB = null
  }

  private destroyResources(): void {
    const gl = this.gl
    this.destroyRenderTargets()
    if (gl) {
      if (this.sparkProgram) gl.deleteProgram(this.sparkProgram)
      if (this.blurProgram) gl.deleteProgram(this.blurProgram)
      if (this.compositeProgram) gl.deleteProgram(this.compositeProgram)
      if (this.vao) gl.deleteVertexArray(this.vao)
      if (this.vertexBuffer) gl.deleteBuffer(this.vertexBuffer)
    }
    this.clearResourceReferences()
  }

  private clearResourceReferences(): void {
    this.sparkProgram = null
    this.blurProgram = null
    this.compositeProgram = null
    this.vao = null
    this.vertexBuffer = null
    this.sparkUniforms = null
    this.blurUniforms = null
    this.compositeUniforms = null
    this.simulationA = null
    this.simulationB = null
    this.blurA = null
    this.blurB = null
  }
}
