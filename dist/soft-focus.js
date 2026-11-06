const root = document.documentElement;
const canvas = document.querySelector("#soft-focus");
const fuzzyWord = document.querySelector(".word-fuzzy");
const gamesWord = document.querySelector(".word-games");
const tagline = document.querySelector(".tagline");
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

const textureCanvas = document.createElement("canvas");
const textureContext = textureCanvas.getContext("2d", { alpha: true });

const palette = {
  background: [0.910, 0.890, 0.843],
  foreground: [0.086, 0.086, 0.078],
  midtone: [0.522, 0.502, 0.471],
};

const vertexSource = `#version 300 es
  layout(location = 0) in vec2 a_position;
  out vec2 v_uv;

  void main() {
    v_uv = a_position * 0.5 + 0.5;
    gl_Position = vec4(a_position, 0.0, 1.0);
  }
`;

const fragmentSource = `#version 300 es
  precision highp float;

  uniform sampler2D u_texture;
  uniform vec2 u_resolution;
  uniform vec2 u_pointer;
  uniform vec2 u_velocity;
  uniform float u_presence;
  uniform vec3 u_background;
  uniform vec3 u_foreground;
  uniform vec3 u_midtone;

  in vec2 v_uv;
  out vec4 out_color;

  float mask_at(vec2 uv) {
    return texture(u_texture, clamp(uv, vec2(0.0), vec2(1.0))).r;
  }

  vec2 aspect_vector() {
    return vec2(u_resolution.x / u_resolution.y, 1.0);
  }

  float hash21(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
  }

  vec3 background_color(vec2 uv) {
    float aspect = u_resolution.x / u_resolution.y;
    float vignette = 1.0 - smoothstep(0.18, 0.96, length((uv - 0.5) * vec2(aspect, 1.0)));
    float grain = (hash21(floor(gl_FragCoord.xy * 0.68)) - 0.5) * 0.007;
    return u_background + vec3(0.004 * vignette + grain);
  }

  vec3 soft_focus(vec2 uv, vec3 background) {
    vec2 aspect = aspect_vector();
    vec2 delta = (uv - u_pointer) * aspect;
    float radius = length(delta);
    float lens = pow(max(0.0, 1.0 - radius / 0.38), 2.0) * u_presence;
    vec2 sample_uv = u_pointer + (uv - u_pointer) * (1.0 - 0.28 * lens);
    sample_uv += vec2(delta.y, -delta.x) / aspect * lens * 0.016 * (u_pointer.y - 0.5);

    float face = mask_at(sample_uv);
    float original = mask_at(uv);
    float rim = abs(face - original);
    float ghost = mask_at(u_pointer + (uv - u_pointer) * (1.0 - 0.18 * lens)) * rim * 0.48;
    vec3 color = mix(background, u_midtone, clamp(ghost, 0.0, 1.0));
    return mix(color, u_foreground * (0.90 + 0.16 * lens), clamp(face, 0.0, 1.0));
  }

  vec3 local_fuzz(vec3 base, vec2 uv, vec3 background) {
    vec2 aspect = aspect_vector();
    vec2 delta = (uv - u_pointer) * aspect;
    float field = (1.0 - smoothstep(0.055, 0.21, length(delta))) * u_presence;
    if (field < 0.001) return base;

    vec2 motion = u_velocity * aspect;
    float speed = clamp(length(motion) * 0.24, 0.0, 1.0);
    vec2 direction = length(motion) > 0.002
      ? normalize(motion)
      : normalize(vec2(1.0, 0.35));
    vec2 normal = vec2(-direction.y, direction.x);
    float spread = 0.0042 + 0.0028 * speed;
    vec2 axis = direction / aspect * spread * (1.0 + 1.25 * speed);
    vec2 cross_axis = normal / aspect * spread * (0.92 - 0.18 * speed);
    vec2 diagonal_a = (axis + cross_axis) * 0.7071;
    vec2 diagonal_b = (axis - cross_axis) * 0.7071;

    float crisp = mask_at(uv);
    float soft = crisp * 0.24
      + (mask_at(uv + axis) + mask_at(uv - axis)
        + mask_at(uv + cross_axis) + mask_at(uv - cross_axis)) * 0.12
      + (mask_at(uv + diagonal_a) + mask_at(uv - diagonal_a)
        + mask_at(uv + diagonal_b) + mask_at(uv - diagonal_b)) * 0.07;
    float halo = max(soft - crisp, 0.0);

    vec3 fuzzy = mix(background, u_midtone, clamp(halo * 1.55, 0.0, 1.0));
    fuzzy = mix(fuzzy, u_foreground, clamp(soft * 0.94, 0.0, 1.0));
    return mix(base, fuzzy, field * 0.96);
  }

  void main() {
    vec3 background = background_color(v_uv);
    vec3 focused = soft_focus(v_uv, background);
    out_color = vec4(local_fuzz(focused, v_uv, background), 1.0);
  }
`;

