export const en = {
  module: {
    name: 'YOLO Whiteboard',
    open: 'Open whiteboard',
  },
  command: {
    newWhiteboard: 'New whiteboard',
    importAllCanvas: 'Import every Canvas as a YOLO whiteboard',
  },
  tools: {
    label: 'Whiteboard',
    description:
      'Create YOLO whiteboards and edit their cards, connections and groups.',
  },
  menu: {
    // The folder context menu sits next to Obsidian core's own "New canvas"
    // item with no plugin prefix, so this entry names the product.
    newWhiteboard: 'New YOLO whiteboard',
    importCanvas: 'Import as YOLO whiteboard',
    newCard: 'New card',
    convertToNote: 'Convert to note',
    deleteCard: 'Delete',
    deleteEdge: 'Delete connection',
    arrowNone: 'No arrow',
    arrowForward: 'Arrow at the end',
    arrowBackward: 'Arrow at the start',
    arrowBoth: 'Arrows at both ends',
    createGroup: 'Group selection',
    newGroupHere: 'New group',
    renameGroup: 'Rename group',
    zoomToSelection: 'Zoom to selection',
    resetCamera: 'Back to origin',
    alignLeft: 'Align left',
    alignCenter: 'Align horizontal centres',
    alignRight: 'Align right',
    alignTop: 'Align top',
    alignMiddle: 'Align vertical centres',
    alignBottom: 'Align bottom',
    distributeHorizontal: 'Distribute horizontally',
    distributeVertical: 'Distribute vertically',
    tidy: 'Tidy up',
  },
  // The creation bar along the bottom of the canvas (P3 batch 3, surface 3).
  cardMenu: {
    newCard: 'Add card',
    addNote: 'Add note',
    addMedia: 'Add media file',
    newWebCard: 'Add web page',
  },
  prompt: {
    addNoteTitle: 'Add a note to this whiteboard',
    addMediaTitle: 'Add a media file to this whiteboard',
    newWebCardTitle: 'Add a web page to this whiteboard',
    searchPlaceholder: 'Type to search…',
    urlPlaceholder: 'https://example.com',
    webDropHint: 'or drop an HTML file here',
    noMatches: 'No matching file.',
    noMedia: 'This vault has no images, audio or video.',
  },
  // Floating toolbar over the current selection (P3 batch 3).
  toolbar: {
    color: 'Set colour',
    edit: 'Edit',
    tidy: 'Tidy up',
    arrows: 'Arrows',
    edgeLabel: 'Label',
  },
  // The six preset names are Obsidian's own canvas palette.
  color: {
    default: 'No colour',
    preset1: 'Red',
    preset2: 'Orange',
    preset3: 'Yellow',
    preset4: 'Green',
    preset5: 'Cyan',
    preset6: 'Purple',
    custom: 'Custom colour',
  },
  edge: {
    labelPlaceholder: 'Label this connection',
  },
  file: {
    newWhiteboardBaseName: 'Whiteboard',
    newNoteBaseName: 'Untitled',
    newHtmlBaseName: 'Web page',
  },
  confirm: {
    importAllTitle: 'Import Canvas files',
    importAllMessage:
      'Create a YOLO whiteboard beside each of the {count} Canvas file(s) in this vault. The Canvas files themselves are left untouched.',
    importAllCta: 'Import',
  },
  notice: {
    convertedToNote: 'Card saved as {path}',
    dropUnsupported:
      'Only notes, images, audio, video and HTML files can be dropped onto a whiteboard.',
    imported: 'Imported as {path}',
    importedAll:
      'Imported {imported} Canvas file(s); {failed} could not be read.',
    importNoneFound: 'No Canvas files found in this vault.',
    invalidUrl: 'Only http and https addresses can be added.',
  },
  card: {
    missingFile: 'File missing',
    missingFileHint: 'This card refers to "{path}", which no longer exists.',
    unsupportedFile: 'Not shown yet',
    unsupportedFileHint: '"{path}" has no card of its own yet.',
    linkNotWeb: 'Not a web address',
    linkNotWebHint:
      'Only http and https pages can be shown. This card points at "{url}".',
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
