import { createContext, useContext } from 'react'

export const UIContext = createContext(null)

export function useUI() {
  const ctx = useContext(UIContext)
  if (!ctx) throw new Error('useUI must be used inside UIContext.Provider')
  return ctx
}