const state = {
  gl: null,
  program: null,
  buffer: null,
  texture: null,
  uniforms: null,
  ready: false,
  raf: 0,
  resizeTimer: 0,
  releaseTimer: 0,
  lastFrameAt: performance.now(),
  pointer: { x: 0.5, y: 0.5 },
  target: { x: 0.5, y: 0.5 },
  velocity: { x: 0, y: 0 },
  presence: 0,
  presenceTarget: 0,
};

function compileShader(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

function createProgram(gl) {
  const vertex = compileShader(gl, gl.VERTEX_SHADER, vertexSource);
  const fragment = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
  if (!vertex || !fragment) {
    if (vertex) gl.deleteShader(vertex);
    if (fragment) gl.deleteShader(fragment);
    return null;
  }

  const program = gl.createProgram();
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    gl.deleteProgram(program);
    return null;
  }
  return program;
}

function drawElement(context, element) {
  const style = getComputedStyle(element);
  const rect = element.getBoundingClientRect();
  const fontSize = Number.parseFloat(style.fontSize);
  const tracking = Number.parseFloat(style.letterSpacing) || 0;
  const text = element.textContent.trim();

  context.font = `${style.fontStyle} ${style.fontWeight} ${fontSize}px ${style.fontFamily}`;
  context.fontKerning = "normal";
  context.textBaseline = "alphabetic";
  context.fillStyle = "#fff";
  if ("letterSpacing" in context) context.letterSpacing = `${tracking}px`;

  const metrics = context.measureText(text);
  const glyphHeight = metrics.actualBoundingBoxAscent + metrics.actualBoundingBoxDescent;
  const baseline = rect.top + (rect.height - glyphHeight) * 0.5 + metrics.actualBoundingBoxAscent;

  if ("letterSpacing" in context) {
    const startX = rect.left + (rect.width - metrics.width) * 0.5;
    context.fillText(text, startX, baseline);
    return;
  }

  const characters = Array.from(text);
  const trackedWidth = characters.reduce(
    (width, character) => width + context.measureText(character).width,
    tracking * Math.max(0, characters.length - 1),
  );
  const startX = rect.left + (rect.width - trackedWidth) * 0.5;
  let cursor = startX;
  for (const character of characters) {
    context.fillText(character, cursor, baseline);
    cursor += context.measureText(character).width + tracking;
  }
}

function uploadTexture() {
  const { gl } = state;
  if (!gl || !textureContext) return false;

  const width = window.innerWidth;
  const height = window.innerHeight;
  const mobile = width <= 900;
  const maxDpr = mobile ? 1.5 : 1.8;
  const pixelBudget = mobile ? 1_250_000 : 2_050_000;
  const maxTextureSize = Math.min(4096, gl.getParameter(gl.MAX_TEXTURE_SIZE));
  const dpr = Math.min(
    window.devicePixelRatio || 1,
    maxDpr,
    maxTextureSize / Math.max(width, height),
    Math.sqrt(pixelBudget / (width * height)),
  );
  if (!Number.isFinite(dpr) || dpr <= 0) return false;

  canvas.width = Math.max(1, Math.floor(width * dpr));
  canvas.height = Math.max(1, Math.floor(height * dpr));
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  gl.viewport(0, 0, canvas.width, canvas.height);

  textureCanvas.width = canvas.width;
  textureCanvas.height = canvas.height;
  textureContext.setTransform(dpr, 0, 0, dpr, 0, 0);
  textureContext.clearRect(0, 0, width, height);
  drawElement(textureContext, fuzzyWord);
  drawElement(textureContext, gamesWord);
  drawElement(textureContext, tagline);

  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, state.texture);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, textureCanvas);
  return gl.getError() === gl.NO_ERROR;
}

