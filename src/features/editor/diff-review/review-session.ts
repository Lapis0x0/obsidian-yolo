import type { TFile, Vault } from 'obsidian'

import type { DiffBlock } from '../../../utils/chat/diff'
import {
  countModifiedBlocks,
  generateReviewContent,
  type ReviewDecision,
} from './review-model'

type ReviewSessionOptions = {
  file: TFile
  vault: Vault
  blocks: DiffBlock[]
}

export class ReviewSession {
  private readonly file: TFile
  private readonly vault: Vault
  private readonly blocks: DiffBlock[]
  private readonly decisions = new Map<number, ReviewDecision>()
  private persistInFlight = false

  constructor(options: ReviewSessionOptions) {
    this.file = options.file
    this.vault = options.vault
    this.blocks = options.blocks
  }

  getDecision(index: number): ReviewDecision | undefined {
    return this.decisions.get(index)
  }

  getDecisions(): ReadonlyMap<number, ReviewDecision> {
    return this.decisions
  }

  setDecision(index: number, decision: ReviewDecision): void {
    this.decisions.set(index, decision)
  }

  clearDecision(index: number): void {
    this.decisions.delete(index)
  }

  getFinalContent(defaultDecision: 'incoming' | 'current' = 'current'): string {
    return generateReviewContent(this.blocks, this.decisions, defaultDecision)
  }

  areAllModifiedBlocksDecided(): boolean {
    const modifiedCount = countModifiedBlocks(this.blocks)
    if (modifiedCount === 0) return false

    return this.blocks.every((block, index) => {
      if (block.type !== 'modified') return true
      const decision = this.decisions.get(index)
      return !!decision && decision !== 'pending'
    })
  }

  async persist(finalContent?: string): Promise<void> {
    if (this.persistInFlight) return
    this.persistInFlight = true
    try {
      await this.vault.modify(
        this.file,
        finalContent ?? this.getFinalContent('current'),
      )
    } finally {
      this.persistInFlight = false
    }
  }
}
