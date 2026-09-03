// The two tools' JSON Schemas and descriptions, kept apart from the handlers
// so neither file has to be read to understand the other.
//
// These strings are the model's entire documentation for a whiteboard, and
// they are written for a reader who has just loaded them on demand and has
// never seen a board before. Two things they deliberately do *not* do:
//
//   - describe the file format. A model that knows a board is JSON will reach
//     for `fs_edit`, which is exactly what is blocked. Cards, connections and
//     groups are the vocabulary; JSON never appears.
//   - offer more than one way to do anything. There is no `disconnect` (an id
//     says what it is, so `delete` covers it), no `ungroup` (a group is a
//     card, so deleting it dissolves it), and no layout language beyond
//     `arrange` and plain coordinates.
//
// Not localized: they are read by a model, not by the user.

import { ARRANGE_ACTIONS, COLOR_NAME_LIST } from '../domain/edit'

const COLORS = `${COLOR_NAME_LIST.join(', ')}, or a hex colour like "#7852ee"`

const pathProperty = {
  type: 'string',
  description: 'Vault-relative path of the board, ending in .yoloboard.',
} as const

const createItem = {
  type: 'object',
  description:
    'A new card. Give exactly one of text, file or url — that is what decides the kind of card.',
  properties: {
    text: {
      type: 'string',
      description:
        'Markdown written on the card itself. The default kind of card, and the right one for a thought that belongs to this board.',
    },
    file: {
      type: 'string',
      description:
        'Vault path of an existing note or image to show on the card. Use this to put a note that already exists on the board — it does not create the file.',
    },
    url: { type: 'string', description: 'A web page to embed on the card.' },
    x: {
      type: 'number',
      description:
        'Left edge, in board coordinates (the summary gives every card its own). Omit x and y together to have the card placed automatically; giving one without the other is an error.',
    },
    y: { type: 'number', description: 'Top edge. See x.' },
    w: { type: 'number', description: 'Width. Omit for the default size.' },
    h: { type: 'number', description: 'Height. Omit for the default size.' },
    color: { type: 'string', description: `One of ${COLORS}.` },
    anchor: {
      type: 'string',
      description:
        'Id of a card to place this one beside. Only used when x and y are omitted. Defaults to the card created just before it in this call, so a list of cards comes out as a row rather than a pile.',
    },
    direction: {
      type: 'string',
      enum: ['right', 'left', 'below', 'above'],
      description: 'Which side of the anchor to place on. Default: right.',
    },
  },
} as const

const updateItem = {
  type: 'object',
  description:
    'A change to one existing card or connection. Only the fields you give are changed.',
  properties: {
    id: { type: 'string', description: 'Id from the board summary.' },
    text: { type: 'string', description: "A text card's new markdown." },
    label: {
      type: 'string',
      description: "A group's or a connection's new label.",
    },
    x: { type: 'number' },
    y: { type: 'number' },
    w: { type: 'number' },
    h: { type: 'number' },
    color: { type: 'string', description: `One of ${COLORS}.` },
  },
  required: ['id'],
} as const

const connectItem = {
  type: 'object',
  description: 'An arrow from one card to another.',
  properties: {
    from: {
      type: 'string',
      description: 'Id of the card the arrow starts at.',
    },
    to: { type: 'string', description: 'Id of the card it points to.' },
    label: {
      type: 'string',
      description:
        'What the connection means. Worth giving — it is how a reader (and you, later) can tell why two cards are linked.',
    },
    color: { type: 'string', description: `One of ${COLORS}.` },
    fromSide: {
      type: 'string',
      enum: ['top', 'right', 'bottom', 'left'],
      description:
        'Which side of the source card to leave from. Omit to let the board choose.',
    },
    toSide: {
      type: 'string',
      enum: ['top', 'right', 'bottom', 'left'],
      description:
        'Which side of the target card to arrive at. Omit to let the board choose.',
    },
  },
  required: ['from', 'to'],
} as const

const groupItem = {
  type: 'object',
  description:
    'A labelled frame drawn behind the given cards. Membership is where the cards are, not a list stored anywhere: a card dragged out later stops being in the group, and a card dropped in joins it.',
  properties: {
    ids: {
      type: 'array',
      items: { type: 'string' },
      description: 'Cards the frame should enclose.',
    },
    label: { type: 'string', description: 'Name shown on the frame.' },
  },
  required: ['ids'],
} as const

const arrangeItem = {
  type: 'object',
  description: 'Moves existing cards into a tidier layout.',
  properties: {
    ids: {
      type: 'array',
      items: { type: 'string' },
      description: 'At least two cards.',
    },
    action: {
      type: 'string',
      enum: [...ARRANGE_ACTIONS],
      description:
        'tidy: close the gaps and line up the rows the cards already form. left/center/right/top/middle/bottom: line the cards up on that edge. horizontal/vertical: even out the spacing along that axis.',
    },
  },
  required: ['ids', 'action'],
} as const

export const boardToolSchemas = {
  editDescription: [
    'Edit a YOLO whiteboard: add, change, connect, group, move and delete its cards.',
    '',
    'Read the board first (fs_read on its path) — the summary gives every card an id, a position and a preview, and those ids are what this tool addresses. Read one card in full with "<board path>#<card id>".',
    '',
    'All six operation lists are applied in one step, always in this order: delete, create, update, connect, group, arrange. So one call can add three cards, connect them, frame them and line them up, and each stage can name what the one before it produced. If any operation is invalid the whole call is rejected and the board is left untouched.',
    '',
    'There is no separate way to remove a connection or a group: delete takes card ids and connection ids alike, and deleting a group removes only its frame.',
  ].join('\n'),
  edit: {
    type: 'object',
    properties: {
      path: pathProperty,
      delete: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Ids of cards and connections to remove. Deleting a card also removes the connections attached to it.',
      },
      create: { type: 'array', items: createItem },
      update: { type: 'array', items: updateItem },
      connect: { type: 'array', items: connectItem },
      group: { type: 'array', items: groupItem },
      arrange: { type: 'array', items: arrangeItem },
    },
    required: ['path'],
  } as Record<string, unknown>,

  createDescription: [
    'Create a new, empty YOLO whiteboard. Add its cards with edit_board afterwards.',
    '',
    'A whiteboard is a spatial place for thinking: cards laid out on a canvas, with arrows between them. Reach for one when the shape of an idea matters — a plan, a comparison, a map of how things relate — and for a document that reads top to bottom, write a note instead.',
  ].join('\n'),
  create: {
    type: 'object',
    properties: { path: pathProperty },
    required: ['path'],
  } as Record<string, unknown>,
} as const