function setUniforms() {
  const { gl, uniforms } = state;
  gl.uniform2f(uniforms.resolution, canvas.width, canvas.height);
  gl.uniform2f(uniforms.pointer, state.pointer.x, state.pointer.y);
  gl.uniform2f(uniforms.velocity, state.velocity.x, state.velocity.y);
  gl.uniform1f(uniforms.presence, state.presence);
  gl.uniform3fv(uniforms.background, palette.background);
  gl.uniform3fv(uniforms.foreground, palette.foreground);
  gl.uniform3fv(uniforms.midtone, palette.midtone);
}

function draw() {
  const { gl } = state;
  gl.useProgram(state.program);
  setUniforms();
  gl.drawArrays(gl.TRIANGLES, 0, 3);
}

function scheduleFrame() {
  if (!state.ready || state.raf || document.hidden) return;
  state.raf = requestAnimationFrame(render);
}

function render(now) {
  state.raf = 0;
  if (!state.ready || document.hidden) return;

  const delta = Math.min(0.04, Math.max(0.001, (now - state.lastFrameAt) / 1000));
  state.lastFrameAt = now;
  const spring = 118;
  const damping = 21;
  state.velocity.x += (spring * (state.target.x - state.pointer.x) - damping * state.velocity.x) * delta;
  state.velocity.y += (spring * (state.target.y - state.pointer.y) - damping * state.velocity.y) * delta;
  state.pointer.x += state.velocity.x * delta;
  state.pointer.y += state.velocity.y * delta;

  const presenceEase = 1 - Math.exp(-delta / (state.presenceTarget ? 0.16 : 0.28));
  state.presence += (state.presenceTarget - state.presence) * presenceEase;
  if (Math.abs(state.presenceTarget - state.presence) < 0.0005) state.presence = state.presenceTarget;
  if (
    Math.hypot(state.target.x - state.pointer.x, state.target.y - state.pointer.y) < 0.00005
    && Math.hypot(state.velocity.x, state.velocity.y) < 0.00005
  ) {
    state.pointer.x = state.target.x;
    state.pointer.y = state.target.y;
    state.velocity.x = 0;
    state.velocity.y = 0;
  }

  draw();
  if (
    state.presence !== state.presenceTarget
    || state.pointer.x !== state.target.x
    || state.pointer.y !== state.target.y
  ) scheduleFrame();
}

function clearPresence() {
  window.clearTimeout(state.releaseTimer);
  state.presenceTarget = 0;
  scheduleFrame();
}

function releaseTouchSoon() {
  window.clearTimeout(state.releaseTimer);
  state.releaseTimer = window.setTimeout(clearPresence, 1250);
}

function updatePointer(event) {
  if (!state.ready) return;
  const entering = state.presenceTarget === 0;
  state.target.x = event.clientX / window.innerWidth;
  state.target.y = 1 - event.clientY / window.innerHeight;
  if (entering) {
    state.pointer.x = state.target.x;
    state.pointer.y = state.target.y;
    state.velocity.x = 0;
    state.velocity.y = 0;
  }
  state.presenceTarget = 1;
  if (event.pointerType === "touch") releaseTouchSoon();
  else window.clearTimeout(state.releaseTimer);
  scheduleFrame();
}

function onPointerRelease(event) {
  if (event.type === "pointercancel") clearPresence();
  else if (event.pointerType !== "mouse") releaseTouchSoon();
}

