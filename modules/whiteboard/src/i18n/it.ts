export const it = {
  module: {
    name: 'Lavagna YOLO',
    open: 'Apri lavagna',
  },
  command: {
    newWhiteboard: 'Nuova lavagna',
    importAllCanvas: 'Importa tutti i Canvas come lavagne YOLO',
  },
  menu: {
    newWhiteboard: 'Nuova lavagna YOLO',
    importCanvas: 'Importa come lavagna YOLO',
    newCard: 'Nuova scheda',
    convertToNote: 'Converti in nota',
    deleteCard: 'Elimina',
    deleteEdge: 'Elimina collegamento',
    arrowNone: 'Nessuna freccia',
    arrowForward: 'Freccia alla fine',
    arrowBackward: "Freccia all'inizio",
    arrowBoth: 'Frecce a entrambe le estremità',
  },
  toolbar: {
    color: 'Imposta colore',
    edit: 'Modifica',
    more: 'Altre opzioni',
    arrows: 'Frecce',
    edgeLabel: 'Etichetta',
  },
  color: {
    default: 'Nessun colore',
    preset1: 'Rosso',
    preset2: 'Arancione',
    preset3: 'Giallo',
    preset4: 'Verde',
    preset5: 'Ciano',
    preset6: 'Viola',
    custom: 'Colore personalizzato',
  },
  edge: {
    labelPlaceholder: 'Etichetta questo collegamento',
  },
  file: {
    newWhiteboardBaseName: 'Lavagna',
    newNoteBaseName: 'Senza titolo',
  },
  confirm: {
    importAllTitle: 'Importa i file Canvas',
    importAllMessage:
      'Verrà creata una lavagna YOLO accanto a ciascuno dei {count} file Canvas presenti in questo vault. I file Canvas originali non vengono modificati.',
    importAllCta: 'Importa',
  },
  notice: {
    convertedToNote: 'Scheda salvata come {path}',
    dropUnsupported:
      'Su una lavagna si possono trascinare solo note, immagini, audio e video.',
    imported: 'Importato come {path}',
    importedAll:
      'Importati {imported} file Canvas; {failed} non sono stati letti.',
    importNoneFound: 'Nessun file Canvas trovato in questo vault.',
  },
  card: {
    missingFile: 'File mancante',
    missingFileHint:
      'Questa scheda fa riferimento a "{path}", che non esiste più.',
    unsupportedFile: 'Non ancora visualizzabile',
    unsupportedFileHint: '"{path}" non ha ancora una scheda dedicata.',
    linkNotWeb: 'Non è un indirizzo web',
    linkNotWebHint:
      'Si possono mostrare solo pagine http e https. Questa scheda punta a "{url}".',
  },
  error: {
    title: 'Impossibile leggere questa lavagna',
    hint: 'Il file non è stato interpretato correttamente. Non è stato modificato: correggilo fuori dalla lavagna e riaprilo.',
    createFailed: 'Impossibile creare una nuova lavagna.',
    convertFailed: 'Impossibile convertire questa scheda in una nota.',
    dropFailed: 'Impossibile aggiungere alla lavagna il file trascinato.',
    importFailed: 'Impossibile importare questo file Canvas.',
  },
}
