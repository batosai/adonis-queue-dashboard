import { createApp } from 'vue'
import App from './App.vue'
import './style.css'

const root = document.querySelector<HTMLElement>('#queue-dashboard')
if (!root?.dataset.prefix) throw new Error('Missing dashboard mount point')
createApp(App, { prefix: root.dataset.prefix }).mount(root)
