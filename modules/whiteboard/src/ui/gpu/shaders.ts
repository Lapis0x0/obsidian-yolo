// The GPU scene's (./scene.ts) programs. Everything is drawn in device
// pixels from the camera (`cam`: tx, ty in CSS pixels, scale, device pixel
// ratio), each instance reading its card's box and depth from the card table
// (`cards`, CARD_TEXELS texels a slot) so that moving a card moves its
// content without touching the instances.
//
// Depth is what keeps cards in their order whatever order they are drawn
// in: a card's frame and its content each have their own depth, the content
// just in front of its own frame and behind every card above it. A frame
// whose fill is opaque writes depth where it covers whole pixels (`INTERIOR`
// pass); its edges and border are drawn after the content (`EDGE` pass), as
// anything translucent has to be.

/** Texels of the card table a slot takes, and slots a row of it holds. */
export const CARD_TEXELS = 3
export const SLOTS_PER_ROW = 512
export const LOOKUP_TEXELS = 2

const CARD_FETCH = /* glsl */ `
uniform highp sampler2D cards;
vec4 cardTexel(uint slot, int i) {
  return texelFetch(cards, ivec2(int(slot % ${SLOTS_PER_ROW}u) * ${CARD_TEXELS} + i, int(slot / ${SLOTS_PER_ROW}u)), 0);
}
vec2 toClip(vec2 device) {
  vec2 c = device / (viewport * cam.w) * 2.0 - 1.0;
  return vec2(c.x, -c.y);
}
vec2 toDevice(vec2 world) {
  return (world * cam.z + cam.xy) * cam.w;
}
`

const HEAD = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
uniform vec4 cam;
uniform vec2 viewport;
`

/** A rounded box's signed distance, `p` from its centre. */
const ROUND_BOX = /* glsl */ `
float roundBox(vec2 p, vec2 half_, float r) {
  vec2 q = abs(p) - half_ + r;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}
