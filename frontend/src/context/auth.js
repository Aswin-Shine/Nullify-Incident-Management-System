import { createContext, useContext } from 'react'

export const AuthContext = createContext(null)
export const useAuth = () => useContext(AuthContext)

// Viewers are read-only (they may still comment); the API enforces the same rule with a 403.
export const canWrite = (user) => user?.role === 'sre' || user?.role === 'admin'
