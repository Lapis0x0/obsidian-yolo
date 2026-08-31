export const en = {
  module: {
    name: 'YOLO Whiteboard',
    open: 'Open whiteboard',
  },
  command: {
    newWhiteboard: 'New whiteboard',
    importAllCanvas: 'Import every Canvas as a YOLO whiteboard',
  },
  menu: {
    // The folder context menu sits next to Obsidian core's own "New canvas"
    // item with no plugin prefix, so this entry names the product.
    newWhiteboard: 'New YOLO whiteboard',
    importCanvas: 'Import as YOLO whiteboard',
    newCard: 'New card',
    convertToNote: 'Convert to note',
    deleteCard: 'Delete',
  },
  file: {
    newWhiteboardBaseName: 'Whiteboard',
    newNoteBaseName: 'Untitled',
  },
  confirm: {
    importAllTitle: 'Import Canvas files',
    importAllMessage:
      'Create a YOLO whiteboard beside each of the {count} Canvas file(s) in this vault. The Canvas files themselves are left untouched.',
    importAllCta: 'Import',
  },
  notice: {
    convertedToNote: 'Card saved as {path}',
    dropUnsupported: 'Only markdown notes can be dropped onto a whiteboard.',
    imported: 'Imported as {path}',
    importedAll:
      'Imported {imported} Canvas file(s); {failed} could not be read.',
    importNoneFound: 'No Canvas files found in this vault.',
  },
  card: {
    missingFile: 'File missing',
    missingFileHint: 'This card refers to "{path}", which no longer exists.',
    unsupportedFile: 'Not shown yet',
    unsupportedFileHint: '"{path}" has no card of its own yet.',
  },
  error: {
    title: 'Could not read this whiteboard',
    hint: 'The file could not be parsed. It has not been modified — fix it outside the whiteboard and reopen.',
    createFailed: 'Could not create a new whiteboard.',
    convertFailed: 'Could not convert this card into a note.',
    dropFailed: 'Could not add the dropped file to this whiteboard.',
    importFailed: 'Could not import this Canvas file.',
  },
}