function queueResize() {
  window.clearTimeout(state.resizeTimer);
  state.resizeTimer = window.setTimeout(() => {
    if (!state.ready) return;
    if (!uploadTexture()) {
      useFallback();
      return;
    }
    draw();
  }, 120);
}

function disposeWebGLResources() {
  const { gl } = state;
  if (gl && !gl.isContextLost()) {
    if (state.buffer) gl.deleteBuffer(state.buffer);
    if (state.texture) gl.deleteTexture(state.texture);
    if (state.program) gl.deleteProgram(state.program);
  }
  state.gl = null;
  state.program = null;
  state.buffer = null;
  state.texture = null;
  state.uniforms = null;
}

function useFallback(status = "fallback") {
  cancelAnimationFrame(state.raf);
  state.raf = 0;
  state.ready = false;
  disposeWebGLResources();
  root.classList.remove("webgl-ready");
  root.dataset.webglState = status;
}

function initWebGL() {
  if (reducedMotion.matches) {
    useFallback("disabled");
    return;
  }

  disposeWebGLResources();
  root.dataset.webglState = "loading";
  const gl = canvas.getContext("webgl2", {
    alpha: false,
    antialias: false,
    depth: false,
    stencil: false,
    powerPreference: "high-performance",
  });
  if (!gl) {
    useFallback();
    return;
  }

  const program = createProgram(gl);
  if (!program) {
    useFallback();
    return;
  }

  state.gl = gl;
  state.program = program;
  state.texture = gl.createTexture();
  state.uniforms = {
    resolution: gl.getUniformLocation(program, "u_resolution"),
    pointer: gl.getUniformLocation(program, "u_pointer"),
    velocity: gl.getUniformLocation(program, "u_velocity"),
    presence: gl.getUniformLocation(program, "u_presence"),
    background: gl.getUniformLocation(program, "u_background"),
    foreground: gl.getUniformLocation(program, "u_foreground"),
    midtone: gl.getUniformLocation(program, "u_midtone"),
  };

  gl.useProgram(program);
  gl.uniform1i(gl.getUniformLocation(program, "u_texture"), 0);
  const position = gl.createBuffer();
  state.buffer = position;
  gl.bindBuffer(gl.ARRAY_BUFFER, position);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

  if (!uploadTexture()) {
    useFallback();
    return;
  }

  state.ready = true;
  state.lastFrameAt = performance.now();
  draw();
  root.dataset.webglState = "ready";
  root.classList.add("webgl-ready");
}

function onMotionPreferenceChange() {
  useFallback(reducedMotion.matches ? "disabled" : "loading");
  if (!reducedMotion.matches) requestAnimationFrame(initWebGL);
}

canvas.addEventListener("webglcontextlost", (event) => {
  event.preventDefault();
  useFallback();
});
canvas.addEventListener("webglcontextrestored", () => requestAnimationFrame(initWebGL));
window.addEventListener("pointermove", updatePointer, { passive: true });
window.addEventListener("pointerdown", updatePointer, { passive: true });
window.addEventListener("pointerup", onPointerRelease, { passive: true });
window.addEventListener("pointercancel", onPointerRelease, { passive: true });
document.documentElement.addEventListener("pointerleave", clearPresence, { passive: true });
window.addEventListener("blur", clearPresence);
window.addEventListener("resize", queueResize, { passive: true });
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    cancelAnimationFrame(state.raf);
    state.raf = 0;
  } else {
    state.lastFrameAt = performance.now();
    scheduleFrame();
  }
});
window.addEventListener("pagehide", () => {
  cancelAnimationFrame(state.raf);
  window.clearTimeout(state.resizeTimer);
  window.clearTimeout(state.releaseTimer);
  state.raf = 0;
});
window.addEventListener("pageshow", (event) => {
  if (event.persisted && state.ready) {
    state.lastFrameAt = performance.now();
    scheduleFrame();
  }
});
reducedMotion.addEventListener("change", onMotionPreferenceChange);

requestAnimationFrame(() => requestAnimationFrame(initWebGL));
