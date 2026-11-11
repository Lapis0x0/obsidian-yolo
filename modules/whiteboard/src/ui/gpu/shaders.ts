// The GPU scene's (./scene.ts) programs. Everything is drawn in device
// pixels from the camera (`cam`: tx, ty in CSS pixels, scale, device pixel
// ratio), each instance reading its card's box and depth from the card table
// (`cards`, CARD_TEXELS texels a slot) so that moving a card moves its
// content without touching the instances. A card in motion is shown scaled
// from its top-left and faded (its fourth texel's z and w): every point of it
// is placed at its box's corner plus its own offset times the scale, and
// whatever it draws is multiplied by the alpha. A card picked up is turned
// about its centre as well (its fifth texel's x), and its frame casts a
// shadow as far as it is picked up (its y): the frame's quad reaches out to
// take the shadow in, drawn outside the card under its edge.
//
// Depth is what keeps cards in their order whatever order they are drawn
// in: a card's frame and its content each have their own depth, the content
// just in front of its own frame and behind every card above it. A frame
// whose fill is opaque writes depth where it covers whole pixels (`INTERIOR`
// pass); its edges and border are drawn after the content (`EDGE` pass), as
// anything translucent has to be.

import { LIFT_SHADOW } from '../constants'

/** Texels of the card table a slot takes, and slots a row of it holds. */
export const CARD_TEXELS = 5
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
// \`v\` turned by the card's turn (\`turn.x\`, radians).
vec2 turned(vec4 turn, vec2 v) {
  if (turn.x == 0.0) return v;
  float c = cos(turn.x);
  float s = sin(turn.x);
  return vec2(c * v.x - s * v.y, s * v.x + c * v.y);
}
// Where a point of a card, \`p\` from its top-left in its own units, is on
// the board: scaled by its look, and turned about the centre it is shown at.
vec2 place(vec4 box, vec4 view, vec4 turn, vec2 p) {
  vec2 half_ = box.zw * view.z * 0.5;
  return box.xy + half_ + turned(turn, p * view.z - half_);
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
flat out vec2 vLook;
flat out float vLift;
vec4 unpack(uint c) {
  return vec4(float(c & 255u), float((c >> 8) & 255u), float((c >> 16) & 255u), float(c >> 24)) / 255.0;
}
void main() {
  uint slot = uint(gl_InstanceID);
  vec4 box = cardTexel(slot, 0);
  vec4 depth = cardTexel(slot, 1);
  vec4 more = cardTexel(slot, 2);
  vec4 view = cardTexel(slot, 3);
  vec4 turn = cardTexel(slot, 4);
  uvec4 c = texelFetch(colors, ivec2(int(slot % ${SLOTS_PER_ROW}u), int(slot / ${SLOTS_PER_ROW}u)), 0);
  // Not drawn, or nothing to draw: a card whose frame the overview draws.
  if (box.z <= 0.0 || more.y == 0.0 || (c.x >> 24) + (c.y >> 24) == 0u) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  // One device pixel out on every side, for the edge's antialiasing.
  float grow = 1.0 / (cam.z * cam.w * view.z);
  // Picked up, out as far as its shadow reaches.
  if (turn.y > 0.0) grow = max(grow, ${LIFT_SHADOW.offsetY + LIFT_SHADOW.blur}.0);
  vec2 local = mix(vec2(-grow), box.zw + grow, corner);
  vLocal = local;
  vBox = vec4(box.zw, depth.w, more.x);
  vFill = unpack(c.x);
  vBorder = unpack(c.y);
  vLook = view.zw;
  vLift = turn.y;
  gl_Position = vec4(toClip(toDevice(place(box, view, turn, local))), depth.x * 2.0 - 1.0, 1.0);
}`

export const FRAME_FS = `#version 300 es
precision highp float;
uniform vec4 cam;
uniform float edgePass;
in vec2 vLocal;
flat in vec4 vBox;
flat in vec4 vFill;
flat in vec4 vBorder;
flat in vec2 vLook;
flat in float vLift;
out vec4 o;
${ROUND_BOX}
// What a card picked up casts under it, outside it (drag.css's shadow): its
// box moved down and blurred — a box's edge blurred being near enough a
// smoothstep across two deviations either side — in the card's own units.
float shadow(vec2 local, vec2 half_, float radius, float covered) {
  if (vLift <= 0.0) return 0.0;
  float sigma = ${LIFT_SHADOW.blur / 2}.0;
  float d = roundBox(local - half_ - vec2(0.0, ${LIFT_SHADOW.offsetY}.0), half_, radius);
  return ${LIFT_SHADOW.alpha} * vLift * vLook.y * (1.0 - smoothstep(-2.0 * sigma, 2.0 * sigma, d)) * (1.0 - covered);
}
void main() {
  float k = cam.z * cam.w * vLook.x;
  vec2 half_ = vBox.xy * 0.5;
  float d = roundBox((vLocal - half_) * k, half_ * k, vBox.z * k);
  float outer = clamp(0.5 - d, 0.0, 1.0);
  // Its width in world units near to, and never under that many CSS
  // pixels far away: the overview's line, which does not shrink with zoom.
  float width = max(vBox.w * k, vBox.w * cam.w);
  float inner = clamp(0.5 - (d + width), 0.0, 1.0);
  vec4 fill = vec4(vFill.rgb * vFill.a, vFill.a) * vLook.y;
  vec4 border = vec4(vBorder.rgb * vBorder.a, vBorder.a) * vLook.y;
  // Fading, it hides nothing under it.
  bool opaque = vFill.a >= 1.0 && vLook.y >= 1.0;
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
  res += vec4(0.0, 0.0, 0.0, shadow(vLocal, half_, vBox.z, outer)) * (1.0 - res.a);
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
flat out float vTop;
flat out vec4 vFill;
flat out vec4 vBorder;
flat out vec2 vLook;
void main() {
  vec4 box = cardTexel(slot, 0);
  vec4 depth = cardTexel(slot, 1);
  vec4 more = cardTexel(slot, 2);
  vec4 view = cardTexel(slot, 3);
  vec4 turn = cardTexel(slot, 4);
  if (more.y == 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  float grow = 1.0 / (cam.z * cam.w * view.z);
  vec2 local = mix(rect.xy - grow, rect.xy + rect.zw + grow, corner);
  vLocal = local - rect.xy;
  // Where it shows in the card: moved up by the card's scroll.
  vCard = local - vec2(0.0, view.x);
  vRect = vec4(rect.zw, shape);
  vClip = vec4(box.z - more.w, box.w, depth.z, more.z);
  vTop = view.y;
  vFill = fill;
  vBorder = border;
  vLook = view.zw;
  gl_Position = vec4(toClip(toDevice(place(box, view, turn, vCard))), depth.y * 2.0 - 1.0, 1.0);
}`

const CLIP = /* glsl */ `
float clipped(vec2 card, vec4 clip, float top) {
  if (card.x < clip.w || card.y < top || card.x > clip.x || card.y > clip.y) return 0.0;
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
flat in float vTop;
flat in vec4 vFill;
flat in vec4 vBorder;
flat in vec2 vLook;
out vec4 o;
${ROUND_BOX}
${CLIP}
void main() {
  float k = cam.z * cam.w * vLook.x;
  vec2 half_ = vRect.xy * 0.5;
  float d = roundBox((vLocal - half_) * k, half_ * k, min(vRect.z, min(half_.x, half_.y)) * k);
  float outer = clamp(0.5 - d, 0.0, 1.0);
  float inner = vRect.w > 0.0 ? clamp(0.5 - (d + vRect.w * k), 0.0, 1.0) : outer;
  vec4 fill = vec4(vFill.rgb * vFill.a, vFill.a);
  vec4 border = vec4(vBorder.rgb * vBorder.a, vBorder.a);
  vec4 res = (border + fill * (1.0 - border.a)) * (outer - inner) + fill * inner;
  res *= clipped(vCard, vClip, vTop) * vLook.y;
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
flat out float vTop;
flat out vec4 vColor;
flat out float vOwnColors;
flat out float vAlpha;
void main() {
  vec4 box = cardTexel(slot, 0);
  vec4 depth = cardTexel(slot, 1);
  vec4 more = cardTexel(slot, 2);
  vec4 view = cardTexel(slot, 3);
  vec4 turn = cardTexel(slot, 4);
  ivec2 at = ivec2(int(glyph % 1024u) * ${LOOKUP_TEXELS}, int(glyph / 1024u));
  vec4 l0 = texelFetch(lookup, at, 0);
  vec4 l1 = texelFetch(lookup, at + ivec2(1, 0), 0);
  if (l1.z == 0.0 || more.y == 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  float ratio = cam.z * cam.w * view.z / l1.z;
  // Moved up by the card's scroll, before it is put on whole pixels.
  vec2 shown = origin - vec2(0.0, view.x);
  vec2 o = toDevice(place(box, view, turn, shown));
  // Drawn at the size it shows: on whole pixels, as the DOM sets text —
  // unless it is turned, when no pixel is whole.
  if (snap > 0.5 && abs(ratio - 1.0) < 0.001 && turn.x == 0.0) o = floor(o + 0.5);
  vec2 offset = l1.xy + corner * l0.zw;
  gl_Position = vec4(toClip(o + turned(turn, offset * ratio)), depth.y * 2.0 - 1.0, 1.0);
  float page = mod(l1.w, 16.0);
  vUV = vec3((l0.xy + corner * l0.zw) / pageSize, page);
  vCard = shown + offset / l1.z;
  vClip = vec4(box.z - more.w, box.w, depth.z, more.z);
  vTop = view.y;
  vColor = color;
  vOwnColors = l1.w >= 16.0 ? 1.0 : 0.0;
  vAlpha = view.w;
}`

export const GLYPH_FS = `#version 300 es
precision highp float;
precision highp sampler2DArray;
uniform sampler2DArray pages;
in vec3 vUV;
in vec2 vCard;
flat in vec4 vClip;
flat in float vTop;
flat in vec4 vColor;
flat in float vOwnColors;
flat in float vAlpha;
out vec4 o;
${CLIP}
void main() {
  float keep = clipped(vCard, vClip, vTop) * vAlpha;
  vec4 t = texture(pages, vUV);
  if (vOwnColors > 0.5) { o = t * keep; }
  else { float a = t.a * vColor.a * keep; o = vec4(vColor.rgb * a, a); }
  if (o.a <= 0.0) discard;
}`

/** An image in a card: one quad, its picture a texture of its own. */
export const IMAGE_VS = `${HEAD}${CARD_FETCH}
layout(location = 0) in vec2 corner;
uniform highp uint slot;
uniform vec4 rect;
out vec2 vUV;
out vec2 vCard;
out vec2 vShown;
flat out vec4 vClip;
flat out float vTop;
flat out float vAlpha;
void main() {
  vec4 box = cardTexel(slot, 0);
  vec4 depth = cardTexel(slot, 1);
  vec4 more = cardTexel(slot, 2);
  vec4 view = cardTexel(slot, 3);
  vec4 turn = cardTexel(slot, 4);
  vec2 local = rect.xy + corner * rect.zw;
  vUV = corner;
  vCard = local;
  // Where it shows in the card: moved up by the card's scroll.
  vShown = local - vec2(0.0, view.x);
  vClip = vec4(box.z - more.w, box.w, depth.z, more.z);
  vTop = view.y;
  vAlpha = view.w;
  gl_Position = vec4(toClip(toDevice(place(box, view, turn, vShown))), depth.y * 2.0 - 1.0, 1.0);
}`

export const IMAGE_FS = `#version 300 es
precision highp float;
uniform sampler2D picture;
uniform vec4 rect;
uniform float radius;
in vec2 vUV;
in vec2 vCard;
in vec2 vShown;
flat in vec4 vClip;
flat in float vTop;
flat in float vAlpha;
out vec4 o;
${CLIP}
void main() {
  // Its rounded corners, antialiased over a device pixel.
  vec2 half_ = rect.zw * 0.5;
  vec2 q = abs(vCard - rect.xy - half_) - half_ + radius;
  float d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - radius;
  float corner = radius > 0.0 ? clamp(0.5 - d / max(fwidth(d), 1e-4), 0.0, 1.0) : 1.0;
  o = texture(picture, vUV) * clipped(vShown, vClip, vTop) * corner * vAlpha;
  if (o.a <= 0.0) discard;
}`
