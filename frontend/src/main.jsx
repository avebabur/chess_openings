import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles/tokens.css'
import OpeningsApp from './OpeningsApp.jsx'
import { preloadSounds } from './sounds'

preloadSounds()

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <OpeningsApp />
  </StrictMode>,
)
