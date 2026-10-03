import { createContext, useContext } from 'react'

export const ToastContext = createContext(null)
// toast(message, { kind: 'success' | 'error' | 'alert', action?: { label, onClick } })
export const useToast = () => useContext(ToastContext)
