// Installs IDBKeyRange (used by compound-key ranges) as a global.
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'

import { deleteVectorDatabase, openVectorDatabase } from './vectorDatabase'

describe('deleteVectorDatabase', () => {
  it('resolves when the database does not exist', async () => {
    const indexedDB = new IDBFactory()
    await expect(
      deleteVectorDatabase(indexedDB, 'yolo-vector:ns:kb-missing'),
    ).resolves.toBeUndefined()
  })

  it('resolves once every connection to the database has been closed first', async () => {
    const indexedDB = new IDBFactory()
    const db = await openVectorDatabase(indexedDB, 'yolo-vector:ns:kb-a')
    db.close()

    await expect(
      deleteVectorDatabase(indexedDB, 'yolo-vector:ns:kb-a'),
    ).resolves.toBeUndefined()
  })

  it('rejects — not resolves — when an open connection blocks the delete', async () => {
    // The caller is expected to close its own connection first
    // (`DatabaseManager.deleteKnowledgeBase` does); an `onblocked` firing
    // anyway means the data was NOT deleted, so this must surface as a
    // rejection rather than silently resolving as if it had succeeded.
    const indexedDB = new IDBFactory()
    const db = await openVectorDatabase(indexedDB, 'yolo-vector:ns:kb-a')

    await expect(
      deleteVectorDatabase(indexedDB, 'yolo-vector:ns:kb-a'),
    ).rejects.toThrow(/blocked/i)

    db.close()
  })
})
