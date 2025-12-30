import { createContext, useCallback, useContext, useMemo } from 'react'

import { DatabaseManager } from '../database/DatabaseManager'
import { VectorManager } from '../database/modules/vector/VectorManager'

type DatabaseContextType = {
  getDatabaseManager: () => Promise<DatabaseManager>
  getVectorManager: () => Promise<VectorManager>
}

const DatabaseContext = createContext<DatabaseContextType | null>(null)

export function DatabaseProvider({
  children,
  getDatabaseManager,
}: {
  children: React.ReactNode
  getDatabaseManager: () => Promise<DatabaseManager>
}) {
  const getVectorManager = useCallback(async () => {
    return (await getDatabaseManager()).getVectorManager()
  }, [getDatabaseManager])

  const value = useMemo(() => {
    return { getDatabaseManager, getVectorManager }
  }, [getDatabaseManager, getVectorManager])

  return (
    <DatabaseContext.Provider value={value}>
      {children}
    </DatabaseContext.Provider>
  )
}

export function useDatabase(): DatabaseContextType {
  const context = useContext(DatabaseContext)
  if (!context) {
    throw new Error('useDatabase must be used within a DatabaseProvider')
  }
  return context
}
