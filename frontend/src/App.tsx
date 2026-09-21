import { useEffect, useState } from 'react'
import './App.css'

type HealthStatus = 'checking' | 'online' | 'offline'

function App() {
  const [status, setStatus] = useState<HealthStatus>('checking')
  const [service, setService] = useState<string>('')

  useEffect(() => {
    fetch('/api/health')
      .then((res) => {
        if (!res.ok) throw new Error('Bad response')
        return res.json()
      })
      .then((data: { status: string; service: string }) => {
        setStatus('online')
        setService(data.service)
      })
      .catch(() => setStatus('offline'))
  }, [])

  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', padding: '2rem' }}>
      <h1>StatsTool</h1>
      <p>Quant research statistical analysis tool.</p>
      <p>
        Backend status:{' '}
        {status === 'checking' && <span>checking…</span>}
        {status === 'online' && (
          <strong style={{ color: 'green' }}>online ({service})</strong>
        )}
        {status === 'offline' && (
          <strong style={{ color: 'crimson' }}>
            offline — is the backend running?
          </strong>
        )}
      </p>
    </main>
  )
}

export default App