`

/** The card's frame: its fill and border, one instance a slot. */
export const FRAME_VS = `${HEAD}${CARD_FETCH}
layout(location = 0) in vec2 corner;
uniform highp usampler2D colors;
out vec2 vLocal;
flat out vec4 vBox;
flat out vec4 vFill;
flat out vec4 vBorder;
vec4 unpack(uint c) {
  return vec4(float(c & 255u), float((c >> 8) & 255u), float((c >> 16) & 255u), float(c >> 24)) / 255.0;
}
void main() {
  uint slot = uint(gl_InstanceID);
  vec4 box = cardTexel(slot, 0);
  vec4 depth = cardTexel(slot, 1);
  vec4 more = cardTexel(slot, 2);
  uvec4 c = texelFetch(colors, ivec2(int(slot % ${SLOTS_PER_ROW}u), int(slot / ${SLOTS_PER_ROW}u)), 0);
  // Not drawn, or nothing to draw: a card whose frame the overview draws.
  if (box.z <= 0.0 || more.y == 0.0 || (c.x >> 24) + (c.y >> 24) == 0u) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  // One device pixel out on every side, for the edge's antialiasing.
  float grow = 1.0 / (cam.z * cam.w);
  vec2 local = mix(vec2(-grow), box.zw + grow, corner);
  vLocal = local;
  vBox = vec4(box.zw, depth.w, more.x);
  vFill = unpack(c.x);
  vBorder = unpack(c.y);
  gl_Position = vec4(toClip(toDevice(box.xy + local)), depth.x * 2.0 - 1.0, 1.0);
}`

export const FRAME_FS = `#version 300 es
precision highp float;
uniform vec4 cam;
uniform float edgePass;
in vec2 vLocal;
flat in vec4 vBox;
flat in vec4 vFill;
flat in vec4 vBorder;
out vec4 o;
${ROUND_BOX}
void main() {
  float k = cam.z * cam.w;
  vec2 half_ = vBox.xy * 0.5;
  float d = roundBox((vLocal - half_) * k, half_ * k, vBox.z * k);
  float outer = clamp(0.5 - d, 0.0, 1.0);
  float inner = clamp(0.5 - (d + vBox.w * k), 0.0, 1.0);
  vec4 fill = vec4(vFill.rgb * vFill.a, vFill.a);
  vec4 border = vec4(vBorder.rgb * vBorder.a, vBorder.a);
  bool opaque = vFill.a >= 1.0;
  if (edgePass < 0.5) {
    // Whole pixels of an opaque fill: the depth that hides what is under.
    if (!opaque || outer < 1.0) discard;
    o = fill;
    return;
  }
  if (opaque && outer >= 1.0 && inner >= 1.0) discard;
  vec4 band = border + fill * (1.0 - border.a);
  vec4 res = opaque && outer >= 1.0 ? band * (1.0 - inner) + fill * inner
                                    : band * (outer - inner) + fill * inner;
  if (res.a <= 0.0) discard;
  o = res;
}`

/** A rectangle of a card's content. */
export const RECT_VS = `${HEAD}${CARD_FETCH}
layout(location = 0) in vec2 corner;
layout(location = 1) in uint slot;
layout(location = 2) in vec4 rect;
layout(location = 3) in vec2 shape;
layout(location = 4) in vec4 fill;
layout(location = 5) in vec4 border;
out vec2 vLocal;
out vec2 vCard;
flat out vec4 vRect;
flat out vec4 vClip;
flat out vec4 vFill;
flat out vec4 vBorder;
void main() {
  vec4 box = cardTexel(slot, 0);
  vec4 depth = cardTexel(slot, 1);
  vec4 more = cardTexel(slot, 2);
  if (more.y == 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  float grow = 1.0 / (cam.z * cam.w);
  vec2 local = mix(rect.xy - grow, rect.xy + rect.zw + grow, corner);
  vLocal = local - rect.xy;
  vCard = local;
  vRect = vec4(rect.zw, shape);
  vClip = vec4(box.zw, depth.z, 0.0);
  vFill = fill;
  vBorder = border;
  gl_Position = vec4(toClip(toDevice(box.xy + local)), depth.y * 2.0 - 1.0, 1.0);
}`

const CLIP = /* glsl */ `
float clipped(vec2 card, vec4 clip) {
  if (card.x < 0.0 || card.y < 0.0 || card.x > clip.x || card.y > clip.y) return 0.0;
  return clip.z > 0.0 ? clamp((clip.y - card.y) / clip.z, 0.0, 1.0) : 1.0;
}
`

export const RECT_FS = `#version 300 es
precision highp float;
uniform vec4 cam;
in vec2 vLocal;
in vec2 vCard;
flat in vec4 vRect;
flat in vec4 vClip;
flat in vec4 vFill;
flat in vec4 vBorder;
out vec4 o;
${ROUND_BOX}
${CLIP}
void main() {
  float k = cam.z * cam.w;
  vec2 half_ = vRect.xy * 0.5;
  float d = roundBox((vLocal - half_) * k, half_ * k, min(vRect.z, min(half_.x, half_.y)) * k);
  float outer = clamp(0.5 - d, 0.0, 1.0);
  float inner = vRect.w > 0.0 ? clamp(0.5 - (d + vRect.w * k), 0.0, 1.0) : outer;
  vec4 fill = vec4(vFill.rgb * vFill.a, vFill.a);
  vec4 border = vec4(vBorder.rgb * vBorder.a, vBorder.a);
  vec4 res = (border + fill * (1.0 - border.a)) * (outer - inner) + fill * inner;
  res *= clipped(vCard, vClip);
  if (res.a <= 0.0) discard;
  o = res;
}`

/** A glyph, its picture from the atlas, placed by its lookup. */
export const GLYPH_VS = `${HEAD}${CARD_FETCH}
layout(location = 0) in vec2 corner;
layout(location = 1) in uint slot;
layout(location = 2) in vec2 origin;
layout(location = 3) in uint glyph;
layout(location = 4) in vec4 color;
uniform highp sampler2D lookup;
uniform float snap;
uniform float pageSize;
out vec3 vUV;
out vec2 vCard;
flat out vec4 vClip;
flat out vec4 vColor;
flat out float vOwnColors;
void main() {
  vec4 box = cardTexel(slot, 0);
  vec4 depth = cardTexel(slot, 1);
  vec4 more = cardTexel(slot, 2);
  ivec2 at = ivec2(int(glyph % 1024u) * ${LOOKUP_TEXELS}, int(glyph / 1024u));
  vec4 l0 = texelFetch(lookup, at, 0);
  vec4 l1 = texelFetch(lookup, at + ivec2(1, 0), 0);
  if (l1.z == 0.0 || more.y == 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  float ratio = cam.z * cam.w / l1.z;
  vec2 o = toDevice(box.xy + origin);
  // Drawn at the size it shows: on whole pixels, as the DOM sets text.
  if (snap > 0.5 && abs(ratio - 1.0) < 0.001) o = floor(o + 0.5);
  vec2 offset = l1.xy + corner * l0.zw;
  gl_Position = vec4(toClip(o + offset * ratio), depth.y * 2.0 - 1.0, 1.0);
  float page = mod(l1.w, 16.0);
  vUV = vec3((l0.xy + corner * l0.zw) / pageSize, page);
  vCard = origin + offset / l1.z;
  vClip = vec4(box.zw, depth.z, 0.0);
  vColor = color;
  vOwnColors = l1.w >= 16.0 ? 1.0 : 0.0;
}`

export const GLYPH_FS = `#version 300 es
precision highp float;
precision highp sampler2DArray;
uniform sampler2DArray pages;
in vec3 vUV;
in vec2 vCard;
flat in vec4 vClip;
flat in vec4 vColor;
flat in float vOwnColors;
out vec4 o;
${CLIP}
void main() {
  float keep = clipped(vCard, vClip);
  vec4 t = texture(pages, vUV);
  if (vOwnColors > 0.5) { o = t * keep; }
  else { float a = t.a * vColor.a * keep; o = vec4(vColor.rgb * a, a); }
  if (o.a <= 0.0) discard;
}`
