export const en = {
  module: {
    name: 'YOLO Whiteboard',
    open: 'Open whiteboard',
  },
  command: {
    newWhiteboard: 'New whiteboard',
  },
  menu: {
    // The folder context menu sits next to Obsidian core's own "New canvas"
    // item with no plugin prefix, so this entry names the product.
    newWhiteboard: 'New YOLO whiteboard',
  },
  file: {
    newWhiteboardBaseName: 'Whiteboard',
  },
  card: {
    missingFile: 'File missing',
    missingFileHint: 'This card refers to "{path}", which no longer exists.',
    pdfPlaceholder: 'PDF card',
    pdfPlaceholderHint: 'PDF cards are coming in a later update.',
  },
  error: {
    title: 'Could not read this whiteboard',
    hint: 'The file could not be parsed. It has not been modified — fix it outside the whiteboard and reopen.',
    createFailed: 'Could not create a new whiteboard.',
  },
}
