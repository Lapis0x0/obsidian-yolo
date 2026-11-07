/// <reference lib="webworker" />

// MathJax as Obsidian runs it in notes — the same version (4.1.3), the same
// TeX packages and the same `mathjax-tex` font — with SVG output instead of
// CHTML, and no DOM: the output tree (MathJax's lite DOM) is read into
// shapes (./layout.ts) and those are what leave the worker.
//
// Obsidian loads `require` and `autoload` as well, to fetch a package when
// a formula first uses it; with no loader here every package it lists is
// in from the start, which is the same set.

import { MathJaxTexFont } from '@mathjax/mathjax-tex-font/mjs/svg.js'
import { liteAdaptor } from '@mathjax/src/mjs/adaptors/liteAdaptor.js'
import { RegisterHTMLHandler } from '@mathjax/src/mjs/handlers/html.js'
import { TeX } from '@mathjax/src/mjs/input/tex.js'
import '@mathjax/src/mjs/input/tex/action/ActionConfiguration.js'
import '@mathjax/src/mjs/input/tex/ams/AmsConfiguration.js'
import '@mathjax/src/mjs/input/tex/amscd/AmsCdConfiguration.js'
import '@mathjax/src/mjs/input/tex/base/BaseConfiguration.js'
import '@mathjax/src/mjs/input/tex/bbox/BboxConfiguration.js'
import '@mathjax/src/mjs/input/tex/boldsymbol/BoldsymbolConfiguration.js'
import '@mathjax/src/mjs/input/tex/braket/BraketConfiguration.js'
import '@mathjax/src/mjs/input/tex/bussproofs/BussproofsConfiguration.js'
import '@mathjax/src/mjs/input/tex/cancel/CancelConfiguration.js'
import '@mathjax/src/mjs/input/tex/cases/CasesConfiguration.js'
import '@mathjax/src/mjs/input/tex/centernot/CenternotConfiguration.js'
import '@mathjax/src/mjs/input/tex/color/ColorConfiguration.js'
import '@mathjax/src/mjs/input/tex/colortbl/ColortblConfiguration.js'
import '@mathjax/src/mjs/input/tex/configmacros/ConfigMacrosConfiguration.js'
import '@mathjax/src/mjs/input/tex/empheq/EmpheqConfiguration.js'
import '@mathjax/src/mjs/input/tex/enclose/EncloseConfiguration.js'
import '@mathjax/src/mjs/input/tex/extpfeil/ExtpfeilConfiguration.js'
import '@mathjax/src/mjs/input/tex/gensymb/GensymbConfiguration.js'
import '@mathjax/src/mjs/input/tex/html/HtmlConfiguration.js'
import '@mathjax/src/mjs/input/tex/mathtools/MathtoolsConfiguration.js'
import '@mathjax/src/mjs/input/tex/mhchem/MhchemConfiguration.js'
import '@mathjax/src/mjs/input/tex/newcommand/NewcommandConfiguration.js'
import '@mathjax/src/mjs/input/tex/noerrors/NoErrorsConfiguration.js'
import '@mathjax/src/mjs/input/tex/noundefined/NoUndefinedConfiguration.js'
import '@mathjax/src/mjs/input/tex/tagformat/TagFormatConfiguration.js'
import '@mathjax/src/mjs/input/tex/textcomp/TextcompConfiguration.js'
import '@mathjax/src/mjs/input/tex/textmacros/TextMacrosConfiguration.js'
import '@mathjax/src/mjs/input/tex/unicode/UnicodeConfiguration.js'
import '@mathjax/src/mjs/input/tex/upgreek/UpgreekConfiguration.js'
import '@mathjax/src/mjs/input/tex/verb/VerbConfiguration.js'
import { mathjax } from '@mathjax/src/mjs/mathjax.js'
import { SVG } from '@mathjax/src/mjs/output/svg.js'

import type {
  MathLayout,
  MathRequest,
} from '../../../src/core/runtime-components/contracts'

import { readLayout } from './layout'

declare const self: DedicatedWorkerGlobalScope

/** Obsidian's `MathJax.config.tex.packages`, less `require` and
 * `autoload`. */
const PACKAGES = [
  'base',
  'ams',
  'newcommand',
  'textmacros',
  'noundefined',
  'configmacros',
  'action',
  'amscd',
  'bbox',
  'boldsymbol',
  'braket',
  'bussproofs',
  'cancel',
  'cases',
  'centernot',
  'color',
  'colortbl',
  'empheq',
  'enclose',
  'extpfeil',
  'gensymb',
  'html',
  'mathtools',
  'mhchem',
  'noerrors',
  'tagformat',
  'textcomp',
  'unicode',
  'upgreek',
  'verb',
]

const adaptor = liteAdaptor()
RegisterHTMLHandler(adaptor)
const document = mathjax.document('', {
  InputJax: new TeX({ packages: PACKAGES }),
  // Each glyph its own path, not a `<use>` of one defined elsewhere.
  OutputJax: new SVG({ fontData: MathJaxTexFont, fontCache: 'none' }),
})

export type MathWorkerRequest = Readonly<{
  id: number
  requests: readonly MathRequest[]
}>

export type MathWorkerResponse = Readonly<{
  id: number
  layouts: readonly (MathLayout | null)[]
}>

self.onmessage = (event: MessageEvent<MathWorkerRequest>) => {
  const { id, requests } = event.data
  const layouts = requests.map(({ tex, display }) => {
    try {
      return readLayout(adaptor, document.convert(tex, { display }))
    } catch {
      return null
    }
  })
  self.postMessage({ id, layouts } satisfies MathWorkerResponse)
}
