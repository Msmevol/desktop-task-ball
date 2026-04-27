import React from 'react'
import ReactDOM from 'react-dom/client'
import { Panel } from './components/Panel'
import { StoreProvider } from './store'
import './index.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <StoreProvider>
      <Panel />
    </StoreProvider>
  </React.StrictMode>
)
