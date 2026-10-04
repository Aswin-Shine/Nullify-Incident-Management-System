import { createContext, useContext } from 'react'

export const ToastContext = createContext(null)
// toast(message, { kind: 'success' | 'error' | 'alert', action?: { label, onClick }, ttl?: ms })
export const useToast = () => useContext(ToastContext)
