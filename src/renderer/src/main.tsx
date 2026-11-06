import { createRoot } from 'react-dom/client'
import { App } from './App'
import './styles.css'

// Lets CSS reserve space for the macOS window buttons, which float over the page.
document.documentElement.dataset.platform = window.api.platform

// No StrictMode: its double-mounted effects would load every MCP App twice.
createRoot(document.getElementById('root')!).render(<App />)
