import { createRoot } from 'react-dom/client'
import 'katex/dist/katex.min.css'
import './style.css'
import App from './App'

// 注意：不使用 React.StrictMode（会导致 Canvas 副作用执行两次）
createRoot(document.getElementById('root')!).render(<App />)
